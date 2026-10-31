import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServerFactory, QUERY_EXAMPLES, type ToolSettled } from '../src/tools.js';
import { createUrls } from '../src/urls.js';
import { OpenAlexClient, type Work } from '../src/openalex.js';
import type { ContentClient, ReadResult } from '../src/content.js';
import type { ConnectorResult, GraphClient, SimilarPaper } from '../src/graph.js';
import {
  BuildDeadlineError, GraphError, GraphUnavailableError, OpenAlexBudgetExhausted, QueryTimeoutError,
} from '../src/errors.js';
import type { BuildCapLike, SeedResolution } from '../src/types.js';

const NOW = new Date('2026-10-30T18:02:11.000Z');
const BASE = new URL('https://incitefulmed.com/academic/mcp');
const ALWAYS = 'Retraction and preprint flags: use get_papers.';
const TOOL_NAMES = [
  'search_literature', 'get_papers', 'find_similar_papers', 'explore_citation_network',
  'connect_papers', 'query_citation_graph', 'read_paper', 'export_citations',
];

// ---------------------------------------------------------------------------------------------
// Fakes

/** How the fake graph-api resolves inputs. Anything not listed is `not_found`. */
const KNOWN: Record<string, string> = {
  W1: 'W1', w1: 'W1', '10.x/doi-of-W1': 'W1', W2: 'W2', W3: 'W3', W4: 'W4', W5: 'W5',
};
for (let i = 100; i < 200; i++) KNOWN[`W${i}`] = `W${i}`;

function resolveOne(input: string): SeedResolution {
  if (input === 'down') return { input, id: null, reason: 'unavailable' };
  const id = KNOWN[input];
  return id ? { input, id, reason: null } : { input, id: null, reason: 'not_found' };
}

function work(id: string, over: Partial<Work> = {}): Work {
  return {
    id, doi: `https://doi.org/10.1/${id.toLowerCase()}`, title: `Title of ${id}`, publication_year: 2020, type: 'article',
    is_retracted: false, cited_by_count: 10, abstract: `Abstract of ${id}.`, ids: { pmid: null, pmcid: null },
    authorships: [{ author_position: 'first', author: { id: null, display_name: 'Ada Lovelace', orcid: null }, institutions: [] }],
    primary_location: { is_oa: true, landing_page_url: `https://example.org/${id}`, pdf_url: null, license: 'cc-by', version: 'publishedVersion', source: { display_name: 'Journal of Tests', type: 'journal' } },
    best_oa_location: { is_oa: true, landing_page_url: `https://example.org/${id}`, pdf_url: `https://example.org/${id}.pdf`, license: 'cc-by', version: 'publishedVersion', source: { display_name: 'Journal of Tests', type: 'journal' } },
    locations: [], biblio: { volume: '1', issue: '2', first_page: '3', last_page: '4' },
    open_access: { is_oa: true, oa_url: `https://example.org/${id}.pdf` },
    ...over,
  };
}

const paper = (id: string, score: number): SimilarPaper => ({
  id, doi: `10.1/${id}`, title: `Paper ${id}`, published_year: 2021, journal: 'J', author: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
  num_cited_by: 3, num_citing: 4, score,
});

type Calls = {
  resolve: string[][]; similar: Array<{ ids: string[]; n: number }>; query: Array<{ ids: string[]; sql: string; limit: number }>;
  metadata: string[][]; connector: Array<{ from: string; to: string; extended: boolean }>;
  search: Array<{ query: string; opts: unknown }>; works: string[][]; linked: Array<{ ids: string[]; direction: string; limit: number }>;
  readPaper: Array<{ id: string; offset: number; maxChars: number }>; cap: Array<{ key: string; deadlineAt: number }>;
};

type Over = Partial<{
  resolve: (inputs: string[]) => Promise<SeedResolution[]>;
  similar: (ids: string[], n: number) => Promise<SimilarPaper[]>;
  query: (ids: string[], sql: string, limit: number) => Promise<Record<string, unknown>[]>;
  metadata: (ids: string[]) => Promise<Record<string, string>>;
  connector: (from: string, to: string) => Promise<ConnectorResult>;
  search: () => Promise<{ works: Work[]; nextCursor: string | null }>;
  works: (ids: string[]) => Promise<{ works: Work[]; unresolved: Array<{ input: string; reason: 'not_found' | 'unavailable' }> }>;
  linked: (ids: string[], direction: string, limit: number) => Promise<{ works: Work[]; total: number | null }>;
  readPaper: (w: Work, offset: number, maxChars: number) => Promise<ReadResult>;
  cap: BuildCapLike;
  openalex: OpenAlexClient;
}>;

const META = { snapshot: '2026-10-15', recentTier: null };
const GRAPH_META = {
  graph_depth: '2', graph_snapshot: '2026-10-15', prune_threshold: '10000', highly_cited_not_expanded: '0',
  seeds_not_expanded: '0', paper_count: '18240', citation_count: '51234',
};

