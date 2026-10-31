import type { GraphMeta, SeedResolution } from './types.js';

export const DATA_SOURCE = "OpenAlex metadata (CC0) via Inciteful's citation graph";
export const ALWAYS_ADVISORY = 'Retraction and preprint flags: use get_papers.';
const TITLE_FILTER_KEYS = ['title_all', 'title_any', 'title_none'];
/** Unresolved seeds listed one advisory each, up to this many. */
const MAX_SEED_ADVISORIES = 10;
/** A trailing top-level LIMIT n. One inside a subquery or CTE is followed by `)` and never matches. */
const TRAILING_LIMIT = /\blimit\s+(\d+)\s*;?\s*$/i;

/** The query's trailing top-level LIMIT, if it has one. */
export function trailingLimit(sql: string): number | undefined {
  const n = sql.trim().match(TRAILING_LIMIT)?.[1];
  return n === undefined ? undefined : Number(n);
}

/**
 * The SQL as graph-api runs it: graph-api replaces the query's top-level LIMIT with `limit`, or adds
 * one. (It re-serializes the parsed query, so its spacing can differ; the LIMIT is the same.)
 */
export function withLimit(sql: string, limit: number): string {
  const s = sql.trim();
  return TRAILING_LIMIT.test(s) ? s.replace(TRAILING_LIMIT, `LIMIT ${limit}`) : `${s.replace(/\s*;$/, '')} LIMIT ${limit}`;
}

export type ProvenanceInput = {
  now: Date;
  tool: string;
  serverVersion: string;
  meta: GraphMeta;
  seeds: SeedResolution[];
  requestedDepth?: number;
  /** The graph's `metadata` table as name → value. */
  graphMeta?: Record<string, string>;
  method: string;
  filters: object;
  /** The SQL sent to graph-api; reported with the LIMIT graph-api applies, `effectiveLimit`. */
  sql?: string;
  effectiveLimit?: number;
  fastPath?: 'similar' | 'connector';
  connector?: { papersSearched: number; hops: number[] };
  total?: number | null;
};

export type Diagnostics = { advisories: string[]; unresolved_seeds: Array<{ input: string; reason: string }> };

/** Spec §4.4 coverage texts, chosen by whether the recent tier is live. The landing page shows the same text. */
export function coverageNote(snapshot: string | null, recentTier: string | null): string {
  if (recentTier === null) {
    return "The graph is built from the snapshot. Papers newer than the snapshot are looked up live only when named explicitly; they don't appear as neighbours.";
  }
  return `Snapshot ${snapshot ?? 'date unavailable'}, updated nightly through ${recentTier} with new papers that have a Crossref DOI. Other new papers are looked up live only when named.`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function buildProvenance(input: ProvenanceInput): { provenance: object; diagnostics: Diagnostics } {
  const gm = input.graphMeta ?? {};
  // Missing keys (older cached graphs, fast paths) are null, never 0.
  const num = (key: string): number | null => {
    if (gm[key] === undefined) return null;
    const n = Number(gm[key]);
    return Number.isFinite(n) ? n : null;
  };

  const graph: Record<string, unknown> = {
    papers: num('paper_count'),
    citations: num('citation_count'),
    depth: num('graph_depth'),
    prune_threshold: num('prune_threshold'),
    highly_cited_not_expanded: num('highly_cited_not_expanded'),
    seeds_not_expanded: num('seeds_not_expanded'),
  };
  if (input.fastPath === 'similar') {
    Object.assign(graph, { papers: null, depth: 1, prune_threshold: null, highly_cited_not_expanded: null, note: 'not reported by the fast path' });
  }

  const resolved = input.seeds.filter(s => s.id !== null);
  const unresolved = input.seeds.filter(s => s.id === null).map(s => ({ input: s.input, reason: s.reason ?? 'not_found' }));
  const snapshot = gm.graph_snapshot ?? input.meta.snapshot;

  const advisories: string[] = [];
  // A connector always takes exactly two papers, so the seed-count advice doesn't apply to it.
  if (input.fastPath !== 'connector' && resolved.length < 3) {
    advisories.push(`Only ${plural(resolved.length, 'seed paper', 'seed papers')} resolved; with fewer than 3 seeds the results lean heavily on those papers, so add seeds for a broader picture.`);
  }
  // Past a handful, one line: unresolved_seeds still lists every one.
  if (unresolved.length > MAX_SEED_ADVISORIES) advisories.push(`${unresolved.length} seeds unresolved; see unresolved_seeds.`);
  else for (const u of unresolved) advisories.push(`Seed "${u.input}" wasn't used: ${u.reason}.`);
  const depth = graph.depth as number | null;
  if (depth !== null && input.requestedDepth !== undefined && depth < input.requestedDepth) {
    advisories.push(`The graph reached depth ${depth}, below the requested ${input.requestedDepth}, because the next layer was too large; results cover a smaller neighbourhood.`);
  }
  const highlyCited = graph.highly_cited_not_expanded as number | null;
  if (highlyCited !== null && highlyCited > 0) {
    advisories.push(`${plural(highlyCited, 'highly cited paper was', 'highly cited papers were')} over the prune threshold and not expanded; papers citing them may be missing.`);
  }
  const seedsNotExpanded = graph.seeds_not_expanded as number | null;
  if (seedsNotExpanded !== null && seedsNotExpanded > 0) {
    advisories.push(`${plural(seedsNotExpanded, 'seed paper was', 'seed papers were')} over the prune threshold and not expanded; papers citing them may be missing.`);
  }
  const filters = input.filters as Record<string, unknown>;
  if (TITLE_FILTER_KEYS.some(k => Array.isArray(filters[k]) && (filters[k] as unknown[]).length > 0)) {
    advisories.push('A title filter is in use: it matches paper titles only (not abstracts or full text), with Porter stemming, so relevant papers worded differently are left out.');
  }
  let sqlExecuted: string | null = null;
  if (input.sql !== undefined && input.effectiveLimit !== undefined) {
    sqlExecuted = withLimit(input.sql, input.effectiveLimit);
    const queryLimit = trailingLimit(input.sql);
    if (queryLimit !== undefined && queryLimit !== input.effectiveLimit) {
      advisories.push(`graph-api applies LIMIT ${input.effectiveLimit} in place of the query's LIMIT ${queryLimit}.`);
    }
  }
  advisories.push(ALWAYS_ADVISORY);

  const provenance: Record<string, unknown> = {
    retrieved_at: input.now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tool: input.tool,
    server_version: input.serverVersion,
    data_source: DATA_SOURCE,
    graph_snapshot: snapshot,
    recent_tier: input.meta.recentTier,
    coverage_note: coverageNote(snapshot, input.meta.recentTier),
    seeds: resolved.map(s => ({ input: s.input, openalex_id: s.id })),
    graph,
    method: input.method,
    filters: input.filters,
    sql_executed: sqlExecuted,
    effective_limit: input.effectiveLimit ?? null,
  };
  if (input.connector) {
    provenance.papers_searched = input.connector.papersSearched;
    provenance.hops = input.connector.hops;
  }
  if (input.total !== undefined) provenance.total = input.total;

  return { provenance, diagnostics: { advisories, unresolved_seeds: unresolved } };
}
