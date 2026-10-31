import {
  CLIENT_INFO_META_KEY, McpServer, ProtocolError, ProtocolErrorCode,
  type CallToolResult, type McpServerFactory, type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { bibtexEntries, risEntries } from './citations.js';
import type { ContentClient, ContentLink } from './content.js';
import {
  BuildDeadlineError, GraphError, GraphUnavailableError, OpenAlexBudgetExhausted, OpenAlexError, QueryTimeoutError, TitleFilterError,
  ToolDeadlineError,
} from './errors.js';
import type { ConnectorPaper, GraphClient, SimilarPaper } from './graph.js';
import {
  GRACE_MS, MAX_ANALYSIS_LIMIT, MAX_ID_CHARS, MAX_PAPER_IDS, MAX_QUERY_CHARS, MAX_READ_CHARS, MAX_SEARCH_LIMIT, MAX_SEEDS, MAX_SQL_CHARS, MAX_SQL_LIMIT,
  METADATA_WAIT_MS, OUTPUT_CAP_BYTES, TOOL_CEILING_MS, URL_SEED_CAP,
} from './limits.js';
import { countOpenAlexRequests, type OpenAlexClient, type Work } from './openalex.js';
import { capResult } from './output.js';
import { ALWAYS_ADVISORY, buildProvenance, type ProvenanceInput } from './provenance.js';
import { analysisSql, methodFor, type Analysis } from './templates.js';
import { buildTitleMatch, MAX_TERMS } from './titlefilter.js';
import type { BuildCapLike, GraphMeta, SeedResolution } from './types.js';
import { createUrls, type CappedUrl, type Urls } from './urls.js';

export type ToolOutcome = 'ok' | 'tool_error' | 'upstream_unavailable' | 'timeout';

/** One per tool call that reaches a handler; Task 6 turns it into a usage row. Carries no request data. */
export type ToolSettled = {
  tool: string;
  outcome: ToolOutcome;
  clientInfo: { name: string; version: string | null } | null;
  graphPapers: number | null;
  graphDepth: number | null;
  openalexCalls: number;
};

export type ToolDeps = {
  graph: GraphClient;
  openalex: OpenAlexClient;
  content: ContentClient;
  buildCap: BuildCapLike;
  version: string;
  publicBaseUrl: URL;
  now: () => Date;
  onToolSettled?: (e: ToolSettled) => void;
};

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true } as const;

// ---------------------------------------------------------------------------------------------
// Errors

/** A failure whose message is written here and safe to show. */
class ToolFailure extends Error {
  constructor(message: string, readonly outcome: ToolOutcome = 'tool_error') { super(message); }
}

const retryIn = (secs: number | null) => (secs === null ? 'retry shortly' : `retry in about ${secs} seconds`);

/**
 * Maps any thrown value to a message for the client and an outcome. Messages are fixed strings or our
 * own text (`ToolFailure`, which for `query_citation_graph` may carry graph-api's error about the
 * caller's own SQL). Nothing here carries a URL or a key, and nothing is logged.
 */
function describeError(err: unknown): { message: string; outcome: ToolOutcome } {
  if (err instanceof ToolFailure) return { message: err.message, outcome: err.outcome };
  if (err instanceof TitleFilterError) return { message: err.message, outcome: 'tool_error' };
  if (err instanceof QueryTimeoutError) {
    return { message: "The query hit graph-api's time limit; simplify it or add a LIMIT/WHERE.", outcome: 'timeout' };
  }
  if (err instanceof BuildDeadlineError) return { message: 'The graph is still building; retry in about a minute.', outcome: 'timeout' };
  if (err instanceof GraphUnavailableError) {
    return { message: `The citation graph service is temporarily unavailable; ${retryIn(err.retryAfterSecs)}.`, outcome: 'upstream_unavailable' };
  }
  if (err instanceof OpenAlexBudgetExhausted) {
    return { message: `The OpenAlex request budget is used up for now; ${retryIn(err.retryAfterSecs)}.`, outcome: 'upstream_unavailable' };
  }
  if (err instanceof GraphError) return { message: err.message, outcome: 'upstream_unavailable' };
  if (err instanceof OpenAlexError) return { message: 'OpenAlex returned an error; retry shortly.', outcome: 'upstream_unavailable' };
  return { message: 'The tool failed unexpectedly.', outcome: 'tool_error' };
}

// ---------------------------------------------------------------------------------------------
// Row projections

