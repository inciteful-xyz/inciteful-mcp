import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { GraphClient } from '../src/graph.js';
import { GraphError, GraphUnavailableError, QueryTimeoutError } from '../src/errors.js';

type Call = { url: URL; method: string; headers: Headers; body: string | undefined };

function fake(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)), method: init?.method ?? 'GET',
      headers: new Headers(init?.headers), body: init?.body == null ? undefined : String(init.body),
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetcher, calls };
}

const cfg = { graphPrimary: new URL('http://primary.test/'), graphSecondary: new URL('http://secondary.test/') };
const json = (body: unknown, headers: Record<string, string> = {}) => Response.json(body, { headers });

/** How undici reports a failed connection: `TypeError('fetch failed')` with the code on `cause`. */
function connectionError(code: string) {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

// Trimmed from GET https://graph.incitefulmed.com/openalex/paper/similar?ids[]=W2919115771&n=5, 2026-10-30
// (authors cut to one; scores as served). The order is reversed here so a re-sort would show.
const similarSample = [
  { id: 'W2163922914', doi: '10.1109/tpami.2013.50', author: [{ author_id: 5086198262, name: 'Yoshua Bengio', sequence: 0, position: 'first' }],
    title: 'Representation Learning: A Review and New Perspectives', published_year: 2013, journal: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', num_citing: 270, num_cited_by: 3086, score: 2.397293480061488 },
  { id: 'W3141285120', doi: '10.1155/2021/5548884', author: [{ author_id: 0, name: 'Ranjan Kumar Mishra', sequence: 0, position: 'first' }],
    title: 'The Understanding of Deep Learning: A Comprehensive Review', published_year: 2021, journal: 'Mathematical Problems in Engineering', num_citing: 102, num_cited_by: 86, score: 2.7990282895826746 },
];

test('falls_back_only_on_connection_error', async () => {
  for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']) {
    const { fetcher, calls } = fake((call) => {
      if (call.url.host === 'primary.test') throw connectionError(code);
      return json([{ input: 'W1', id: 'W1', reason: null }], { 'X-Graph-Snapshot': '2026-10-15' });
    });
    const graph = new GraphClient(cfg, fetcher);
    const result = await graph.resolve(['W1']);
    assert.deepEqual(result.results, [{ input: 'W1', id: 'W1', reason: null }], code);
    assert.deepEqual(calls.map(c => c.url.host), ['primary.test', 'secondary.test'], code);
    assert.equal(calls[1].url.pathname, '/openalex/resolve', code);
  }
});

test('secondary_tried_at_most_once', async () => {
  const error = connectionError('ECONNREFUSED');
  const { fetcher, calls } = fake(() => { throw error; });
  await assert.rejects(new GraphClient(cfg, fetcher).resolve(['W1']), (err: unknown) => err === error);
  assert.deepEqual(calls.map(c => c.url.host), ['primary.test', 'secondary.test']);
});

test('no_fallback_on_headers_timeout_or_abort', async () => {
  const headersTimeout = connectionError('UND_ERR_HEADERS_TIMEOUT');
  const abort = new DOMException('This operation was aborted', 'AbortError');
  const plain = new TypeError('fetch failed');
  for (const error of [headersTimeout, abort, plain]) {
    const { fetcher, calls } = fake(() => { throw error; });
    const graph = new GraphClient(cfg, fetcher);
    await assert.rejects(graph.query(['W1', 'W2'], 'SELECT 1', 5), (err: unknown) => err === error);
    assert.deepEqual(calls.map(c => c.url.host), ['primary.test']);
  }
});

test('does_not_fall_back_on_503_or_404', async () => {
  {
    const { fetcher, calls } = fake(() => new Response('unavailable', { status: 503, headers: { 'Retry-After': '120' } }));
    await assert.rejects(new GraphClient(cfg, fetcher).similar(['W1'], 5),
      (err: unknown) => err instanceof GraphUnavailableError && err.retryAfterSecs === 120);
    assert.equal(calls.length, 1);
  }
  {
    const { fetcher, calls } = fake(() => new Response('unavailable', { status: 503 }));
    await assert.rejects(new GraphClient(cfg, fetcher).similar(['W1'], 5),
      (err: unknown) => err instanceof GraphUnavailableError && err.retryAfterSecs === null);
    assert.equal(calls.length, 1);
  }
  {
    const { fetcher, calls } = fake(() => new Response('not found', { status: 404 }));
    await assert.rejects(new GraphClient(cfg, fetcher).connector('W1', 'W2', false),
      (err: unknown) => err instanceof GraphError && err.status === 404);
    assert.equal(calls.length, 1);
  }
});

test('query_body_is_raw_sql', async () => {
  const sql = "SELECT p.paper_id, p.title FROM papers p\nWHERE p.title LIKE '%Ω \"x\" & y%' ORDER BY page_rank DESC LIMIT 3";
  const { fetcher, calls } = fake(() => json([{ paper_id: 'W2', title: 'x' }]));
  const graph = new GraphClient(cfg, fetcher);

  const multi = await graph.query(['W1', 'W2'], sql, 25);
  assert.deepEqual(multi.rows, [{ paper_id: 'W2', title: 'x' }]);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.pathname, '/openalex/query');
  assert.deepEqual(calls[0].url.searchParams.getAll('ids[]'), ['W1', 'W2']);
  assert.equal(calls[0].url.searchParams.get('prune'), '10000');
  assert.equal(calls[0].url.searchParams.get('limit'), '25');
  assert.equal(calls[0].headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(calls[0].body, sql);

  await graph.query(['W1'], sql, 7);
  assert.equal(calls[1].url.pathname, '/openalex/query/W1');
  assert.equal(calls[1].url.searchParams.has('ids[]'), false);
  assert.equal(calls[1].url.searchParams.get('prune'), '10000');
  assert.equal(calls[1].url.searchParams.get('limit'), '7');
  assert.equal(calls[1].body, sql);
});

test('resolve_batches_at_100_in_order', async () => {
  const inputs = Array.from({ length: 250 }, (_, i) => i % 3 === 0 ? `10.1234/LONG-DOI-${i}` : `W${i + 1}`);
  // Answer batches out of order in time, so concatenation must follow input order, not arrival.
  const { fetcher, calls } = fake(async (call, index) => {
    await new Promise(r => setTimeout(r, (3 - index) * 5));
    return json(call.url.searchParams.getAll('ids[]').map(input => ({ input, id: input.startsWith('W') ? input : null, reason: input.startsWith('W') ? null : 'not_found' })));
  });
  const result = await new GraphClient(cfg, fetcher).resolve(inputs);
  assert.deepEqual(calls.map(c => c.url.searchParams.getAll('ids[]').length), [100, 100, 50]);
  assert.deepEqual(result.results.map(r => r.input), inputs);
  assert.deepEqual(result.results[0], { input: '10.1234/LONG-DOI-0', id: null, reason: 'not_found' });
  assert.deepEqual(result.results[1], { input: 'W2', id: 'W2', reason: null });
});

test('resolve_empty_makes_one_request_without_ids', async () => {
  const { fetcher, calls } = fake(() => json([], { 'X-Graph-Snapshot': '2026-10-15' }));
  const graph = new GraphClient(cfg, fetcher);
  const result = await graph.resolve([]);
  assert.deepEqual(result, { results: [], snapshot: '2026-10-15', recentTier: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/openalex/resolve');
  assert.equal(calls[0].url.search, '');
  assert.deepEqual(graph.lastMeta, { snapshot: '2026-10-15', recentTier: null });
});

test('reads_snapshot_and_recent_headers_and_updates_lastMeta', async () => {
  const responses = [
    () => json([], { 'X-Graph-Snapshot': '2026-10-15', 'X-Graph-Recent-Tier': '2026-10-29' }),
    () => json([], { 'X-Graph-Snapshot': '2026-11-01', 'X-Graph-Recent-Tier': '' }),
    () => new Response('down', { status: 503, headers: { 'X-Graph-Snapshot': '2026-11-02' } }),
  ];
  const { fetcher } = fake((_call, index) => responses[index]());
  const graph = new GraphClient(cfg, fetcher);
  assert.deepEqual(graph.lastMeta, { snapshot: null, recentTier: null });

  const first = await graph.resolve(['W1']);
  assert.equal(first.snapshot, '2026-10-15');
  assert.equal(first.recentTier, '2026-10-29');
  assert.deepEqual(graph.lastMeta, { snapshot: '2026-10-15', recentTier: '2026-10-29' });

  const second = await graph.similar(['W1'], 5);
  assert.equal(second.snapshot, '2026-11-01');
  assert.equal(second.recentTier, null);
  assert.deepEqual(graph.lastMeta, { snapshot: '2026-11-01', recentTier: null });

  await assert.rejects(graph.resolve(['W1']), GraphUnavailableError);
  assert.deepEqual(graph.lastMeta, { snapshot: '2026-11-02', recentTier: null });
});

test('maps_time_limit_400_to_QueryTimeoutError', async () => {
  const { fetcher } = fake(() => new Response('Error: Query exceeded the time limit', { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  await assert.rejects(new GraphClient(cfg, fetcher).query(['W1'], 'SELECT 1', 5), QueryTimeoutError);
});

test('other_400_carries_body', async () => {
  // Real body from POST /openalex/query?ids[]=W2919115771&prune=10000&limit=5 with `SELECT nope FROM papers`, 2026-10-30.
  const body = "Error: Error executing query: 'no such column: nope in SELECT nope FROM papers LIMIT 5 at offset 7'";
  const { fetcher } = fake(() => new Response(body, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  await assert.rejects(new GraphClient(cfg, fetcher).query(['W1'], 'SELECT nope FROM papers', 5), (err: unknown) => {
    assert.ok(err instanceof GraphError);
    assert.equal(err.status, 400);
    assert.equal(err.detail, body);
    assert.equal(err.message, 'The citation graph service returned an error.');
    // The body echoes the user's SQL: it must not surface through inspect, JSON or a spread.
    assert.equal(inspect(err, { depth: 10 }).includes('no such column'), false);
    assert.equal(JSON.stringify(err).includes('no such column'), false);
    assert.equal(JSON.stringify({ ...err }).includes('no such column'), false);
    assert.equal(Object.keys(err).includes('detail'), false);
    return true;
  });
});

test('similar_keeps_server_order', async () => {
  const { fetcher, calls } = fake(() => json(similarSample, { 'X-Graph-Snapshot': '2026-10-15' }));
  const result = await new GraphClient(cfg, fetcher).similar(['W2919115771', 'W2'], 12);
  assert.deepEqual(result.papers.map(p => [p.id, p.score]), [['W2163922914', 2.397293480061488], ['W3141285120', 2.7990282895826746]]);
  assert.equal(result.papers[0].title, 'Representation Learning: A Review and New Perspectives');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/openalex/paper/similar');
  assert.deepEqual(calls[0].url.searchParams.getAll('ids[]'), ['W2919115771', 'W2']);
  assert.equal(calls[0].url.searchParams.get('n'), '12');
});

test('similar_rejects_non_numeric_fields', async () => {
  const [row] = similarSample;
  for (const bad of [{ ...row, score: '2.3' }, { ...row, num_cited_by: null }, { ...row, num_citing: 'x' }, { ...row, id: 7 }]) {
    const { fetcher } = fake(() => json([bad]));
    await assert.rejects(new GraphClient(cfg, fetcher).similar(['W1'], 5), (err: unknown) => err instanceof GraphError && err.status === 200);
  }
});

test('metadata_reads_name_value_rows', async () => {
  // Real rows from `SELECT name, value FROM metadata` on W2919115771, 2026-10-30.
  const rows = [{ name: 'graph_depth', value: '2' }, { name: 'graph_snapshot', value: '2026-10-15' }, { value: '10000', name: 'prune_threshold' },
    { name: 'highly_cited_not_expanded', value: '0' }, { name: 'seeds_not_expanded', value: '0' }, { value: '188843', name: 'paper_count' }];
  const { fetcher, calls } = fake(() => json(rows));
  const meta = await new GraphClient(cfg, fetcher).metadata(['W1', 'W2']);
  assert.deepEqual(meta, { graph_depth: '2', graph_snapshot: '2026-10-15', prune_threshold: '10000', highly_cited_not_expanded: '0', seeds_not_expanded: '0', paper_count: '188843' });
  assert.equal(calls[0].body, 'SELECT name, value FROM metadata');
  assert.equal(calls[0].url.searchParams.get('prune'), '10000');
  assert.ok(calls[0].url.searchParams.has('limit'));
});

test('connector_sends_from_to_and_extend', async () => {
  // Trimmed from GET /openalex/connector?from=W2919115771&to=W2163605009&extend=0, 2026-10-30.
  const sample = {
    papers: [{ id: 'W2163605009', doi: '10.1145/3065386', author: [{ author_id: 5031152245, name: 'Alex Krizhevsky', sequence: 0, position: 'first' }],
      title: 'ImageNet classification with deep convolutional neural networks', sources: [], fields_of_study: [], pdf_urls: [],
      published_year: 2017, journal: 'Communications of the ACM', citing: [], cited_by: [], num_citing: 26, num_cited_by: 2048, distance: 2, path_count: 2 }],
    paths: [['W2919115771', 'W2169805405', 'W2163605009'], ['W2919115771', 'W2108069432', 'W2163605009']],
    connections: [{ citing: 'W2919115771', cited: 'W2108069432' }], num_paths: 2, papers_searched: 4177, max_hops: 3,
  };
  const { fetcher, calls } = fake(() => json(sample, { 'X-Graph-Snapshot': '2026-10-15' }));
  const graph = new GraphClient(cfg, fetcher);
  const result = await graph.connector('W2919115771', 'W2163605009', false);
  assert.equal(calls[0].url.pathname, '/openalex/connector');
  assert.equal(calls[0].url.searchParams.get('from'), 'W2919115771');
  assert.equal(calls[0].url.searchParams.get('to'), 'W2163605009');
  assert.equal(calls[0].url.searchParams.get('extend'), '0');
  assert.deepEqual(result.paths, sample.paths);
  assert.equal(result.papers_searched, 4177);
  assert.equal(result.snapshot, '2026-10-15');
  assert.equal('citing' in result.papers[0], false);
  await graph.connector('W1', 'W2', true);
  assert.equal(calls[1].url.searchParams.get('extend'), '5');
});

test('base_url_path_prefix_is_kept', async () => {
  const { fetcher, calls } = fake(() => json([]));
  await new GraphClient({ graphPrimary: new URL('http://primary.test/graph'), graphSecondary: cfg.graphSecondary }, fetcher).resolve(['W1']);
  assert.equal(calls[0].url.pathname, '/graph/openalex/resolve');
});
