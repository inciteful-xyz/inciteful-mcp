import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, ResearchApi, normalizeId, type Fetch } from '../src/api.js';

function mock(responses: Array<unknown | Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: Fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    assert.ok(responses.length, 'Unexpected API call');
    const response = responses.shift();
    return response instanceof Response ? response : Response.json(response);
  };
  return { api: new ResearchApi(new URL('https://graph.test'), 1000, { OPENALEX_API_KEY: 'test-secret' }, fetcher), calls };
}

test('normalizes DOI, OpenAlex, and PMID URLs without conflating numeric IDs', () => {
  assert.equal(normalizeId(' https://doi.org/10.1234/ABC '), '10.1234/ABC');
  assert.equal(normalizeId('https://openalex.org/w123'), 'W123');
  assert.equal(normalizeId('https://pubmed.ncbi.nlm.nih.gov/42/'), 'pmid:42');
  assert.equal(normalizeId('42'), '42');
});

test('uses the OpenAlex graph namespace and joins enrichment by DOI', async () => {
  const { api, calls } = mock([
    [{ id: 'pmid:2', title: 'Second', doi: '10.1234/ABC', citing: ['huge'] }, { id: 3, title: 'Third', doi: '10.1234/def' }],
    { results: [{ id: 'W3', doi: 'https://doi.org/10.1234/def' }, { id: 'W2', doi: 'https://doi.org/10.1234/abc' }] },
  ]);
  const result = await api.similar('W1', 2, true);
  const papers = result.papers as Array<{ inciteful: Record<string, unknown>; openalex: { id: string } }>;
  assert.equal(papers[0].openalex.id, 'W2');
  assert.equal(papers[1].openalex.id, 'W3');
  assert.equal(papers[0].inciteful.citing, undefined);
  assert.equal(decodeURIComponent(calls[0].url.pathname), '/openalex/paper/similar/W1');
  assert.equal(calls[0].url.searchParams.get('n'), '2');
  assert.equal(calls[0].url.searchParams.has('api_key'), false);
  assert.equal(calls[1].url.searchParams.get('api_key'), 'test-secret');
});

test('uses DOI URL for OpenAlex singleton requests', async () => {
  const { api, calls } = mock([{ id: 'W1' }]);
  await api.work('10.1234/abc');
  assert.equal(decodeURIComponent(calls[0].url.pathname), '/works/https://doi.org/10.1234/abc');
});

test('preserves graph results on enrichment failure and redacts upstream error bodies', async () => {
  const { api } = mock([[{ id: 'W2', title: 'Paper', doi: '10.1234/abc' }], new Response('test-secret', { status: 429 })]);
  const result = await api.similar('W1', 2, true);
  assert.equal(result.papers.length, 1);
  assert.match(JSON.stringify(result), /Rate limit/);
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
});

test('rejects OpenAlex works without a shared identifier', async () => {
  const { api, calls } = mock([{ id: 'W1', doi: null }]);
  await assert.rejects(api.graphId('W1'), /no DOI or PMID/);
  assert.equal(calls.length, 1);
});