function fakes(over: Over = {}) {
  const calls: Calls = { resolve: [], similar: [], query: [], metadata: [], connector: [], search: [], works: [], linked: [], readPaper: [], cap: [] };
  const graph = {
    lastMeta: META,
    async resolve(inputs: string[]) {
      calls.resolve.push(inputs);
      return { results: over.resolve ? await over.resolve(inputs) : inputs.map(resolveOne), ...META };
    },
    async similar(ids: string[], n: number) {
      calls.similar.push({ ids, n });
      return { papers: over.similar ? await over.similar(ids, n) : [paper('W9', 2), paper('W8', 1)], ...META };
    },
    async query(ids: string[], sql: string, limit: number) {
      calls.query.push({ ids, sql, limit });
      const rows = over.query ? await over.query(ids, sql, limit)
        : [{ paper_id: 'W9', doi: '10.1/w9', authors: JSON.stringify([{ name: 'Ann' }, { name: 'Bo' }, { name: 'Cy' }, { name: 'Di' }]), title: 'Nine', journal: 'J', published_year: 2022, num_cited_by: 5, distance: 1, page_rank: 0.2 }];
      return { rows, ...META };
    },
    async metadata(ids: string[]) {
      calls.metadata.push(ids);
      return over.metadata ? over.metadata(ids) : GRAPH_META;
    },
    async connector(from: string, to: string, extended: boolean) {
      calls.connector.push({ from, to, extended });
      const result = over.connector ? await over.connector(from, to) : {
        paths: [['W1', 'W5', 'W2'], ['W1', 'W2']], papers: [paper('W1', 0), paper('W5', 0), paper('W2', 0)],
        connections: [{ citing: 'W1', cited: 'W5' }, { citing: 'W5', cited: 'W2' }, { citing: 'W1', cited: 'W2' }],
        num_paths: 2, papers_searched: 812, max_hops: 3,
      };
      return { ...result, ...META };
    },
  };
  const openalex = over.openalex ?? {
    async search(query: string, opts: unknown) {
      calls.search.push({ query, opts });
      return over.search ? over.search() : { works: [work('W1'), work('W2', { abstract: null })], nextCursor: 'next-1' };
    },
    async works(ids: string[]) {
      calls.works.push(ids);
      if (over.works) return over.works(ids);
      const found = ids.filter(i => KNOWN[i]).map(i => work(KNOWN[i]));
      return { works: found, unresolved: ids.filter(i => !KNOWN[i]).map(input => ({ input, reason: 'not_found' as const })) };
    },
    async linked(ids: string[], direction: string, limit: number) {
      calls.linked.push({ ids, direction, limit });
      return over.linked ? over.linked(ids, direction, limit) : { works: [work('W4'), work('W5')], total: 321 };
    },
  };
  const content = {
    async readPaper(w: Work, offset: number, maxChars: number) {
      calls.readPaper.push({ id: w.id, offset, maxChars });
      return over.readPaper ? over.readPaper(w, offset, maxChars)
        : { text: 'Full text.', nextOffset: null, sha256: 'ab'.repeat(32), license: 'CC BY', links: [] };
    },
  };
  const buildCap: BuildCapLike = over.cap ?? {
    async run<T>(key: string, fn: () => Promise<T>, deadlineAt: number) {
      calls.cap.push({ key, deadlineAt });
      return fn();
    },
  };
  const settled: ToolSettled[] = [];
  const deps = {
    graph: graph as unknown as GraphClient, openalex: openalex as unknown as OpenAlexClient,
    content: content as unknown as ContentClient, buildCap, version: '1.0.0', publicBaseUrl: BASE, now: () => NOW,
    onToolSettled: (e: ToolSettled) => { settled.push(e); },
  };
  return { deps, calls, settled };
}

/** The SDK client over `createMcpHandler(factory)`'s in-process `fetch`. `modern` negotiates 2026-07-28. */
async function connect(deps: ReturnType<typeof fakes>['deps'], modern = true) {
  const handler = createMcpHandler(createServerFactory(deps));
  const client = new Client({ name: 'test-client', version: '1.2.3' }, modern ? { versionNegotiation: { mode: 'auto' } } : undefined);
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/academic/mcp'), {
    fetch: (input: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(input, init)),
  });
  await client.connect(transport);
  return { client, close: async () => { await client.close(); await handler.close(); } };
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any> };

async function withClient<T>(over: Over, fn: (c: { call: (name: string, args: Record<string, unknown>) => Promise<Result>; calls: Calls; settled: ToolSettled[]; client: Client }) => Promise<T>, modern = true) {
  const { deps, calls, settled } = fakes(over);
  const { client, close } = await connect(deps, modern);
  try {
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as unknown as Result;
    return await fn({ call, calls, settled, client });
  } finally { await close(); }
}

const text = (r: Result) => r.content.find(c => c.type === 'text')?.text ?? '';
const graphCalls = (c: Calls) => c.similar.length + c.query.length + c.metadata.length + c.connector.length + c.cap.length;

// ---------------------------------------------------------------------------------------------
// Contract

test('tool_contract', async () => {
  await withClient({}, async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [...TOOL_NAMES].sort());
    const titles = Object.fromEntries(tools.map(t => [t.name, t.title]));
    assert.deepEqual(titles, {
      search_literature: 'Search the literature',
      get_papers: 'Get paper details',
      find_similar_papers: 'Find similar papers',
      explore_citation_network: 'Explore a citation network',
      connect_papers: 'Connect two papers',
      query_citation_graph: 'Query a citation graph with SQL',
      read_paper: 'Read a paper',
      export_citations: 'Export citations',
    });
    for (const t of tools) {
      assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true }, t.name);
      assert.equal(t.outputSchema?.type, 'object', t.name);
      const props = t.outputSchema?.properties as Record<string, any>;
      assert.ok(props.rows, `${t.name} has top-level rows`);
      assert.ok(props.diagnostics, `${t.name} allows diagnostics`);
      assert.ok(!(t.outputSchema?.required as string[]).includes('diagnostics'), `${t.name} diagnostics optional`);
      assert.ok(props.truncated, `${t.name} has truncated`);
    }
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map(p => p.name), ['literature_review']);
    assert.deepEqual(prompts[0].arguments?.map(a => ({ name: a.name, required: a.required ?? false })),
      [{ name: 'topic', required: false }, { name: 'seeds', required: false }]);
  });
});