const bareDoi = (doi: string | null | undefined) => (doi ? doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') : null);
const venueOf = (w: Work) => w.primary_location?.source?.display_name ?? null;
const AUTHORS_IN_ROWS = 3;

/** Author names from graph-api's `authors` JSON text (or its `author` list), the first three. */
function authorNames(value: unknown): string[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try { list = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.map(a => (a && typeof a === 'object' ? (a as { name?: unknown }).name : null))
    .filter((n): n is string => typeof n === 'string' && n !== '').slice(0, AUTHORS_IN_ROWS);
}

const openalexRowSchema = z.object({
  openalex_id: z.string(), doi: z.string().nullable(), title: z.string().nullable(), year: z.number().nullable(),
  venue: z.string().nullable(), cited_by_count: z.number().nullable(), type: z.string().nullable(),
  is_retracted: z.boolean().nullable(), has_abstract: z.boolean(), inciteful_url: z.string(),
});

const graphPaperSchema = z.object({
  paper_id: z.string(), doi: z.string().nullable(), title: z.string().nullable(), published_year: z.number().nullable(),
  journal: z.string().nullable(), authors: z.array(z.string()), num_cited_by: z.number().nullable(), num_citing: z.number().nullable(),
  inciteful_url: z.string(),
});

const fullPaperSchema = z.object({
  openalex_id: z.string(), doi: z.string().nullable(), title: z.string().nullable(), year: z.number().nullable(),
  venue: z.string().nullable(), type: z.string().nullable(), version: z.string().nullable(), is_retracted: z.boolean().nullable(),
  cited_by_count: z.number().nullable(), abstract: z.string().nullable(), authors: z.array(z.string()), author_count: z.number(),
  pmid: z.string().nullable(), pmcid: z.string().nullable(),
  best_oa: z.object({ url: z.string().nullable(), license: z.string().nullable(), version: z.string().nullable(), source: z.string().nullable() }).nullable(),
  inciteful_url: z.string(),
});
const AUTHORS_IN_RECORDS = 20;

const linkSchema = z.object({
  url: z.string(), format: z.enum(['pdf', 'landing_page']), source: z.string(),
  is_oa: z.boolean().nullable(), license: z.string().nullable(), version: z.string().nullable(),
});

// ---------------------------------------------------------------------------------------------
// Output schemas. Every one has a top-level `rows` (capResult trims it), `truncated`, and an optional
// `diagnostics`, because capResult adds one to results that have none.

const diagnosticsSchema = z.object({
  advisories: z.array(z.string()),
  unresolved_seeds: z.array(z.object({ input: z.string(), reason: z.string() })).optional(),
}).optional();

const provenanceSchema = z.object({
  retrieved_at: z.string(), tool: z.string(), server_version: z.string(), data_source: z.string(),
  graph_snapshot: z.string().nullable(), recent_tier: z.string().nullable(), coverage_note: z.string(),
  seeds: z.array(z.object({ input: z.string(), openalex_id: z.string() })),
  graph: z.object({
    papers: z.number().nullable(), citations: z.number().nullable(), depth: z.number().nullable(),
    prune_threshold: z.number().nullable(), highly_cited_not_expanded: z.number().nullable(),
    seeds_not_expanded: z.number().nullable(), note: z.string().optional(),
  }),
  method: z.string(), filters: z.record(z.string(), z.unknown()),
  sql_executed: z.string().nullable(), effective_limit: z.number().nullable(),
  papers_searched: z.number().optional(), hops: z.array(z.number()).optional(), total: z.number().nullable().optional(),
});

const common = { truncated: z.boolean(), diagnostics: diagnosticsSchema };
const graphCommon = { ...common, provenance: provenanceSchema, inciteful_url: z.string().nullable() };
const unresolvedSchema = z.array(z.object({ input: z.string(), reason: z.enum(['not_found', 'unavailable']) }));

const outputs = {
  search_literature: z.object({ rows: z.array(openalexRowSchema), next_cursor: z.string().nullable(), ...common }),
  get_papers: z.object({ rows: z.array(fullPaperSchema), unresolved: unresolvedSchema, ...common }),
  find_similar_papers: z.object({ rows: z.array(graphPaperSchema.extend({ score: z.number() })), ...graphCommon }),
  explore_citation_network: z.object({ analysis: z.string(), rows: z.array(z.record(z.string(), z.unknown())), ...graphCommon }),
  connect_papers: z.object({
    rows: z.array(graphPaperSchema), paths: z.array(z.array(z.string())),
    edges: z.array(z.object({ citing: z.string(), cited: z.string() })), ...graphCommon,
  }),
  query_citation_graph: z.object({ rows: z.array(z.record(z.string(), z.unknown())), ...graphCommon }),
  read_paper: z.object({
    openalex_id: z.string(), doi: z.string().nullable(), title: z.string().nullable(), pmcid: z.string().nullable(),
    text: z.string().nullable(), offset: z.number(), next_offset: z.number().nullable(), sha256: z.string().nullable(),
    license: z.string().nullable(), rows: z.array(linkSchema), inciteful_url: z.string(), ...common,
  }),
  export_citations: z.object({
    format: z.enum(['bibtex', 'ris']), rows: z.array(z.object({ openalex_id: z.string(), doi: z.string().nullable(), entry: z.string() })),
    unresolved: unresolvedSchema, ...common,
  }),
};
type ToolName = keyof typeof outputs;

// ---------------------------------------------------------------------------------------------
// Inputs

const idString = z.string().trim().min(1).max(MAX_ID_CHARS);
const idList = z.array(idString).min(1).max(MAX_PAPER_IDS);
const seeds = z.array(idString).min(1).max(MAX_SEEDS)
  .describe(`1–${MAX_SEEDS} seed papers: DOIs, OpenAlex IDs (W…) or PMIDs. Duplicates count once.`);
const year = z.number().int();
const titleTerms = z.array(z.string()).max(MAX_TERMS).optional();
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);

// ---------------------------------------------------------------------------------------------
// Descriptions

const TITLE_FILTER = 'They match titles only (not abstracts or full text), with Porter stemming.';

/** The worked examples in `query_citation_graph`'s description. Tests run them on the real graph schema. */
export const QUERY_EXAMPLES = [
  "SELECT paper_id, title, published_year, page_rank FROM papers WHERE distance > 0 AND published_year >= 2020 AND paper_id IN (SELECT paper_id FROM title_search('search_text: stimulation')) ORDER BY page_rank DESC LIMIT 20",
  'SELECT author_id, name, COUNT(*) AS papers, SUM(partial_page_rank) AS influence FROM authors GROUP BY author_id, name ORDER BY influence DESC LIMIT 20',
  'SELECT published_year, COUNT(*) AS papers, SUM(num_cited_by) AS in_graph_citations FROM papers WHERE distance = 2 GROUP BY published_year ORDER BY published_year DESC LIMIT 30',
] as const;

const DESCRIPTIONS: Record<ToolName, string> = {
  search_literature: [
    'Search OpenAlex (CC0 metadata) for papers by keywords, ranked by relevance.',
    'Use it to find candidate seed papers when you have a topic but no DOIs yet, then pass their IDs to find_similar_papers or explore_citation_network.',
    'Returns OpenAlex ID, DOI, title, year, venue, global cited_by_count, type, is_retracted and has_abstract; page with next_cursor.',
    `limit is at most ${MAX_SEARCH_LIMIT}. For abstracts and authors use get_papers.`,
  ].join(' '),
  get_papers: [
    `Fetch OpenAlex records for up to ${MAX_PAPER_IDS} papers by DOI, OpenAlex ID (W…), PMID or PMCID:`,
    'abstract, authors, venue, type and version, is_retracted, PMID/PMCID and the best open-access link with its licence.',
    'Use it to read abstracts and check retraction and preprint status before citing. It does not use the citation graph.',
    'Inputs it cannot match come back in unresolved with a reason.',
  ].join(' '),
  find_similar_papers: [
    'The default first step for finding related literature.',
    `Give 1–${MAX_SEEDS} seed papers (DOIs, OpenAlex IDs or PMIDs); returns the papers most similar to them by citation links, sorted by score.`,
    'Method: fast similarity, Adamic/Adar plus Salton co-citation on a depth-1 citation graph; with several seeds, Adamic/Adar against a synthetic paper that cites all the seeds.',
    'Seeds are left out of the results, and scores rank within one result set.',
    'It is quicker than explore_citation_network, which builds a depth-2 graph for rankings such as important, reviews and recent.',
    `limit is at most ${MAX_ANALYSIS_LIMIT}. Unresolved seeds are listed in diagnostics.`,
  ].join(' '),
  explore_citation_network: [
    `Rank papers, authors, journals or institutions in the depth-2 citation graph Inciteful builds around 1–${MAX_SEEDS} seed papers.`,
    'analysis: similar (shared references and co-citation with the seeds), important (local PageRank), reviews (papers citing many others in the graph),',
    'recent (PageRank among papers from the last 3 years), authors, journals, institutions;',
    "or references / citations: the seeds' reference lists or citing papers from OpenAlex, sorted by global cited_by_count, with the total count.",
    'A graph that is not cached yet can take a minute to build; use find_similar_papers for a quick look.',
    `title_all / title_any / title_none filter by words in paper titles. ${TITLE_FILTER}`,
    'year_from / year_to filter by publication year. Title and year filters apply to the graph analyses, not to references or citations.',
    `limit is at most ${MAX_ANALYSIS_LIMIT}. Results carry provenance (method, graph size and depth, the SQL run) and diagnostics.`,
  ].join(' '),
  connect_papers: [
    'Find citation paths between two papers (DOI, OpenAlex ID or PMID), treating each citation as a link in either direction.',
    'Returns the paths, the citation edges (citing → cited), the papers on the paths, and each path\'s hop count in provenance.hops.',
    'extended: true also returns longer paths, aiming for at least 5. Use it to see how two lines of work relate;',
    "for a paper's wider neighbourhood use find_similar_papers.",
  ].join(' '),
  query_citation_graph: [
    `Run your own read-only SQLite query on the citation graph Inciteful builds around 1–${MAX_SEEDS} seed papers (depth 2, the same graph as explore_citation_network).`,
    'Use it when the fixed analyses in explore_citation_network do not answer the question.',
    `Rules: a single SELECT statement. graph-api applies limit (at most ${MAX_SQL_LIMIT}) in place of any LIMIT in the SQL.`,
    'OFFSET (and LIMIT a, b) is rejected before sending; page with a narrower WHERE or an ORDER BY instead.',
    '\n\nSchema:',
    '\n- papers(paper_id TEXT: OpenAlex ID such as W2919115771; doi TEXT without the https://doi.org/ prefix; authors TEXT: JSON array of {author_id, name, sequence, position, institution {id, name, ror}};',
    'num_authors INTEGER; title TEXT; published_year INTEGER; journal TEXT; num_citing INTEGER; num_cited_by INTEGER; distance INTEGER; page_rank REAL; adamic_adar REAL; cocite REAL)',
    '\n- authors(author_id TEXT: OpenAlex author ID without the A prefix; paper_id TEXT; name TEXT; sequence INTEGER, from 0; affiliation TEXT;',
    'affiliation_id TEXT: OpenAlex institution ID without the I prefix; ror TEXT: ROR URL; published_year INTEGER; partial_page_rank REAL: the author\'s share of the paper\'s page_rank)',
    '\n- metadata(name TEXT, value TEXT): one row each for graph_depth, graph_snapshot, prune_threshold, highly_cited_not_expanded, seeds_not_expanded, paper_count, citation_count.',
    'value is TEXT; use CAST(value AS INTEGER) to compare numbers.',
    '\n- title_search(paper_id, search_text): an FTS5 index of the titles with Porter stemming; search_text holds the titles (paper IDs are indexed too).',
    "Query it as a table function, starting the match text with the column filter: SELECT paper_id FROM title_search('search_text: vagus AND nerve'). AND, OR, NOT and parentheses work; bm25(title_search) ranks matches, smaller is better.",
    '\n- title_terms(term, doc_count): the stemmed title terms and the number of papers each appears in, leaving out a few common words.',
    '\n- ror.organizations(ror_id, ror_url, display_name, status, established, types, country_code, country_name, city, latitude, longitude),',
    'ror.names(ror_id, name, name_types, language), ror.external_ids(ror_id, id_type, preferred_id, external_id), ror.relationships(ror_id, related_ror_id, related_name, relationship_type):',
    'the Research Organization Registry (active organizations), attached as ror. Join it with authors.ror = ror.organizations.ror_url.',
    '\n\nWhat the schema cannot tell you:',
    '\n- There is no edge table, so SQL cannot tell which papers cite which, or separate citing papers from cited ones.',
    "For a seed's references or citing papers use explore_citation_network with analysis 'references' or 'citations'.",
    '\n- num_citing and num_cited_by are in-graph counts (citations between papers in this graph), not global citation counts; get_papers has the global cited_by_count.',
    '\n- Papers with no citation inside the graph have NULL num_citing, num_cited_by, distance, page_rank, adamic_adar and cocite.',
    '\n- Seed distance: with one seed, the seed is at distance 0, the papers it cites or is cited by at 1 and their neighbours at 2, so distance > 0 leaves the seed out.',
    'With several seeds the graph hangs off a synthetic paper W0 ("Temp Paper", year 1900) that cites every seed: W0 is at distance 0, the seeds at 1 and their neighbours at 2,',
    "so distance > 1 leaves out W0 and the seeds; otherwise add paper_id <> 'W0'.",
    '\n- With several seeds, cocite is NULL in every row (nothing cites W0) and adamic_adar is measured against W0.',
    '\n\nExamples:',
    `\n1. One seed: the highest-PageRank papers since 2020 with "stimulation" in the title: ${QUERY_EXAMPLES[0]}`,
    `\n2. Authors ranked by their share of PageRank: ${QUERY_EXAMPLES[1]}`,
    `\n3. Several seeds: papers per year among the seeds' direct neighbours: ${QUERY_EXAMPLES[2]}`,
  ].join(' '),
  read_paper: [
    'Read the full text of an open-access paper from PubMed Central (PMC BioC) in chunks: pass offset (0 to start) and max_chars',
    `(up to ${MAX_READ_CHARS}), then continue from next_offset until it is null.`,
    'Returns the article\'s licence and a sha256 of the whole text. When PMC has no text for the paper, returns candidate open-access links',
    '(publisher or repository) in rows instead. Accepts a DOI, OpenAlex ID, PMID or PMCID. Use get_papers for the abstract.',
  ].join(' '),
  export_citations: [
    `Build BibTeX or RIS citations for up to ${MAX_PAPER_IDS} papers (DOI, OpenAlex ID, PMID or PMCID) from their OpenAlex records,`,
    'with entry types, years, volume, issue, pages and escaping. Each row holds one entry; join the entries with a blank line to make a .bib or .ris file.',
    'Inputs it cannot match are listed in unresolved.',
  ].join(' '),
};

const TITLES: Record<ToolName, string> = {
  search_literature: 'Search the literature',
  get_papers: 'Get paper details',
  find_similar_papers: 'Find similar papers',
  explore_citation_network: 'Explore a citation network',
  connect_papers: 'Connect two papers',
  query_citation_graph: 'Query a citation graph with SQL',
  read_paper: 'Read a paper',
  export_citations: 'Export citations',
};

// ---------------------------------------------------------------------------------------------
// Prompt

const REVIEW_STEPS = [
  '1. resolve the seeds;',
  '2. run `find_similar_papers`;',
  '3. propose 3–5 seeds and wait for the user to confirm them (a checkpoint);',
  '4. run `explore_citation_network` for `important`, `reviews` and `recent`, plus `references` and `citations` on the confirmed seeds;',
  "5. fetch the finalists' abstracts with `get_papers`;",
  '6. only then write: cite every paper by DOI and append the provenance.',
];

function reviewPrompt(topic: string | undefined, seedText: string | undefined): string {
  const t = topic?.trim() ?? '';
  const list = (seedText ?? '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (!t && !list.length) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'literature_review needs a topic or seeds.');
  return [
    'Help me with a literature review, using the Inciteful tools.',
    t ? `Topic: ${t}` : null,
    list.length ? `Seed papers: ${list.join(', ')}` : null,
    '',
    'Work through these steps in order:',
    ...REVIEW_STEPS,
    '',
    list.length
      ? 'The graph tools resolve DOIs, OpenAlex IDs and PMIDs themselves and report any seed they could not use.'
      : 'To resolve the seeds from the topic, use `search_literature` and pick well-cited papers that are squarely on the topic.',
    'At step 3, stop and wait for my reply before going on to step 4.',
  ].filter((line): line is string => line !== null).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Factory

/**
 * Per tool call. `signal` aborts at the ceiling plus `GRACE_MS`; it goes to non-build calls only
 * (resolve, OpenAlex, PMC), never to a graph build, which must be left to finish upstream.
 */
type Call = { deadlineAt: number; signal: AbortSignal; graphPapers: number | null; graphDepth: number | null };
type Resolved = { seeds: SeedResolution[]; ids: string[]; inputOrder: string[]; duplicates: string[]; meta: GraphMeta };

function clientInfoOf(ctx: ServerContext, server: McpServer): ToolSettled['clientInfo'] {
  // RequestMetaEnvelope is typed {} in SDK 2.4, so the key is read through a cast.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const raw = (envelope?.[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion()) as { name?: unknown; version?: unknown } | undefined;
  if (!raw || typeof raw.name !== 'string' || !raw.name) return null;
  return { name: raw.name, version: typeof raw.version === 'string' ? raw.version : null };
}

const num = (v: string | undefined) => (v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

export function createServerFactory(deps: ToolDeps): McpServerFactory {
  const urls: Urls = createUrls(deps.publicBaseUrl);
  const { graph, openalex, content, buildCap } = deps;

  const openalexRow = (w: Work) => ({
    openalex_id: w.id, doi: bareDoi(w.doi), title: w.title, year: w.publication_year, venue: venueOf(w),
    cited_by_count: w.cited_by_count, type: w.type, is_retracted: w.is_retracted, has_abstract: w.abstract !== null,
    inciteful_url: urls.paperUrl(w.id),
  });

  const graphPaperRow = (p: SimilarPaper | ConnectorPaper) => ({
    paper_id: p.id, doi: p.doi ?? null, title: p.title ?? null, published_year: p.published_year ?? null, journal: p.journal ?? null,
    authors: authorNames(p.author), num_cited_by: p.num_cited_by ?? null, num_citing: p.num_citing ?? null, inciteful_url: urls.paperUrl(p.id),
  });

  /** Template rows: paper rows get author names and a link; aggregate rows pass through. */
  const templateRow = (row: Record<string, unknown>) => {
    if (typeof row.paper_id !== 'string') return row;
    return { ...row, authors: authorNames(row.authors), inciteful_url: urls.paperUrl(row.paper_id) };
  };

  /** Seed handling for every graph tool: resolve, deduplicate (keeping the first input per paper). */
  async function resolveSeeds(inputs: string[], call: Call): Promise<Resolved> {
    const { results, snapshot, recentTier } = await graph.resolve(inputs, { signal: call.signal });
    const seen = new Set<string>();
    const seedsOut: SeedResolution[] = [];
    const duplicates: string[] = [];
    for (const r of results) {
      if (r.id === null) seedsOut.push(r);
      else if (seen.has(r.id)) duplicates.push(r.input);
      else { seen.add(r.id); seedsOut.push(r); }
    }
    const inputOrder = [...seen];
    return { seeds: seedsOut, ids: [...inputOrder].sort(), inputOrder, duplicates, meta: { snapshot, recentTier } };
  }

  function provenanceFor(tool: ToolName, r: Resolved, meta: GraphMeta, rest: Omit<ProvenanceInput, 'now' | 'tool' | 'serverVersion' | 'meta' | 'seeds'>, link: CappedUrl | null) {
    const { provenance, diagnostics } = buildProvenance({ now: deps.now(), tool, serverVersion: deps.version, meta, seeds: r.seeds, ...rest });
    const extra: string[] = [];
    if (r.duplicates.length) {
      const n = r.duplicates.length;
      extra.push(`${n} ${n === 1 ? 'seed' : 'seeds'} resolved to a paper already in the list and ${n === 1 ? 'was' : 'were'} counted once: ${r.duplicates.map(d => `"${d}"`).join(', ')}.`);
    }
    if (link?.capped) {
      extra.push(`The inciteful_url link carries the first ${URL_SEED_CAP} of ${r.inputOrder.length} seeds, to fit URL limits.`);
    }
    // Before the always-on advisory, which stays last.
    diagnostics.advisories.splice(diagnostics.advisories.indexOf(ALWAYS_ADVISORY), 0, ...extra);
    return { provenance, diagnostics, inciteful_url: link?.url ?? null };
  }

  const capKey = (...parts: unknown[]) => JSON.stringify(parts);

  /**
   * The graph's metadata table, or nothing: a failure here costs the stats, never the rows. The graph
   * is built by then, so it waits `METADATA_WAIT_MS` at most.
   */
  async function graphMetadata(ids: string[], call: Call): Promise<Record<string, string> | undefined> {
    try {
      const deadlineAt = Math.min(call.deadlineAt, deps.now().getTime() + METADATA_WAIT_MS);
      const gm = await buildCap.run(capKey('metadata', ids), () => graph.metadata(ids), deadlineAt);
      call.graphPapers = num(gm.paper_count);
      call.graphDepth = num(gm.graph_depth);
      return gm;
    } catch {
      return undefined;
    }
  }

  return () => {
    const server = new McpServer({ name: 'inciteful-academic', version: deps.version });

    function register<S extends z.ZodObject>(
      name: ToolName, inputSchema: S,
      handler: (args: z.output<S>, call: Call) => Promise<{ rows: unknown[] } & Record<string, unknown>>,
    ) {
      const executor = async (args: z.output<S>, ctx: ServerContext): Promise<CallToolResult> => {
        const deadlineAt = deps.now().getTime() + TOOL_CEILING_MS;
        const ac = new AbortController();
        const call: Call = { deadlineAt, signal: ac.signal, graphPapers: null, graphDepth: null };
        const counter = { calls: 0 };
        // The ceiling for the whole call. A build reaching the deadline reports "still building" through
        // the build cap first; the grace keeps this timer from racing it.
        const timer = setTimeout(() => ac.abort(new ToolDeadlineError()), Math.max(0, deadlineAt - deps.now().getTime()) + GRACE_MS);
        let result: CallToolResult;
        let outcome: ToolOutcome;
        try {
          const work = countOpenAlexRequests(counter, () => handler(args, call));
          // The handler may still reject after the ceiling has answered the client.
          work.catch(() => {});
          const aborted = new Promise<never>((_, reject) => {
            ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true });
          });
          const value = capResult(await Promise.race([work, aborted]));
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
          outcome = 'ok';
        } catch (err) {
          const { message, outcome: o } = !(err instanceof BuildDeadlineError) && ac.signal.aborted
            ? { message: 'The request took too long upstream; retry in about a minute.', outcome: 'timeout' as const }
            : describeError(err);
          result = { content: [{ type: 'text', text: message }], isError: true };
          outcome = o;
        } finally {
          clearTimeout(timer);
        }
        try {
          deps.onToolSettled?.({
            tool: name, outcome, clientInfo: clientInfoOf(ctx, server),
            graphPapers: call.graphPapers, graphDepth: call.graphDepth, openalexCalls: counter.calls,
          });
        } catch {
          // The usage sink must never change a tool result.
        }
        return result;
      };
      server.registerTool(name, {
        title: TITLES[name], description: DESCRIPTIONS[name], inputSchema, outputSchema: outputs[name], annotations: ANNOTATIONS,
      }, executor as never);
    }

    const checkYears = (from?: number, to?: number) => {
      if (from !== undefined && to !== undefined && from > to) throw new ToolFailure('year_from must not be later than year_to.');
    };

    register('search_literature', z.object({
      query: z.string().trim().min(1).max(MAX_QUERY_CHARS).describe('Keywords, a title or a phrase.'),
      limit: limit(MAX_SEARCH_LIMIT, 10),
      cursor: z.string().min(1).optional().describe('next_cursor from the previous page.'),
      year_from: year.optional(), year_to: year.optional(),
      open_access: z.boolean().optional().describe('true keeps open-access papers.'),
    }), async (a, call) => {
      checkYears(a.year_from, a.year_to);
      const { works, nextCursor } = await openalex.search(a.query, {
        limit: a.limit, cursor: a.cursor, yearFrom: a.year_from, yearTo: a.year_to, openAccess: a.open_access, signal: call.signal,
      });
      return { rows: works.map(openalexRow), next_cursor: nextCursor };
    });

    register('get_papers', z.object({ ids: idList.describe(`1–${MAX_PAPER_IDS} DOIs, OpenAlex IDs, PMIDs or PMCIDs.`) }), async (a, call) => {
      const { works, unresolved } = await openalex.works(a.ids, { signal: call.signal });
      const rows = works.map(w => {
        const oa = w.best_oa_location;
        const names = w.authorships.map(x => x.author.display_name).filter((n): n is string => n !== null);
        return {
          openalex_id: w.id, doi: bareDoi(w.doi), title: w.title, year: w.publication_year, venue: venueOf(w), type: w.type,
          version: w.primary_location?.version ?? null, is_retracted: w.is_retracted, cited_by_count: w.cited_by_count,
          abstract: w.abstract, authors: names.slice(0, AUTHORS_IN_RECORDS), author_count: w.authorships.length,
          pmid: w.ids.pmid, pmcid: w.ids.pmcid,
          best_oa: oa ? { url: oa.pdf_url ?? oa.landing_page_url, license: oa.license, version: oa.version, source: oa.source?.display_name ?? null } : null,
          inciteful_url: urls.paperUrl(w.id),
        };
      });
      return { rows, unresolved };
    });

    register('find_similar_papers', z.object({ seeds, limit: limit(MAX_ANALYSIS_LIMIT, 25) }), async (a, call) => {
      const r = await resolveSeeds(a.seeds, call);
      const multiple = r.ids.length > 1;
      const link = r.ids.length ? urls.seedSetUrl(r.inputOrder) : null;
      const prov = (meta: GraphMeta) => provenanceFor('find_similar_papers', r, meta, {
        method: methodFor('fast_similar', multiple), filters: {}, fastPath: 'similar',
      }, link);
      if (!r.ids.length) return { rows: [], ...prov(r.meta) };
      const n = a.limit + r.ids.length;
      const { papers, ...meta } = await buildCap.run(capKey('similar', r.ids, n), () => graph.similar(r.ids, n), call.deadlineAt);
      call.graphDepth = 1;
      const seedIds = new Set(r.ids);
      const rows = papers.filter(p => !seedIds.has(p.id) && p.score > 0).slice(0, a.limit)
        .map(p => ({ ...graphPaperRow(p), score: p.score }));
      return { rows, ...prov(meta) };
    });

    register('explore_citation_network', z.object({
      seeds,
      analysis: z.enum(['similar', 'important', 'reviews', 'recent', 'authors', 'journals', 'institutions', 'references', 'citations']),
      title_all: titleTerms.describe('Every term must be in the title.'),
      title_any: titleTerms.describe('At least one term must be in the title.'),
      title_none: titleTerms.describe('No term may be in the title; needs title_all or title_any.'),
      year_from: year.optional(), year_to: year.optional(),
      limit: limit(MAX_ANALYSIS_LIMIT, 25),
    }), async (a, call) => {
      const linked = a.analysis === 'references' || a.analysis === 'citations';
      const hasTitle = [a.title_all, a.title_any, a.title_none].some(t => t?.length);
      if (linked && (hasTitle || a.year_from !== undefined || a.year_to !== undefined)) {
        throw new ToolFailure("Title and year filters apply to the graph analyses, not to 'references' or 'citations'.");
      }
      checkYears(a.year_from, a.year_to);
      // The 'recent' template keeps papers published after (current year - 3).
      const recentFrom = deps.now().getUTCFullYear() - 2;
      if (a.analysis === 'recent' && a.year_to !== undefined && a.year_to < recentFrom) {
        throw new ToolFailure(`'recent' keeps papers published from ${recentFrom} on, so year_to ${a.year_to} leaves nothing. Use 'important' with year_to for older work.`);
      }
      const titleMatch = linked ? null : buildTitleMatch({ all: a.title_all, any: a.title_any, none: a.title_none });
      const filters = {
        title_all: a.title_all ?? null, title_any: a.title_any ?? null, title_none: a.title_none ?? null,
        year_from: a.year_from ?? null, year_to: a.year_to ?? null,
      };

      const r = await resolveSeeds(a.seeds, call);
      const multiple = r.ids.length > 1;
      const link = r.ids.length ? urls.seedSetUrl(r.inputOrder) : null;
      const method = methodFor(a.analysis, multiple);
      if (!r.ids.length) {
        return { analysis: a.analysis, rows: [], ...provenanceFor('explore_citation_network', r, r.meta, { method, filters }, link) };
      }
      if (linked) {
        const { works, total } = await openalex.linked(r.ids, a.analysis as 'references' | 'citations', a.limit, { signal: call.signal });
        return {
          analysis: a.analysis, rows: works.map(openalexRow),
          ...provenanceFor('explore_citation_network', r, r.meta, { method, filters, total }, link),
        };
      }
      const sql = analysisSql(a.analysis as Analysis, multiple, { titleMatch, yearFrom: a.year_from, yearTo: a.year_to, limit: a.limit });
      const { rows, ...meta } = await buildCap.run(capKey('query', r.ids, sql, a.limit), () => graph.query(r.ids, sql, a.limit), call.deadlineAt);
      const graphMeta = await graphMetadata(r.ids, call);
      return {
        analysis: a.analysis, rows: rows.map(templateRow),
        ...provenanceFor('explore_citation_network', r, meta, { method, filters, requestedDepth: 2, graphMeta, sqlExecuted: sql, effectiveLimit: a.limit }, link),
      };
    });

    register('connect_papers', z.object({
      from: idString.describe('DOI, OpenAlex ID or PMID.'),
      to: idString.describe('DOI, OpenAlex ID or PMID.'),
      extended: z.boolean().default(false).describe('Also return longer paths.'),
    }), async (a, call) => {
      const r = await resolveSeeds([a.from, a.to], call);
      const method = 'Literature Connector: shortest citation paths, citations taken in either direction';
      const empty = (meta: GraphMeta) => ({ rows: [], paths: [], edges: [], ...provenanceFor('connect_papers', r, meta, { method, filters: {}, fastPath: 'connector' }, null) });
      if (r.duplicates.length) throw new ToolFailure('from and to are the same paper.');
      const [fromSeed, toSeed] = r.seeds;
      if (fromSeed.id === null || toSeed.id === null) return empty(r.meta);
      const [from, to] = [fromSeed.id, toSeed.id];
      const res = await buildCap.run(capKey('connector', from, to, a.extended), () => graph.connector(from, to, a.extended), call.deadlineAt);
      call.graphPapers = res.papers_searched;
      // Shortest first (a stable sort), so trimming to fit keeps the most direct connections.
      const paths = [...res.paths].sort((x, y) => x.length - y.length);
      const meta = { snapshot: res.snapshot, recentTier: res.recentTier };
      // The result from the first k paths: papers and edges on those paths only, so nothing dangles.
      const build = (k: number) => {
        const kept = paths.slice(0, k);
        const onPaths = new Set(kept.flat());
        const out = provenanceFor('connect_papers', r, meta, {
          method, filters: { extended: a.extended }, fastPath: 'connector',
          connector: { papersSearched: res.papers_searched, hops: kept.map(p => p.length - 1) },
        }, null);
        if (!paths.length) out.diagnostics.advisories.unshift('No citation path was found between the two papers within the search; try extended: true.');
        if (k < paths.length) {
          out.diagnostics.advisories.unshift(`Showing ${k} of ${paths.length} paths (shortest first); the longer ones were left out to fit the output size.`);
        }
        return {
          rows: res.papers.filter(p => onPaths.has(p.id)).map(graphPaperRow),
          paths: kept,
          edges: res.connections.filter(e => onPaths.has(e.citing) && onPaths.has(e.cited)),
          ...out, inciteful_url: urls.connectorUrl(from, to), truncated: k < paths.length,
        };
      };
      return fitConnector(build, paths.length);
    });

    register('query_citation_graph', z.object({
      seeds,
      sql: z.string().trim().min(1).max(MAX_SQL_CHARS).describe('A single SQLite SELECT statement.'),
      limit: limit(MAX_SQL_LIMIT, 100),
    }), async (a, call) => {
      // Before any call. No quote-awareness: a false positive just asks for a rewrite.
      if (/\boffset\b/i.test(a.sql) || /\blimit\s+\d+\s*,/i.test(a.sql)) {
        throw new ToolFailure("OFFSET isn't supported; use a narrower WHERE or ORDER BY");
      }
      const r = await resolveSeeds(a.seeds, call);
      const multiple = r.ids.length > 1;
      const link = r.ids.length ? urls.sqlUrl(r.inputOrder, a.sql) : null;
      const method = `custom SQL (${multiple ? 'local; multi-seed graph rooted at a synthetic paper citing all seeds' : 'local; single-seed graph'})`;
      if (!r.ids.length) return { rows: [], ...provenanceFor('query_citation_graph', r, r.meta, { method, filters: {} }, link) };
      let answer: Awaited<ReturnType<GraphClient['query']>>;
      try {
        answer = await buildCap.run(capKey('query', r.ids, a.sql, a.limit), () => graph.query(r.ids, a.sql, a.limit), call.deadlineAt);
      } catch (err) {
        // A 400 here is graph-api's error about the caller's own SQL, which they need to fix it.
        if (err instanceof GraphError && err.status === 400) {
          throw new ToolFailure(err.detail ? `graph-api rejected the query: ${err.detail}` : 'graph-api rejected the query.');
        }
        throw err;
      }
      const { rows, ...meta } = answer;
      const graphMeta = await graphMetadata(r.ids, call);
      return {
        rows,
        ...provenanceFor('query_citation_graph', r, meta, { method, filters: {}, requestedDepth: 2, graphMeta, sqlExecuted: a.sql, effectiveLimit: a.limit }, link),
      };
    });

    register('read_paper', z.object({
      id: idString.describe('DOI, OpenAlex ID, PMID or PMCID.'),
      offset: z.number().int().min(0).default(0).describe('Character offset; 0 to start, then next_offset.'),
      max_chars: z.number().int().min(1).max(MAX_READ_CHARS).default(15_000),
    }), async (a, call) => {
      const { works, unresolved } = await openalex.works([a.id], { signal: call.signal });
      const w = works[0];
      if (!w) {
        const reason = unresolved[0]?.reason ?? 'not_found';
        throw reason === 'unavailable'
          ? new ToolFailure('OpenAlex was unavailable for that paper (unavailable); retry shortly.', 'upstream_unavailable')
          : new ToolFailure("Couldn't find that paper in OpenAlex (not_found).");
      }
      const read = await content.readPaper(w, a.offset, a.max_chars, { signal: call.signal });
      const links = read.links.map(({ priority: _priority, ...l }: ContentLink) => l);
      const advisories: string[] = [];
      if (read.text === undefined) advisories.push('PMC has no open full text for this paper; the links in rows may have it.');
      const value = {
        openalex_id: w.id, doi: bareDoi(w.doi), title: w.title, pmcid: w.ids.pmcid, text: read.text ?? null, offset: a.offset,
        next_offset: read.nextOffset, sha256: read.sha256, license: read.license, rows: links, inciteful_url: urls.paperUrl(w.id),
        diagnostics: { advisories },
      };
      return fitText(value);
    });

    register('export_citations', z.object({
      ids: idList.describe(`1–${MAX_PAPER_IDS} DOIs, OpenAlex IDs, PMIDs or PMCIDs.`),
      format: z.enum(['bibtex', 'ris']),
    }), async (a, call) => {
      const { works, unresolved } = await openalex.works(a.ids, { signal: call.signal });
      const entries = a.format === 'bibtex' ? bibtexEntries(works) : risEntries(works);
      return { format: a.format, rows: works.map((w, i) => ({ openalex_id: w.id, doi: bareDoi(w.doi), entry: entries[i] })), unresolved };
    });

    server.registerPrompt('literature_review', {
      title: 'Literature review',
      description: 'A guided literature review on a topic or around seed papers: find related work, confirm the seeds with you, rank the field, read the abstracts, then write with DOI citations and provenance.',
      argsSchema: z.object({
        topic: z.string().optional().describe('The research question or topic.'),
        seeds: z.string().optional().describe('Seed papers (DOIs, OpenAlex IDs or PMIDs), separated by commas or new lines.'),
      }),
    }, ({ topic, seeds: seedText }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: reviewPrompt(topic, seedText) } }],
    }));

    return server;
  };
}

