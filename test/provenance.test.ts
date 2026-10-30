import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProvenance } from '../src/provenance.js';
import type { SeedResolution } from '../src/types.js';

const ALWAYS = 'Retraction and preprint flags: use get_papers.';
const NOW = new Date('2026-10-30T18:02:11.000Z');
const three: SeedResolution[] = [
  { input: '10.1038/nature14539', id: 'W1', reason: null },
  { input: 'W2', id: 'W2', reason: null },
  { input: 'W3', id: 'W3', reason: null },
];
const fullMeta = {
  graph_depth: '2', graph_snapshot: '2026-10-15', prune_threshold: '10000', highly_cited_not_expanded: '0',
  seeds_not_expanded: '0', paper_count: '18240', citation_count: '51234',
};

type Input = Parameters<typeof buildProvenance>[0];
const build = (over: Partial<Input> = {}) => buildProvenance({
  now: NOW, tool: 'explore_citation_network', serverVersion: '1.0.0',
  meta: { snapshot: '2026-10-15', recentTier: null }, seeds: three, requestedDepth: 2, graphMeta: fullMeta,
  method: 'page_rank (local; multi-seed graph rooted at a synthetic paper citing all seeds)', filters: {},
  ...over,
});
const prov = (over: Partial<Input> = {}) => build(over).provenance as Record<string, any>;
const advisories = (over: Partial<Input> = {}) => build(over).diagnostics.advisories;

test('baseline: only the always-on advisory', () => {
  assert.deepEqual(advisories(), [ALWAYS]);
  assert.deepEqual(build().diagnostics.unresolved_seeds, []);
});

test('full provenance block from graph metadata', () => {
  const p = prov({ filters: { title_all: ['vagal'], year_from: null }, sqlExecuted: 'SELECT 1 LIMIT 25', effectiveLimit: 25 });
  assert.deepEqual(p, {
    retrieved_at: '2026-10-30T18:02:11Z',
    tool: 'explore_citation_network', server_version: '1.0.0',
    data_source: "OpenAlex metadata (CC0) via Inciteful's citation graph",
    graph_snapshot: '2026-10-15',
    recent_tier: null,
    coverage_note: "The graph is built from the snapshot. Papers newer than the snapshot are looked up live only when named explicitly; they don't appear as neighbours.",
    seeds: [
      { input: '10.1038/nature14539', openalex_id: 'W1' }, { input: 'W2', openalex_id: 'W2' }, { input: 'W3', openalex_id: 'W3' },
    ],
    graph: { papers: 18240, citations: 51234, depth: 2, prune_threshold: 10000, highly_cited_not_expanded: 0, seeds_not_expanded: 0 },
    method: 'page_rank (local; multi-seed graph rooted at a synthetic paper citing all seeds)',
    filters: { title_all: ['vagal'], year_from: null },
    sql_executed: 'SELECT 1 LIMIT 25',
    effective_limit: 25,
  });
});

test('advisory_fewer_than_3_resolved_seeds', () => {
  const a = advisories({ seeds: three.slice(0, 2) });
  assert.equal(a.length, 2);
  assert.match(a[0]!, /2 seed papers/);
  assert.equal(a.at(-1), ALWAYS);
  // Unresolved seeds don't count toward the three.
  assert.equal(advisories({ seeds: [...three.slice(0, 2), { input: 'x', id: null, reason: 'not_found' }] })
    .filter(s => /fewer than 3/.test(s)).length, 1);
});

test('advisory_unresolved_seed_with_reason', () => {
  const seeds: SeedResolution[] = [...three, { input: 'hello', id: null, reason: 'not_found' }, { input: 'W9', id: null, reason: 'unavailable' }];
  const r = build({ seeds });
  assert.deepEqual(r.diagnostics.unresolved_seeds, [{ input: 'hello', reason: 'not_found' }, { input: 'W9', reason: 'unavailable' }]);
  assert.equal(r.diagnostics.advisories.length, 3);
  assert.match(r.diagnostics.advisories[0]!, /"hello".*not_found/);
  assert.match(r.diagnostics.advisories[1]!, /"W9".*unavailable/);
  // Only resolved seeds appear in provenance.
  assert.equal((r.provenance as any).seeds.length, 3);
});

test('advisory_depth_below_requested', () => {
  const a = advisories({ graphMeta: { ...fullMeta, graph_depth: '1' } });
  assert.equal(a.length, 2);
  assert.match(a[0]!, /depth 1.*2/);
  // Only when both are known.
  assert.deepEqual(advisories({ graphMeta: { ...fullMeta, graph_depth: '1' }, requestedDepth: undefined }), [ALWAYS]);
  const { graph_depth: _, ...noDepth } = fullMeta;
  assert.deepEqual(advisories({ graphMeta: noDepth }), [ALWAYS]);
});

test('advisory_highly_cited_not_expanded', () => {
  const a = advisories({ graphMeta: { ...fullMeta, highly_cited_not_expanded: '3' } });
  assert.equal(a.length, 2);
  assert.match(a[0]!, /^3 highly cited papers/);
});

test('advisory_seeds_not_expanded', () => {
  const a = advisories({ graphMeta: { ...fullMeta, seeds_not_expanded: '1' } });
  assert.equal(a.length, 2);
  assert.match(a[0]!, /^1 seed paper /);
});