test('uses PMID fallback when a work has no DOI', async () => {
  const { api } = mock([{ id: 'W1', doi: null, ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/42/' } }]);
  assert.equal(await api.graphId('W1'), 'pmid:42');
});

test('single graph query uses raw SQL and enforces the requested result limit locally', async () => {
  const { api, calls } = mock([[{ paper_id: 'W2' }, { paper_id: 'W3' }]]);
  const result = await api.discover('W1', 'influence', 1);
  assert.equal(result.results.length, 1);
  assert.equal(decodeURIComponent(calls[0].url.pathname), '/openalex/query/W1');
  assert.equal(calls[0].url.searchParams.get('prune'), '10000');
  assert.equal(calls[0].init?.method, 'POST');
  assert.match(String(calls[0].init?.body), /WHERE distance > 0 ORDER BY page_rank DESC LIMIT 1$/);
});

test('connector truncation retains only papers and edges on selected paths', async () => {
  const { api, calls } = mock([{ paths: [['W1', 'W2'], ['W1', 'W3']], papers: ['W1', 'W2', 'W3'].map(id => ({ id, title: id })),
    connections: [{ citing: 'W1', cited: 'W2' }, { citing: 'W1', cited: 'W3' }], num_paths: 2, max_hops: 1, papers_searched: 3 }]);
  const result = await api.connector('W1', 'W2', 1);
  assert.equal(result.truncated, true);
  assert.equal(result.num_paths, 2);
  assert.deepEqual(result.papers.map(p => p.id), ['W1', 'W2']);
  assert.deepEqual(result.connections, [{ citing: 'W1', cited: 'W2' }]);
  assert.equal(calls[0].url.pathname, '/openalex/connector');
});

test('search passes pagination and filters and returns next cursor', async () => {
  const { api, calls } = mock([{ meta: { next_cursor: 'next' }, results: [{ id: 'W1' }] }]);
  const result = await api.search('cancer', 5, 'cursor', 'is_oa:true');
  assert.equal(result.meta.next_cursor, 'next');
  assert.equal(calls[0].url.searchParams.get('filter'), 'is_oa:true');
  assert.equal(calls[0].url.searchParams.get('cursor'), 'cursor');
});

test('network errors cannot leak credential-bearing URLs', async () => {
  const api = new ResearchApi(new URL('https://graph.test'), 1000, {}, async () => { throw new Error('https://api.openalex.org?api_key=secret'); });
  await assert.rejects(api.work('W1'), error => error instanceof ApiError && !error.message.includes('secret'));
});

test('literature review resolves aliases and uses plural ids[] for multiple canonical seeds', async () => {
  const { api, calls } = mock([
    [{ id: 'W1', title: 'First' }, { id: 'W2', title: 'Second' }],
    [{ paper_id: 'W3', distance: 2 }],
  ]);
  const result = await api.literatureReview(['W1', 'W2'], { sections: ['similar_papers'] });
  assert.deepEqual(result.seed_ids, ['W1', 'W2']);
  assert.equal(result.graph_mode, 'multiple');
  assert.equal(calls[1].url.pathname, '/openalex/query');
  assert.deepEqual(calls[1].url.searchParams.getAll('ids[]'), ['W1', 'W2']);
  assert.equal(calls[1].url.searchParams.get('prune'), '10000');
  assert.equal(calls[1].url.searchParams.has('id[]'), false);
  assert.match(String(calls[1].init?.body), /p.distance = 2/);
});

test('duplicate aliases collapse to single-paper graph semantics', async () => {
  const { api, calls } = mock([{ id: 'W1', title: 'First' }, []]);
  const result = await api.literatureReview(['W1', 'W1'], { sections: ['similar_papers'] });
  assert.equal(result.graph_mode, 'single');
  assert.equal(decodeURIComponent(calls[1].url.pathname), '/openalex/query/W1');
  assert.match(String(calls[1].init?.body), /p.distance > 0/);
  assert.doesNotMatch(String(calls[1].init?.body), /p.distance = 2/);
});

test('literature review preserves successful sections and reports failures explicitly', async () => {
  const { api } = mock([{ id: 'W1', title: 'First' }, new Response('', { status: 500 }), [{ paper_id: 'W2' }]]);
  const result = await api.literatureReview(['W1'], { sections: ['similar_papers', 'important_papers'] });
  assert.equal(result.partial, true);
  assert.match(result.sections.similar_papers!.error!, /HTTP 500/);
  assert.equal(result.sections.important_papers!.results!.length, 1);
});

test('no graph is queried after a seed fails to resolve', async () => {
  const { api, calls } = mock([new Response('', { status: 404 })]);
  await assert.rejects(api.literatureReview(['W1']), /HTTP 404/);
  assert.equal(calls.length, 1);
});

test('all section failures are a tool error rather than an empty successful review', async () => {
  const { api } = mock([{ id: 'W1', title: 'First' }, new Response('', { status: 500 })]);
  await assert.rejects(api.literatureReview(['W1'], { sections: ['similar_papers'] }), /All literature-review queries failed/);
});

test('graph nodes preserve all seeds and cap only candidate nodes', async () => {
  const { api } = mock([[{ id: 'W1', title: 'First' }, { id: 'W2', title: 'Second' }],
    [{ paper_id: 'W0', distance: 0 }, { paper_id: 'W1', distance: 1 },
      { paper_id: 'W3', distance: 2 }, { paper_id: 'W4', distance: 2 }]]);
  const result = await api.literatureReview(['W1', 'W2'], { sections: ['similar_paper_graph'], limit: 1 });
  assert.deepEqual(result.sections.similar_paper_graph!.results!.map(r => r.paper_id), ['W1', 'W2', 'W3']);
});

test('500 seeds use ten metadata batches and one graph query with all canonical IDs', async () => {
  const ids = Array.from({ length: 500 }, (_, i) => `W${i + 1}`);
  const responses = Array.from({ length: 10 }, (_, batch) => ids.slice(batch * 50, (batch + 1) * 50).map(id => ({ id, title: id })));
  const { api, calls } = mock([...responses, []]);
  const result = await api.literatureReview(ids, { sections: ['similar_papers'] });
  assert.deepEqual(result.seed_ids, ids);
  assert.equal(calls.length, 11);
  assert.ok(calls.slice(0, 10).every(call => call.url.pathname === '/openalex/paper' && call.url.searchParams.getAll('ids[]').length === 50));
  assert.deepEqual(calls[10].url.searchParams.getAll('ids[]'), ids);
});

test('OpenAlex seeds resolve in a batch, then deduplicate DOI and PMID aliases', async () => {
  const { api, calls } = mock([
    { meta: {}, results: [{ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/first' }] },
    [{ id: 'W1', title: 'First' }, { id: 'W2', title: 'Second' }], [],
  ]);
  const result = await api.literatureReview(['W1', 'W2', '10.1234/first'], { sections: ['similar_papers'] });
  assert.deepEqual(result.seed_ids, ['W1', 'W2']);
  assert.equal(calls[0].url.searchParams.get('filter'), 'doi:10.1234/first');
  assert.equal(calls.length, 3);
});

test('graph aliases can proceed when optional OpenAlex alias resolution is unavailable', async () => {
  const { api, calls } = mock([new Response('', { status: 500 }), { id: 'W1', title: 'First' }, []]);
  const result = await api.literatureReview(['10.1234/first'], { sections: ['similar_papers'] });
  assert.equal(result.seed_ids[0], 'W1');
  assert.equal(calls.length, 3);
});

test('seed limits are enforced before API calls', async () => {
  const { api, calls } = mock([]);
  await assert.rejects(api.literatureReview(Array.from({ length: 501 }, (_, i) => `pmid:${i + 1}`)));
  assert.equal(calls.length, 0);
});