/**
 * The connector result from the largest number of (shortest-first) paths whose serialized result fits
 * the output cap. `build(k)` makes the whole result from the first k paths.
 */
function fitConnector<T>(build: (k: number) => T, n: number): T {
  const fits = (k: number) => Buffer.byteLength(JSON.stringify(build(k))) <= OUTPUT_CAP_BYTES;
  if (fits(n)) return build(n);
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

type ReadValue = { text: string | null; offset: number; next_offset: number | null; diagnostics: { advisories: string[] }; rows: unknown[] };

/**
 * Shortens a read_paper chunk until the serialized result fits the output cap, and points next_offset
 * at the first character left out, so reading continues where the chunk stops.
 */
function fitText<T extends ReadValue>(value: T): T {
  const size = (v: T) => Buffer.byteLength(JSON.stringify({ ...v, truncated: false }));
  const full = value.text;
  if (full === null || size(value) <= OUTPUT_CAP_BYTES) return value;
  const advisory = 'The text chunk was shortened to fit the output size; continue from next_offset.';
  const withChars = (n: number): T => ({
    ...value, text: full.slice(0, n), next_offset: value.offset + n,
    diagnostics: { advisories: [...value.diagnostics.advisories, advisory] },
  });
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(withChars(mid)) <= OUTPUT_CAP_BYTES) lo = mid;
    else hi = mid - 1;
  }
  // Never end on half of a surrogate pair.
  const code = full.charCodeAt(lo - 1);
  return withChars(code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo);
}