test('advisory_title_filter', () => {
  for (const key of ['title_all', 'title_any', 'title_none']) {
    const a = advisories({ filters: { [key]: ['x'] } });
    assert.equal(a.length, 2, key);
    assert.match(a[0]!, /titles only/);
  }
  assert.deepEqual(advisories({ filters: { title_all: [], year_from: 2020 } }), [ALWAYS]);
});

test('advisory_user_limit_replaced', () => {
  const a = advisories({ sqlExecuted: 'SELECT * FROM papers LIMIT 1000', effectiveLimit: 500 });
  assert.deepEqual(a, ["graph-api applies LIMIT 500 in place of the query's LIMIT", ALWAYS]);
  assert.deepEqual(advisories({ sqlExecuted: 'SELECT * FROM papers limit 500', effectiveLimit: 500 }), [ALWAYS]);
  assert.deepEqual(advisories({ sqlExecuted: 'SELECT * FROM papers', effectiveLimit: 500 }), [ALWAYS]);
  // Only a trailing top-level LIMIT counts; one inside a subquery or CTE never does.
  assert.equal(advisories({ sqlExecuted: 'SELECT * FROM (SELECT * FROM papers LIMIT 5) LIMIT 20', effectiveLimit: 20 }).length, 1);
  assert.deepEqual(advisories({
    sqlExecuted: 'WITH top AS (SELECT * FROM papers ORDER BY page_rank DESC LIMIT 50) SELECT * FROM top ORDER BY title',
    effectiveLimit: 5,
  }), [ALWAYS]);
  assert.deepEqual(advisories({ sqlExecuted: 'SELECT * FROM (SELECT * FROM papers LIMIT 3)', effectiveLimit: 5 }), [ALWAYS]);
  assert.deepEqual(advisories({
    sqlExecuted: 'WITH top AS (SELECT * FROM papers LIMIT 50) SELECT * FROM top LIMIT 7', effectiveLimit: 5,
  }), ["graph-api applies LIMIT 5 in place of the query's LIMIT", ALWAYS]);
  assert.deepEqual(advisories({ sqlExecuted: '  SELECT * FROM papers\n LIMIT 7 ;\n', effectiveLimit: 5 }).length, 2);
});

test('nulls_not_zero_when_meta_missing', () => {
  const p = prov({ graphMeta: {} });
  assert.deepEqual(p.graph, { papers: null, citations: null, depth: null, prune_threshold: null, highly_cited_not_expanded: null, seeds_not_expanded: null });
  assert.equal(prov({ graphMeta: undefined }).graph.papers, null);
  assert.equal(p.sql_executed, null);
  assert.equal(p.effective_limit, null);
  // Snapshot falls back to the response header.
  assert.equal(p.graph_snapshot, '2026-10-15');
  assert.equal(prov({ graphMeta: {}, meta: { snapshot: null, recentTier: null } }).graph_snapshot, null);
});

test('zero_string_is_zero', () => {
  const p = prov({ graphMeta: { highly_cited_not_expanded: '0', seeds_not_expanded: '0', paper_count: '0' } });
  assert.equal(p.graph.highly_cited_not_expanded, 0);
  assert.equal(p.graph.seeds_not_expanded, 0);
  assert.equal(p.graph.papers, 0);
  assert.equal(p.graph.depth, null);
});

test('fast_path_similar_fields', () => {
  const p = prov({ tool: 'find_similar_papers', fastPath: 'similar', graphMeta: undefined, requestedDepth: undefined,
    method: 'fast similarity: Adamic/Adar + Salton, depth 1' });
  assert.deepEqual(p.graph, {
    papers: null, citations: null, depth: 1, prune_threshold: null, highly_cited_not_expanded: null, seeds_not_expanded: null,
    note: 'not reported by the fast path',
  });
  assert.equal(p.graph_snapshot, '2026-10-15');
});

test('connector fields', () => {
  const r = build({ tool: 'connect_papers', fastPath: 'connector', connector: { papersSearched: 812, hops: [2, 3] },
    seeds: three.slice(0, 2), graphMeta: undefined, requestedDepth: undefined, method: 'connector' });
  const p = r.provenance as any;
  assert.equal(p.papers_searched, 812);
  assert.deepEqual(p.hops, [2, 3]);
  // Two papers is the whole input for a connector; no fewer-than-3 advisory.
  assert.deepEqual(r.diagnostics.advisories, [ALWAYS]);
});

test('total carried when given', () => {
  assert.equal(prov({ total: 1234 }).total, 1234);
  assert.equal(prov({ total: null }).total, null);
  assert.ok(!('total' in prov()));
});

test('coverage_note_with_and_without_recent_tier', () => {
  assert.equal(prov().coverage_note,
    "The graph is built from the snapshot. Papers newer than the snapshot are looked up live only when named explicitly; they don't appear as neighbours.");
  const live = prov({ meta: { snapshot: '2026-10-15', recentTier: '2026-11-02' } });
  assert.equal(live.recent_tier, '2026-11-02');
  assert.equal(live.coverage_note,
    'Snapshot 2026-10-15, updated nightly through 2026-11-02 with new papers that have a Crossref DOI. Other new papers are looked up live only when named.');
});

test('data_source_exact', () => {
  assert.equal(prov().data_source, "OpenAlex metadata (CC0) via Inciteful's citation graph");
});

test('retrieved_at_from_injected_now', () => {
  assert.equal(prov({ now: new Date('2027-01-02T03:04:05.678Z') }).retrieved_at, '2027-01-02T03:04:05Z');
});