test('descriptions carry the required facts', async () => {
  await withClient({}, async ({ client }) => {
    const { tools } = await client.listTools();
    const d = Object.fromEntries(tools.map(t => [t.name, t.description ?? '']));
    assert.match(d.find_similar_papers, /default first step/);
    const q = d.query_citation_graph;
    for (const fact of ['title_search(paper_id, search_text)', 'no edge table', 'in-graph', 'W0', 'cocite is NULL',
      'distance 0', 'ror.organizations', 'title_terms', 'metadata', 'OFFSET', 'single SELECT']) {
      assert.ok(q.includes(fact), `query_citation_graph mentions ${fact}`);
    }
    assert.equal(QUERY_EXAMPLES.length, 3);
    for (const sql of QUERY_EXAMPLES) assert.ok(q.includes(sql), 'example in the description');
    assert.match(d.explore_citation_network, /titles only \(not abstracts or full text\), with Porter stemming/);
    for (const [name, desc] of Object.entries(d)) {
      assert.doesNotMatch(desc, /(?<!read-)\bonly\b(?! \(not abstracts)/i, `${name}: no "only"`);
      assert.doesNotMatch(desc, /\bfirst\b(?! step)/i, `${name}: no "first" superlative`);
      assert.doesNotMatch(desc, /not (be )?logged|never logged|no logs/i, `${name}: no logging claim`);
    }
  });
});

// Builds the graph schema from the fixture, as the loader does, with a few papers.
function graphDb(multiple: boolean): DatabaseSync {
  const sections = new Map<string, string>();
  for (const part of readFileSync(new URL('./fixtures/graph-schema.sql', import.meta.url), 'utf8').split(/^-- @section /m).slice(1)) {
    const nl = part.indexOf('\n');
    sections.set(part.slice(0, nl).trim(), part.slice(nl + 1));
  }
  const d = (single: number) => (multiple ? single + 1 : single);
  const rows: Array<[string, string, number, number, number]> = [
    ['W1', 'Seed paper on vagus nerve stimulation', 2018, d(0), 0.5],
    ['W2', 'Vagal stimulation in epilepsy', 2022, d(1), 0.3],
    ['W3', 'Stimulating the vagus: a review', 2021, d(1), 0.2],
    ['W4', 'Heart rate variability', 2019, d(2), 0.1],
  ];
  if (multiple) rows.push(['W6', 'Second seed paper', 2017, 1, 0.4], ['W0', 'Temp Paper', 1900, 0, 0.6]);
  const db = new DatabaseSync(':memory:');
  db.exec(sections.get('init')!);
  const insert = db.prepare('INSERT INTO papers (paper_id, doi, authors, num_authors, title, published_year, journal) VALUES (?, ?, ?, 1, ?, ?, ?)');
  const author = db.prepare('INSERT INTO authors (paper_id, author_id, name, sequence, affiliation, affiliation_id, ror, published_year) VALUES (?, ?, ?, 0, ?, ?, ?, ?)');
  for (const [id, title, year] of rows) {
    insert.run(id, `10.1/${id}`, JSON.stringify([{ author_id: `A${id}`, name: `Author ${id}` }]), title, year, 'J');
    author.run(id, `A${id}`, `Author ${id}`, 'Inst', 'I1', 'https://ror.org/03vek6s52', year);
  }
  db.prepare("INSERT INTO metadata (name, value) VALUES ('graph_depth', '2')").run();
  db.exec(sections.get('finalize_base')!);
  const analysis = db.prepare('UPDATE papers SET num_citing = 1, num_cited_by = 1, distance = ?, page_rank = ?, adamic_adar = 0.1, cocite = ? WHERE paper_id = ?');
  for (const [id, , , distance, pr] of rows) analysis.run(distance, pr, multiple ? null : 0.1, id);
  db.exec(sections.get('partial_page_rank')!);
  db.exec(sections.get('finalize_analysis')!);
  return db;
}

test('query_examples_run_on_the_real_schema', () => {
  const single = graphDb(false);
  const multiple = graphDb(true);
  const [byRank, byAuthor, byYear] = QUERY_EXAMPLES;
  // Example 1 (single seed): titles mentioning stimulation, seed excluded, since 2020.
  assert.deepEqual(single.prepare(byRank).all().map(r => r.paper_id), ['W2', 'W3']);
  // Example 2: authors ranked; runs on both graphs.
  assert.equal(single.prepare(byAuthor).all().length, 4);
  assert.equal(multiple.prepare(byAuthor).all().length, 6);
  // Example 3 (several seeds): the seeds' neighbours by year, W0 and the seeds excluded.
  assert.deepEqual(multiple.prepare(byYear).all().map(r => [r.published_year, r.papers]), [[2022, 1], [2021, 1]]);
  for (const sql of QUERY_EXAMPLES) {
    assert.doesNotMatch(sql, /\boffset\b/i);
    multiple.prepare(sql).all();
  }
});

// ---------------------------------------------------------------------------------------------
// Output schemas

test('structured_content_matches_output_schema', async () => {
  const ajv = new AjvJsonSchemaValidator();
  await withClient({}, async ({ client, call }) => {
    const { tools } = await client.listTools();
    const schema = Object.fromEntries(tools.map(t => [t.name, t.outputSchema!]));
    const cases: Array<[string, Record<string, unknown>]> = [
      ['search_literature', { query: 'vagus nerve' }],
      ['get_papers', { ids: ['W1', 'nope'] }],
      ['find_similar_papers', { seeds: ['W1', 'hello'] }],
      ['find_similar_papers', { seeds: ['hello'] }],
      ['explore_citation_network', { seeds: ['W1', 'W2'], analysis: 'important', title_all: ['vagal'] }],
      ['explore_citation_network', { seeds: ['W1'], analysis: 'references' }],
      ['explore_citation_network', { seeds: ['hello'], analysis: 'authors' }],
      ['connect_papers', { from: 'W1', to: 'W2' }],
      ['connect_papers', { from: 'W1', to: 'hello' }],
      ['query_citation_graph', { seeds: ['W1'], sql: 'SELECT paper_id FROM papers LIMIT 5' }],
      ['read_paper', { id: 'W1' }],
      ['export_citations', { ids: ['W1', 'W2', 'nope'], format: 'bibtex' }],
      ['export_citations', { ids: ['W1'], format: 'ris' }],
    ];
    for (const [name, args] of cases) {
      // The client validates structuredContent against the listed schema too (it throws on a mismatch).
      const r = await call(name, args);
      assert.ok(!r.isError, `${name} ok: ${text(r)}`);
      const v = ajv.getValidator(schema[name])(r.structuredContent);
      assert.ok(v.valid, `${name}: ${v.errorMessage}`);
      assert.deepEqual(JSON.parse(text(r)), r.structuredContent, `${name}: text is the same JSON`);
    }
    // A capped result (diagnostics added by capResult, rows trimmed) still validates.
    const big = await withClient({ search: async () => ({ works: Array.from({ length: 50 }, (_, i) => work(`W${100 + i}`, { title: 'x'.repeat(3000) })), nextCursor: null }) },
      ({ call: c }) => c('search_literature', { query: 'big', limit: 50 }));
    assert.equal(big.structuredContent!.truncated, true);
    assert.ok(ajv.getValidator(schema.search_literature)(big.structuredContent).valid);
  });
});

// ---------------------------------------------------------------------------------------------
// Seeds

test('resolve_first_and_unresolved_reported', async () => {
  await withClient({}, async ({ call, calls }) => {
    const r = await call('find_similar_papers', { seeds: ['hello', 'W1'] });
    assert.deepEqual(calls.resolve, [['hello', 'W1']]);
    assert.deepEqual(calls.similar.map(s => s.ids), [['W1']]);
    const sc = r.structuredContent!;
    assert.deepEqual(sc.diagnostics.unresolved_seeds, [{ input: 'hello', reason: 'not_found' }]);
    assert.ok(sc.diagnostics.advisories.includes('Seed "hello" wasn\'t used: not_found.'));
    assert.deepEqual(sc.provenance.seeds, [{ input: 'W1', openalex_id: 'W1' }]);
  });
});

test('duplicate_seeds_count_once', async () => {
  await withClient({}, async ({ call, calls }) => {
    const r = await call('explore_citation_network', { seeds: ['W1', 'w1', '10.x/doi-of-W1'], analysis: 'important' });
    assert.deepEqual(calls.query[0].ids, ['W1']);
    assert.match(calls.query[0].sql, /p\.distance > 0 /);
    const sc = r.structuredContent!;
    assert.equal(sc.provenance.method, 'page_rank (local; single-seed graph)');
    assert.deepEqual(sc.provenance.seeds, [{ input: 'W1', openalex_id: 'W1' }]);
    assert.ok(sc.diagnostics.advisories.some((a: string) => a.startsWith('Only 1 seed paper resolved')));
    assert.ok(sc.diagnostics.advisories.includes('2 seeds resolved to a paper already in the list and were counted once: "w1", "10.x/doi-of-W1".'));
  });
});

test('all_unresolved_makes_no_graph_call', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['find_similar_papers', { seeds: ['hello', 'down'] }],
    ['explore_citation_network', { seeds: ['hello'], analysis: 'important' }],
    ['explore_citation_network', { seeds: ['hello'], analysis: 'references' }],
    ['query_citation_graph', { seeds: ['hello'], sql: 'SELECT 1' }],
    ['connect_papers', { from: 'hello', to: 'W1' }],
  ];
  for (const [name, args] of cases) {
    await withClient({}, async ({ call, calls }) => {
      const r = await call(name, args);
      assert.ok(!r.isError, name);
      assert.equal(graphCalls(calls), 0, `${name}: no graph build`);
      assert.equal(calls.linked.length, 0, `${name}: no OpenAlex call`);
      assert.deepEqual(r.structuredContent!.rows, []);
      assert.ok(r.structuredContent!.diagnostics.unresolved_seeds.length >= 1);
    });
  }
  await withClient({}, async ({ call }) => {
    const r = await call('find_similar_papers', { seeds: ['hello', 'down'] });
    assert.deepEqual(r.structuredContent!.diagnostics.unresolved_seeds,
      [{ input: 'hello', reason: 'not_found' }, { input: 'down', reason: 'unavailable' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Per tool

test('similar_drops_seeds_and_zero_scores', async () => {
  // A seed that cites another seed shares a reference with W0, so it can score above 0 too.
  const similar = async () => [paper('W9', 2.5), paper('W2', 1.9), paper('W8', 1.5), paper('W7', 0.5), paper('W6', 0), paper('W1', 0)];
  await withClient({ similar }, async ({ call, calls }) => {
    const r = await call('find_similar_papers', { seeds: ['W1', 'W2'], limit: 2 });
    assert.deepEqual(calls.similar, [{ ids: ['W1', 'W2'], n: 4 }]);
    const sc = r.structuredContent!;
    assert.deepEqual(sc.rows.map((p: any) => [p.paper_id, p.score]), [['W9', 2.5], ['W8', 1.5]]);
    assert.deepEqual(sc.rows[0], {
      paper_id: 'W9', doi: '10.1/W9', title: 'Paper W9', published_year: 2021, journal: 'J', authors: ['A', 'B', 'C'],
      num_cited_by: 3, num_citing: 4, score: 2.5, inciteful_url: 'https://incitefulmed.com/academic/p/W9',
    });
    assert.equal(sc.provenance.method, 'fast similarity: Adamic/Adar, depth 1 (multi-seed)');
    assert.equal(sc.provenance.graph.depth, 1);
    assert.equal(sc.provenance.graph.papers, null);
    assert.equal(sc.inciteful_url, 'https://incitefulmed.com/academic/p?ids[]=W1&ids[]=W2');
  });
  await withClient({ similar }, async ({ call }) => {
    const r = await call('find_similar_papers', { seeds: ['W1', 'W2'], limit: 10 });
    assert.deepEqual(r.structuredContent!.rows.map((p: any) => p.paper_id), ['W9', 'W8', 'W7']);
  });
});

test('explore_uses_fts_filter_and_metadata', async () => {
  const metadata = async () => ({ ...GRAPH_META, graph_depth: '1', highly_cited_not_expanded: '3' });
  await withClient({ metadata }, async ({ call, calls, settled }) => {
    const r = await call('explore_citation_network', {
      seeds: ['W2', 'W1'], analysis: 'important', title_all: ['vagal'], title_none: ['rat'], year_from: 2010, limit: 7,
    });
    assert.equal(calls.query.length, 1);
    const sent = calls.query[0];
    assert.deepEqual(sent.ids, ['W1', 'W2']);
    assert.equal(sent.limit, 7);
    assert.equal(sent.sql, 'SELECT p.paper_id, p.doi, p.authors, p.title, p.journal, p.published_year, p.num_cited_by, p.distance, p.page_rank '
      + `FROM papers p WHERE p.distance > 1 AND p.published_year >= 2010 AND p.paper_id IN (SELECT paper_id FROM title_search('search_text : ( ("vagal") NOT ("rat") )')) `
      + 'ORDER BY p.page_rank DESC, p.adamic_adar DESC LIMIT 7');
    assert.deepEqual(calls.metadata, [['W1', 'W2']]);
    const sc = r.structuredContent!;
    assert.deepEqual(sc.provenance.graph, { papers: 18240, citations: 51234, depth: 1, prune_threshold: 10000, highly_cited_not_expanded: 3, seeds_not_expanded: 0 });
    assert.equal(sc.provenance.sql_executed, sent.sql);
    assert.equal(sc.provenance.effective_limit, 7);
    assert.deepEqual(sc.provenance.filters, { title_all: ['vagal'], title_any: null, title_none: ['rat'], year_from: 2010, year_to: null });
    assert.equal(sc.provenance.method, 'page_rank (local; multi-seed graph rooted at a synthetic paper citing all seeds)');
    const adv = sc.diagnostics.advisories as string[];
    assert.ok(adv.some(a => a.startsWith('The graph reached depth 1, below the requested 2')));
    assert.ok(adv.some(a => a.startsWith('3 highly cited papers were over the prune threshold')));
    assert.ok(adv.some(a => a.startsWith('A title filter is in use')));
    assert.deepEqual(sc.rows[0], {
      paper_id: 'W9', doi: '10.1/w9', authors: ['Ann', 'Bo', 'Cy'], title: 'Nine', journal: 'J', published_year: 2022,
      num_cited_by: 5, distance: 1, page_rank: 0.2, inciteful_url: 'https://incitefulmed.com/academic/p/W9',
    });
    assert.equal(sc.analysis, 'important');
    assert.equal(settled[0].graphPapers, 18240);
    assert.equal(settled[0].graphDepth, 1);
  });
});

test('explore aggregate analyses pass rows through', async () => {
  const query = async () => [{ author_id: '5', author_name: 'Ann', total_page_rank: 0.4, num_papers: 3 }];
  await withClient({ query }, async ({ call }) => {
    const r = await call('explore_citation_network', { seeds: ['W1'], analysis: 'authors' });
    assert.deepEqual(r.structuredContent!.rows, [{ author_id: '5', author_name: 'Ann', total_page_rank: 0.4, num_papers: 3 }]);
  });
});

test('metadata failure keeps the rows', async () => {
  await withClient({ metadata: async () => { throw new GraphUnavailableError(5); } }, async ({ call }) => {
    const r = await call('explore_citation_network', { seeds: ['W1'], analysis: 'important' });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!.rows.length, 1);
    assert.equal(r.structuredContent!.provenance.graph.papers, null);
  });
});

test('references_and_citations_use_openalex_linked', async () => {
  for (const direction of ['references', 'citations']) {
    await withClient({}, async ({ call, calls }) => {
      const r = await call('explore_citation_network', { seeds: ['W1', 'W2'], analysis: direction, limit: 5 });
      assert.equal(calls.query.length, 0);
      assert.equal(calls.metadata.length, 0);
      assert.equal(calls.cap.length, 0);
      assert.deepEqual(calls.linked, [{ ids: ['W1', 'W2'], direction, limit: 5 }]);
      const sc = r.structuredContent!;
      assert.equal(sc.provenance.total, 321);
      assert.equal(sc.provenance.method, 'OpenAlex cited_by:/cites: filter, sorted by global cited_by_count');
      assert.deepEqual(sc.rows.map((w: any) => w.openalex_id), ['W4', 'W5']);
      assert.equal(sc.rows[0].inciteful_url, 'https://incitefulmed.com/academic/p/W4');
    });
  }
});

test('explore rejects filters that cannot apply', async () => {
  await withClient({}, async ({ call, calls }) => {
    const refs = await call('explore_citation_network', { seeds: ['W1'], analysis: 'references', title_all: ['vagal'] });
    assert.ok(refs.isError);
    assert.equal(text(refs), "Title and year filters apply to the graph analyses, not to 'references' or 'citations'.");
    // 'recent' keeps 2024..2026 on a 2026 clock, so year_to 2023 can never match.
    const recent = await call('explore_citation_network', { seeds: ['W1'], analysis: 'recent', year_to: 2023 });
    assert.ok(recent.isError);
    assert.equal(text(recent), "'recent' keeps papers published from 2024 on, so year_to 2023 leaves nothing. Use 'important' with year_to for older work.");
    const ok = await call('explore_citation_network', { seeds: ['W1'], analysis: 'recent', year_to: 2024 });
    assert.ok(!ok.isError);
    const order = await call('explore_citation_network', { seeds: ['W1'], analysis: 'important', year_from: 2020, year_to: 2019 });
    assert.equal(text(order), 'year_from must not be later than year_to.');
    const none = await call('explore_citation_network', { seeds: ['W1'], analysis: 'important', title_none: ['rat'] });
    assert.equal(text(none), 'title_none needs title_all or title_any');
    assert.equal(calls.resolve.length, 1, 'rejections happen before any call');
  });
});

test('connect_hops_computed', async () => {
  await withClient({}, async ({ call, calls, settled }) => {
    const r = await call('connect_papers', { from: '10.x/doi-of-W1', to: 'W2', extended: true });
    assert.deepEqual(calls.resolve, [['10.x/doi-of-W1', 'W2']]);
    assert.deepEqual(calls.connector, [{ from: 'W1', to: 'W2', extended: true }]);
    const sc = r.structuredContent!;
    assert.deepEqual(sc.provenance.hops, [2, 1]);
    assert.equal(sc.provenance.papers_searched, 812);
    assert.deepEqual(sc.paths, [['W1', 'W5', 'W2'], ['W1', 'W2']]);
    assert.equal(sc.edges.length, 3);
    assert.deepEqual(sc.rows.map((p: any) => p.paper_id), ['W1', 'W5', 'W2']);
    assert.equal(sc.inciteful_url, 'https://incitefulmed.com/academic/c?from=W1&to=W2');
    assert.ok(!sc.diagnostics.advisories.some((a: string) => a.startsWith('Only')), 'no seed-count advice for a connector');
    assert.equal(settled[0].graphPapers, 812);
  });
  await withClient({}, async ({ call, calls }) => {
    const same = await call('connect_papers', { from: 'W1', to: 'w1' });
    assert.ok(same.isError);
    assert.equal(text(same), 'from and to are the same paper.');
    assert.equal(calls.connector.length, 0);
  });
});

test('query_offset_cases', async () => {
  await withClient({}, async ({ call, calls }) => {
    for (const sql of ['SELECT * FROM papers LIMIT 10 OFFSET 5', 'select * from papers limit 10 offset 5', 'SELECT * FROM papers LIMIT 10, 20', 'SELECT * FROM papers LIMIT 10,20']) {
      const r = await call('query_citation_graph', { seeds: ['W1'], sql });
      assert.ok(r.isError, sql);
      assert.equal(text(r), "OFFSET isn't supported; use a narrower WHERE or ORDER BY");
    }
    assert.equal(calls.resolve.length + calls.query.length, 0, 'no client call on rejection');
    const ok = await call('query_citation_graph', { seeds: ['W1', 'W2'], sql: 'SELECT paper_id FROM papers LIMIT 10', limit: 40 });
    assert.ok(!ok.isError);
    assert.deepEqual(calls.query[0], { ids: ['W1', 'W2'], sql: 'SELECT paper_id FROM papers LIMIT 10', limit: 40 });
    const sc = ok.structuredContent!;
    assert.equal(sc.provenance.sql_executed, 'SELECT paper_id FROM papers LIMIT 10');
    assert.equal(sc.provenance.effective_limit, 40);
    assert.ok(sc.diagnostics.advisories.includes('graph-api applies LIMIT 40 in place of the query\'s LIMIT'));
    assert.equal(sc.inciteful_url, 'https://incitefulmed.com/academic/p/q?ids[]=W1&ids[]=W2&sql=SELECT%20paper_id%20FROM%20papers%20LIMIT%2010');
    // User rows are returned as they are.
    assert.deepEqual(sc.rows[0].authors, JSON.stringify([{ name: 'Ann' }, { name: 'Bo' }, { name: 'Cy' }, { name: 'Di' }]));
  });
});

test('query errors map to tool errors', async () => {
  await withClient({ query: async () => { throw new QueryTimeoutError(); } }, async ({ call, settled }) => {
    const r = await call('query_citation_graph', { seeds: ['W1'], sql: 'SELECT 1' });
    assert.ok(r.isError);
    assert.equal(text(r), "The query hit graph-api's time limit; simplify it or add a LIMIT/WHERE.");
    assert.doesNotMatch(text(r), /\d/, 'query_timeout_message_has_no_number');
    assert.equal(settled[0].outcome, 'timeout');
  });
  await withClient({ query: async () => { throw new GraphError(400, 'no such column: foo'); } }, async ({ call, settled }) => {
    const r = await call('query_citation_graph', { seeds: ['W1'], sql: 'SELECT foo FROM papers' });
    assert.equal(text(r), 'graph-api rejected the query: no such column: foo');
    assert.equal(settled[0].outcome, 'tool_error');
  });
  await withClient({ query: async () => { throw new GraphError(400, 'secret detail'); } }, async ({ call }) => {
    const r = await call('explore_citation_network', { seeds: ['W1'], analysis: 'important' });
    assert.equal(text(r), 'The citation graph service returned an error.', 'detail is shown for user SQL only');
  });
  await withClient({ cap: { run: async () => { throw new BuildDeadlineError(); } } }, async ({ call, settled }) => {
    const r = await call('query_citation_graph', { seeds: ['W1'], sql: 'SELECT 1' });
    assert.equal(text(r), 'The graph is still building; retry in about a minute.');
    assert.equal(settled[0].outcome, 'timeout');
  });
  await withClient({ resolve: async () => { throw new GraphUnavailableError(30); } }, async ({ call, settled }) => {
    const r = await call('find_similar_papers', { seeds: ['W1'] });
    assert.equal(text(r), 'The citation graph service is temporarily unavailable; retry in about 30 seconds.');
    assert.equal(settled[0].outcome, 'upstream_unavailable');
  });
  await withClient({ resolve: async () => { throw new GraphUnavailableError(null); } }, async ({ call }) => {
    const r = await call('find_similar_papers', { seeds: ['W1'] });
    assert.equal(text(r), 'The citation graph service is temporarily unavailable; retry shortly.');
  });
  await withClient({ resolve: async () => { throw new TypeError('fetch failed: http://graph-api-academic/openalex?ids[]=W1'); } }, async ({ call }) => {
    const r = await call('find_similar_papers', { seeds: ['W1'] });
    assert.equal(text(r), 'The tool failed unexpectedly.');
  });
});

test('build cap keys and deadline', async () => {
  await withClient({}, async ({ call, calls }) => {
    await call('find_similar_papers', { seeds: ['W2', 'W1'], limit: 5 });
    await call('find_similar_papers', { seeds: ['W1', 'W2', 'W1'], limit: 5 });
    await call('explore_citation_network', { seeds: ['W1'], analysis: 'important' });
    await call('query_citation_graph', { seeds: ['W2', 'W1'], sql: 'SELECT 1', limit: 9 });
    await call('connect_papers', { from: 'W1', to: 'W2' });
    const keys = calls.cap.map(c => c.key);
    assert.equal(keys[0], keys[1], 'identical requests share a key');
    assert.deepEqual(keys.map(k => JSON.parse(k)), [
      ['similar', ['W1', 'W2'], 7], ['similar', ['W1', 'W2'], 7],
      ['query', ['W1'], calls.query[0].sql, 25], ['metadata', ['W1']],
      ['query', ['W1', 'W2'], 'SELECT 1', 9], ['metadata', ['W1', 'W2']],
      ['connector', 'W1', 'W2', false],
    ]);
    assert.ok(calls.cap.every(c => c.deadlineAt === NOW.getTime() + 90_000));
  });
});

test('export_uses_openalex_not_graph', async () => {
  await withClient({}, async ({ call, calls }) => {
    const r = await call('export_citations', { ids: ['W1', 'nope'], format: 'ris' });
    assert.equal(calls.resolve.length + graphCalls(calls), 0);
    assert.deepEqual(calls.works, [['W1', 'nope']]);
    const sc = r.structuredContent!;
    assert.equal(sc.format, 'ris');
    assert.deepEqual(sc.unresolved, [{ input: 'nope', reason: 'not_found' }]);
    assert.equal(sc.rows[0].openalex_id, 'W1');
    assert.match(sc.rows[0].entry, /^TY {2}- JOUR\r\n/);
    assert.match(sc.rows[0].entry, /ER {2}- \r\n$/);
    const bib = await call('export_citations', { ids: ['W1', 'W2'], format: 'bibtex' });
    assert.deepEqual(bib.structuredContent!.rows.map((x: any) => x.entry.split('\n')[0]), ['@article{Lovelace2020Title,', '@article{Lovelace2020Titlea,']);
  });
});

test('get_papers and search_literature rows', async () => {
  await withClient({}, async ({ call, calls }) => {
    const g = await call('get_papers', { ids: ['W1', 'nope'] });
    assert.equal(calls.resolve.length, 0);
    const sc = g.structuredContent!;
    assert.deepEqual(sc.unresolved, [{ input: 'nope', reason: 'not_found' }]);
    assert.deepEqual(sc.rows[0], {
      openalex_id: 'W1', doi: '10.1/w1', title: 'Title of W1', year: 2020, venue: 'Journal of Tests', type: 'article',
      version: 'publishedVersion', is_retracted: false, cited_by_count: 10, abstract: 'Abstract of W1.', authors: ['Ada Lovelace'], author_count: 1,
      pmid: null, pmcid: null,
      best_oa: { url: 'https://example.org/W1.pdf', license: 'cc-by', version: 'publishedVersion', source: 'Journal of Tests' },
      inciteful_url: 'https://incitefulmed.com/academic/p/W1',
    });
    const s = await call('search_literature', { query: 'vagus', limit: 5, year_from: 2010, open_access: true, cursor: 'abc' });
    assert.deepEqual(calls.search, [{ query: 'vagus', opts: { limit: 5, cursor: 'abc', yearFrom: 2010, yearTo: undefined, openAccess: true } }]);
    assert.equal(s.structuredContent!.next_cursor, 'next-1');
    assert.deepEqual(s.structuredContent!.rows[1], {
      openalex_id: 'W2', doi: '10.1/w2', title: 'Title of W2', year: 2020, venue: 'Journal of Tests', cited_by_count: 10,
      type: 'article', is_retracted: false, has_abstract: false, inciteful_url: 'https://incitefulmed.com/academic/p/W2',
    });
  });
});

test('read_paper', async () => {
  await withClient({}, async ({ call, calls }) => {
    const r = await call('read_paper', { id: 'W1', offset: 10, max_chars: 500 });
    assert.deepEqual(calls.works, [['W1']]);
    assert.deepEqual(calls.readPaper, [{ id: 'W1', offset: 10, maxChars: 500 }]);
    const sc = r.structuredContent!;
    assert.equal(sc.text, 'Full text.');
    assert.equal(sc.offset, 10);
    assert.equal(sc.next_offset, null);
    assert.equal(sc.license, 'CC BY');
    const missing = await call('read_paper', { id: 'nope' });
    assert.ok(missing.isError);
    assert.equal(text(missing), "Couldn't find that paper in OpenAlex (not_found).");
    assert.equal(calls.readPaper.length, 1);
  });
  await withClient({ works: async ids => ({ works: [], unresolved: ids.map(input => ({ input, reason: 'unavailable' as const })) }) }, async ({ call, settled }) => {
    const r = await call('read_paper', { id: 'W1' });
    assert.equal(text(r), 'OpenAlex was unavailable for that paper (unavailable); retry shortly.');
    assert.equal(settled[0].outcome, 'upstream_unavailable');
  });
  // A chunk too big for the output cap is cut, and next_offset continues where it stops.
  const big = 'é'.repeat(50_000);
  await withClient({ readPaper: async (_w, offset) => ({ text: big, nextOffset: offset + big.length, sha256: 'ab'.repeat(32), license: null, links: [] }) }, async ({ call }) => {
    const r = await call('read_paper', { id: 'W1', offset: 100, max_chars: 50_000 });
    const sc = r.structuredContent!;
    assert.ok(Buffer.byteLength(text(r)) <= 60_000);
    assert.ok(sc.text.length < 50_000 && sc.text.length > 20_000);
    assert.equal(sc.next_offset, 100 + sc.text.length);
    assert.ok(sc.diagnostics.advisories.some((a: string) => a.includes('next_offset')));
  });
  await withClient({ readPaper: async () => ({ nextOffset: null, sha256: null, license: null, links: [{ url: 'https://example.org/x.pdf', format: 'pdf', source: 'Repo', is_oa: true, license: null, version: null, priority: 0 }] }) }, async ({ call }) => {
    const sc = (await call('read_paper', { id: 'W1' })).structuredContent!;
    assert.equal(sc.text, null);
    assert.deepEqual(sc.rows, [{ url: 'https://example.org/x.pdf', format: 'pdf', source: 'Repo', is_oa: true, license: null, version: null }]);
  });
});

test('input bounds', async () => {
  await withClient({}, async ({ call, settled }) => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['search_literature', { query: 'x', limit: 51 }],
      ['get_papers', { ids: Array.from({ length: 101 }, (_, i) => `W${i}`) }],
      ['export_citations', { ids: Array.from({ length: 101 }, (_, i) => `W${i}`), format: 'ris' }],
      ['find_similar_papers', { seeds: Array.from({ length: 501 }, (_, i) => `W${i}`) }],
      ['find_similar_papers', { seeds: [] }],
      ['find_similar_papers', { seeds: ['W1'], limit: 101 }],
      ['explore_citation_network', { seeds: ['W1'], analysis: 'important', limit: 101 }],
      ['query_citation_graph', { seeds: ['W1'], sql: 'SELECT 1', limit: 501 }],
      ['read_paper', { id: 'W1', offset: -1 }],
      ['read_paper', { id: 'W1', max_chars: 0 }],
      ['read_paper', { id: 'W1', max_chars: 50_001 }],
    ];
    for (const [name, args] of bad) {
      const r = await call(name, args);
      assert.ok(r.isError, `${name} ${JSON.stringify(args).slice(0, 60)}`);
      assert.match(text(r), /Input validation error/);
    }
    // The SDK rejects these before the handler runs (see the report).
    assert.equal(settled.length, 0);
    for (const [name, args] of [
      ['search_literature', { query: 'x', limit: 50 }], ['get_papers', { ids: Array.from({ length: 100 }, (_, i) => `W${i}`) }],
      ['find_similar_papers', { seeds: Array.from({ length: 500 }, (_, i) => `W${i}`), limit: 100 }],
      ['query_citation_graph', { seeds: ['W1'], sql: 'SELECT 1', limit: 500 }], ['read_paper', { id: 'W1', offset: 0, max_chars: 50_000 }],
    ] as Array<[string, Record<string, unknown>]>) {
      assert.ok(!(await call(name, args)).isError, name);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// OpenAlex errors, URLs, output cap

test('budget_exhausted_message_has_retry', async () => {
  await withClient({ works: async () => { throw new OpenAlexBudgetExhausted(1234); } }, async ({ call, settled }) => {
    for (const [name, args] of [['get_papers', { ids: ['W1'] }], ['export_citations', { ids: ['W1'], format: 'ris' }], ['read_paper', { id: 'W1' }]] as const) {
      const r = await call(name, args);
      assert.ok(r.isError);
      assert.equal(text(r), 'The OpenAlex request budget is used up for now; retry in about 1234 seconds.');
    }
    assert.deepEqual(settled.map(s => s.outcome), ['upstream_unavailable', 'upstream_unavailable', 'upstream_unavailable']);
  });
});

test('urls_capped_at_50', async () => {
  const urls = createUrls(new URL('https://incitefulmed.com/academic/mcp?x=1'));
  assert.equal(urls.paperUrl('W1'), 'https://incitefulmed.com/academic/p/W1');
  assert.equal(urls.connectorUrl('W1', 'W2'), 'https://incitefulmed.com/academic/c?from=W1&to=W2');
  const ids = Array.from({ length: 60 }, (_, i) => `W${i + 1}`);
  const set = urls.seedSetUrl(ids);
  assert.equal(set.capped, true);
  assert.equal(new URL(set.url).searchParams.getAll('ids[]').length, 50);
  assert.ok(set.url.startsWith('https://incitefulmed.com/academic/p?ids[]=W1&ids[]=W2&'));
  assert.ok(set.url.endsWith('&ids[]=W50'));
  assert.deepEqual(urls.seedSetUrl(['W1']), { url: 'https://incitefulmed.com/academic/p?ids[]=W1', capped: false });
  const q = urls.sqlUrl(ids, "SELECT * FROM papers WHERE title LIKE '%a&b%'");
  assert.equal(q.capped, true);
  assert.equal(new URL(q.url).searchParams.get('sql'), "SELECT * FROM papers WHERE title LIKE '%a&b%'");
  assert.equal(new URL(q.url).searchParams.getAll('ids[]').length, 50);

  const seeds = Array.from({ length: 60 }, (_, i) => `W${100 + i}`);
  await withClient({}, async ({ call }) => {
    const sc = (await call('find_similar_papers', { seeds })).structuredContent!;
    assert.equal(new URL(sc.inciteful_url).searchParams.getAll('ids[]').length, 50);
    assert.ok(sc.diagnostics.advisories.includes('The inciteful_url link carries the first 50 of 60 seeds, to fit URL limits.'));
  });
});

test('output_capped_flagged', async () => {
  const works = Array.from({ length: 50 }, (_, i) => work(`W${100 + i}`, { title: 'é'.repeat(1500) }));
  await withClient({ search: async () => ({ works, nextCursor: null }) }, async ({ call }) => {
    const r = await call('search_literature', { query: 'big', limit: 50 });
    const sc = r.structuredContent!;
    assert.equal(sc.truncated, true);
    assert.ok(sc.rows.length < 50 && sc.rows.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(sc)) <= 60_000);
    assert.ok(sc.diagnostics.advisories.includes('Output truncated; narrow the request (lower limit, fewer seeds, a title filter).'));
  });
  await withClient({}, async ({ call }) => {
    assert.equal((await call('search_literature', { query: 'small' })).structuredContent!.truncated, false);
  });
});

// ---------------------------------------------------------------------------------------------
// onToolSettled

test('onToolSettled_fires_once_per_call', async () => {
  for (const modern of [true, false]) {
    await withClient({ resolve: async inputs => { if (inputs.includes('boom')) throw new GraphUnavailableError(9); return inputs.map(resolveOne); } }, async ({ call, settled }) => {
      await call('get_papers', { ids: ['W1'] });
      await call('query_citation_graph', { seeds: ['W1'], sql: 'SELECT 1 OFFSET 2' });
      await call('find_similar_papers', { seeds: ['boom'] });
      await call('find_similar_papers', { seeds: ['W1'] });
      const clientInfo = modern ? { name: 'test-client', version: '1.2.3' } : null;
      assert.deepEqual(settled, [
        { tool: 'get_papers', outcome: 'ok', clientInfo, graphPapers: null, graphDepth: null, openalexCalls: 0 },
        { tool: 'query_citation_graph', outcome: 'tool_error', clientInfo, graphPapers: null, graphDepth: null, openalexCalls: 0 },
        { tool: 'find_similar_papers', outcome: 'upstream_unavailable', clientInfo, graphPapers: null, graphDepth: null, openalexCalls: 0 },
        { tool: 'find_similar_papers', outcome: 'ok', clientInfo, graphPapers: null, graphDepth: 1, openalexCalls: 0 },
      ], modern ? '2026-07-28' : '2025');
    }, modern);
  }
});

test('onToolSettled throwing does not change the result', async () => {
  const { deps } = fakes();
  const { client, close } = await connect({ ...deps, onToolSettled: () => { throw new Error('sink down'); } });
  try {
    const r = (await client.callTool({ name: 'get_papers', arguments: { ids: ['W1'] } })) as unknown as Result;
    assert.ok(!r.isError);
  } finally { await close(); }
});

test('openalexCalls counts real OpenAlex requests per call', async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const filter = url.searchParams.get('filter') ?? '';
    const ids = filter.startsWith('openalex:') ? filter.slice(9).split('|') : [];
    return Response.json({ meta: { count: ids.length }, results: ids.map(id => ({ id: `https://openalex.org/${id}`, title: id })) });
  }) as typeof fetch;
  const openalex = new OpenAlexClient('key', fetcher);
  await withClient({ openalex }, async ({ call, settled }) => {
    await call('get_papers', { ids: ['W1', '10.1/abc'] });
    await call('export_citations', { ids: ['W1'], format: 'bibtex' });
    assert.deepEqual(settled.map(s => s.openalexCalls), [2, 1]);
  });
});

// ---------------------------------------------------------------------------------------------
// Prompt

test('prompt_requires_topic_or_seeds', async () => {
  await withClient({}, async ({ client }) => {
    await assert.rejects(client.getPrompt({ name: 'literature_review', arguments: {} }), /topic or seeds/);
    await assert.rejects(client.getPrompt({ name: 'literature_review', arguments: { topic: '  ', seeds: ' , \n' } }), /topic or seeds/);
    const p = await client.getPrompt({ name: 'literature_review', arguments: { topic: 'vagus nerve stimulation', seeds: '10.1/a, W2\n10.1/c' } });
    const body = (p.messages[0].content as { text: string }).text;
    assert.equal(p.messages[0].role, 'user');
    assert.ok(body.includes('Topic: vagus nerve stimulation'));
    assert.ok(body.includes('Seed papers: 10.1/a, W2, 10.1/c'));
    for (const step of [
      '1. resolve the seeds;',
      '2. run `find_similar_papers`;',
      '3. propose 3–5 seeds and wait for the user to confirm them (a checkpoint);',
      '4. run `explore_citation_network` for `important`, `reviews` and `recent`, plus `references` and `citations` on the confirmed seeds;',
      '5. fetch the finalists\' abstracts with `get_papers`;',
      '6. only then write: cite every paper by DOI and append the provenance.',
    ]) assert.ok(body.includes(step), step);
    const topicOnly = await client.getPrompt({ name: 'literature_review', arguments: { topic: 'sleep' } });
    assert.doesNotMatch((topicOnly.messages[0].content as { text: string }).text, /Seed papers:/);
  });
});
