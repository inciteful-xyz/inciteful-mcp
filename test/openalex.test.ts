import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { OpenAlexClient, compactWork, normalizeId, reconstructAbstract } from '../src/openalex.js';
import { OpenAlexBudgetExhausted, OpenAlexError } from '../src/errors.js';

const KEY = 'SENTINEL-OA-KEY-7f3a9c';

type Call = { url: URL; method: string; headers: Headers };

function fake(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers) };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetcher, calls };
}

const page = (results: unknown[], meta: Record<string, unknown> = {}) => Response.json({ meta: { count: results.length, ...meta }, results });
const raw = (id: string, extra: Record<string, unknown> = {}) => ({ id: `https://openalex.org/${id}`, title: id, cited_by_count: 0, ...extra });
/** The OR-values of a `kind:` filter in a recorded request. */
const filterValues = (call: Call, kind: string) => {
  const part = (call.url.searchParams.get('filter') ?? '').split(',').find(p => p.startsWith(`${kind}:`));
  return part ? part.slice(kind.length + 1).split('|') : [];
};

// Trimmed from GET https://api.openalex.org/works?filter=doi:10.1038/nature14539|10.1145/3065386&corpus=all, 2026-10-30
// (one authorship, three of four locations, abstract index cut to its first six positions).
const imagenet = {
  id: 'https://openalex.org/W2163605009', doi: 'https://doi.org/10.1145/3065386', title: 'ImageNet classification with deep convolutional neural networks',
  publication_year: 2017, type: 'article', is_retracted: false, cited_by_count: 112178,
  ids: { openalex: 'https://openalex.org/W2163605009', doi: 'https://doi.org/10.1145/3065386', mag: '2163605009' },
  authorships: [{ author_position: 'first', author: { id: 'https://openalex.org/A5031152245', display_name: 'Alex Krizhevsky', orcid: null, observed_orcids: [] },
    institutions: [{ id: 'https://openalex.org/I1291425158', display_name: 'Google (United States)', ror: 'https://ror.org/00njsd438', country_code: 'US' }], raw_author_name: 'Alex Krizhevsky' }],
  primary_location: { is_oa: true, landing_page_url: 'https://doi.org/10.1145/3065386', pdf_url: 'http://dl.acm.org/ft_gateway.cfm?id=3065386&type=pdf', license: null, version: 'publishedVersion',
    source: { display_name: 'Communications of the ACM', type: 'journal', issn_l: '0001-0782' } },
  best_oa_location: { is_oa: true, landing_page_url: 'https://doi.org/10.1145/3065386', pdf_url: 'http://dl.acm.org/ft_gateway.cfm?id=3065386&type=pdf', license: null, version: 'publishedVersion',
    source: { display_name: 'Communications of the ACM', type: 'journal', issn_l: '0001-0782' } },
  locations: [
    { is_oa: true, landing_page_url: 'https://doi.org/10.1145/3065386', pdf_url: 'http://dl.acm.org/ft_gateway.cfm?id=3065386&type=pdf', license: null, version: 'publishedVersion',
      source: { display_name: 'Communications of the ACM', type: 'journal', issn_l: '0001-0782' } },
    { is_oa: false, landing_page_url: 'http://citeseerx.ist.psu.edu/viewdoc/summary?doi=10.1.1.299.205', pdf_url: null, license: null, version: 'submittedVersion', source: null },
  ],
  biblio: { volume: '60', issue: '6', first_page: '84', last_page: '90' },
  open_access: { is_oa: true, oa_status: 'bronze', oa_url: 'http://dl.acm.org/ft_gateway.cfm?id=3065386&type=pdf', any_repository_has_fulltext: false },
  abstract_inverted_index: { We: [0], trained: [1], a: [2], 'large,': [3], deep: [4], convolutional: [5] },
};

test('normalizes DOI, OpenAlex, and PMID URLs without conflating numeric IDs', () => {
  assert.equal(normalizeId(' https://doi.org/10.1234/ABC '), '10.1234/ABC');
  assert.equal(normalizeId('https://openalex.org/w123'), 'W123');
  assert.equal(normalizeId('https://pubmed.ncbi.nlm.nih.gov/42/'), 'pmid:42');
  assert.equal(normalizeId('42'), '42');
});

test('reconstructs abstract positions and repeated tokens without relying on key order', () => {
  assert.equal(reconstructAbstract({ paper: [2], The: [0], describes: [3], new: [1, 4], methods: [5] }), 'The new paper describes new methods');
  assert.equal(reconstructAbstract(null), null);
  assert.throws(() => reconstructAbstract({ word: [1000000] }), /invalid/);
  assert.throws(() => reconstructAbstract({ word: [2] }), /incomplete/);
  assert.throws(() => reconstructAbstract({ a: [0], b: [0] }), /conflicting/);
});

test('work_shape_from_real_record', () => {
  const work = compactWork(imagenet)!;
  assert.equal(work.id, 'W2163605009');
  assert.equal(work.doi, 'https://doi.org/10.1145/3065386');
  assert.equal(work.abstract, 'We trained a large, deep convolutional');
  assert.equal('abstract_inverted_index' in work, false);
  assert.equal(work.is_retracted, false);
  assert.equal(work.type, 'article');
  assert.equal(work.publication_year, 2017);
  assert.equal(work.cited_by_count, 112178);
  assert.deepEqual(work.biblio, { volume: '60', issue: '6', first_page: '84', last_page: '90' });
  assert.equal(work.primary_location?.version, 'publishedVersion');
  assert.deepEqual(work.primary_location?.source, { display_name: 'Communications of the ACM', type: 'journal' });
  assert.equal(work.best_oa_location?.license, null);
  assert.equal(work.locations.length, 2);
  assert.deepEqual(work.authorships, [{ author_position: 'first', author: { id: 'https://openalex.org/A5031152245', display_name: 'Alex Krizhevsky', orcid: null },
    institutions: [{ id: 'https://openalex.org/I1291425158', display_name: 'Google (United States)', ror: 'https://ror.org/00njsd438' }] }]);
  assert.deepEqual(work.ids, { pmid: null, pmcid: null });
  assert.deepEqual(work.open_access, { is_oa: true, oa_url: 'http://dl.acm.org/ft_gateway.cfm?id=3065386&type=pdf' });
  // A broken abstract index loses the abstract, not the work.
  assert.equal(compactWork({ ...imagenet, abstract_inverted_index: { a: [0], b: [0] } })!.abstract, null);
  assert.deepEqual(compactWork({ id: 'https://openalex.org/W1', ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/42', pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/4373434' } })!.ids,
    { pmid: '42', pmcid: 'PMC4373434' });
  assert.equal(compactWork({ id: 'nonsense' }), null);
});

test('bearer_only_never_in_url', async () => {
  const { fetcher, calls } = fake(() => page([raw('W1')]));
  const client = new OpenAlexClient(KEY, fetcher);
  await client.search('vagus nerve', { limit: 5 });
  await client.works(['W1', '10.1/x', 'pmid:1', 'PMC2']);
  await client.linked(['W1'], 'citations', 5);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(call.url.href.includes(KEY), false);
    assert.equal(call.url.searchParams.has('api_key'), false);
    assert.equal(call.url.origin + call.url.pathname, 'https://api.openalex.org/works');
  }
});

test('corpus_all_always', async () => {
  const { fetcher, calls } = fake(() => page([raw('W1')]));
  const client = new OpenAlexClient(KEY, fetcher);
  await client.search('x', { limit: 1 });
  await client.works(['W1']);
  await client.linked(['W1'], 'references', 1);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.url.searchParams.get('corpus'), 'all');
});

test('search_params_and_cursor', async () => {
  const { fetcher, calls } = fake(() => page([imagenet], { next_cursor: 'IlsyNjYuMDcyNTcsIF0i' }));
  const client = new OpenAlexClient(KEY, fetcher);
  const result = await client.search('vagus nerve stimulation', { limit: 2, yearFrom: 2020, yearTo: 2024, openAccess: true });
  assert.equal(result.nextCursor, 'IlsyNjYuMDcyNTcsIF0i');
  assert.equal(result.works[0].id, 'W2163605009');
  const params = calls[0].url.searchParams;
  assert.equal(params.get('search'), 'vagus nerve stimulation');
  assert.equal(params.get('per-page'), '2');
  assert.equal(params.get('cursor'), '*');
  assert.equal(params.get('filter'), 'from_publication_date:2020-01-01,to_publication_date:2024-12-31,is_oa:true');
  assert.ok(params.get('select')!.split(',').includes('abstract_inverted_index'));

  const { fetcher: f2, calls: c2 } = fake(() => page([], { next_cursor: null }));
  const next = await new OpenAlexClient(KEY, f2).search('x', { limit: 3, cursor: 'abc' });
  assert.equal(next.nextCursor, null);
  assert.equal(c2[0].url.searchParams.get('cursor'), 'abc');
  assert.equal(c2[0].url.searchParams.has('filter'), false);
});

test('batches_at_100_per_kind', async () => {
  const ws = Array.from({ length: 150 }, (_, i) => `W${i + 1}`);
  const dois = Array.from({ length: 120 }, (_, i) => `10.1234/d${i}`);
  const { fetcher, calls } = fake(call => page(filterValues(call, 'openalex').map(w => raw(w))));
  const result = await new OpenAlexClient(KEY, fetcher).works([...ws, ...dois, 'pmid:5', 'PMC7']);
  const sizes = (kind: string) => calls.map(c => filterValues(c, kind).length).filter(n => n > 0);
  assert.deepEqual(sizes('openalex'), [100, 50]);
  assert.deepEqual(sizes('doi'), [100, 20]);
  assert.deepEqual(sizes('pmid'), [1]);
  assert.deepEqual(filterValues(calls.find(c => filterValues(c, 'pmcid').length)!, 'pmcid'), ['PMC7']);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    // 200 rows for at most 100 values: works sharing a DOI or PMID can't push a match off the page.
    assert.equal(call.url.searchParams.get('per-page'), '200');
    assert.equal((call.url.searchParams.get('filter') ?? '').split(',').length, 1);
  }
  assert.equal(result.works.length, 150);
  assert.equal(result.unresolved.length, 122);
  assert.ok(result.unresolved.every(u => u.reason === 'not_found'));
});

test('pipe_or_comma_never_fetched', async () => {
  const { fetcher, calls } = fake(call => page(filterValues(call, 'openalex').map(w => raw(w))));
  const result = await new OpenAlexClient(KEY, fetcher).works(['10.1/a|10.2/b', '10.1/a,b', 'W1|W2', 'hello', 'W1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('filter'), 'openalex:W1');
  assert.deepEqual(result.works.map(w => w.id), ['W1']);
  assert.deepEqual(result.unresolved, [
    { input: '10.1/a|10.2/b', reason: 'not_found' }, { input: '10.1/a,b', reason: 'not_found' },
    { input: 'W1|W2', reason: 'not_found' }, { input: 'hello', reason: 'not_found' },
  ]);

  const { fetcher: none, calls: noCalls } = fake(() => page([]));
  assert.deepEqual(await new OpenAlexClient(KEY, none).works(['a|b', '']), { works: [], unresolved: [{ input: 'a|b', reason: 'not_found' }, { input: '', reason: 'not_found' }] });
  assert.equal(noCalls.length, 0);
});

test('maps_results_back_by_normalized_key', async () => {
  const { fetcher, calls } = fake(call => {
    if (filterValues(call, 'doi').length) return page([raw('W10', { doi: 'https://doi.org/10.1/abc' })]);
    if (filterValues(call, 'pmid').length) return page([raw('W11', { ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/42' } })]);
    if (filterValues(call, 'pmcid').length) return page([raw('W12', { ids: { pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/123' } })]);
    return page([raw('W7')]);
  });
  const inputs = ['pmid:42', '10.1/ABC', 'https://openalex.org/w7', 'PMC123', 'https://doi.org/10.1/abc', '10.9/missing'];
  const result = await new OpenAlexClient(KEY, fetcher).works(inputs);
  assert.deepEqual(filterValues(calls.find(c => filterValues(c, 'doi').length)!, 'doi'), ['10.1/abc', '10.9/missing']);
  // Input order; the DOI given twice in different forms yields one work.
  assert.deepEqual(result.works.map(w => w.id), ['W11', 'W10', 'W7', 'W12']);
  assert.deepEqual(result.unresolved, [{ input: '10.9/missing', reason: 'not_found' }]);
});

test('failed_batch_marks_inputs_unavailable', async () => {
  const { fetcher } = fake(call => filterValues(call, 'doi').length ? new Response('boom', { status: 500 }) : page([raw('W1')]));
  const result = await new OpenAlexClient(KEY, fetcher).works(['W1', '10.1/a', 'doi:10.1/b']);
  assert.deepEqual(result.works.map(w => w.id), ['W1']);
  assert.deepEqual(result.unresolved, [{ input: '10.1/a', reason: 'unavailable' }, { input: 'doi:10.1/b', reason: 'unavailable' }]);
});

test('works_rethrows_budget_exhaustion_when_nothing_came_back', async () => {
  const { fetcher } = fake(() => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
  await assert.rejects(new OpenAlexClient(KEY, fetcher).works(['W1', '10.1/a']),
    (err: unknown) => err instanceof OpenAlexBudgetExhausted && err.retryAfterSecs === 30);
});

test('429_maps_to_budget_exhausted_with_retry', async () => {
  const cases: Array<[Record<string, string>, number]> = [
    [{ 'Retry-After': '120', 'x-ratelimit-reset': '2581' }, 120],
    [{ 'x-ratelimit-reset': '2581' }, 2581],
    [{}, 3600],
    [{ 'Retry-After': 'soon' }, 3600],
  ];
  for (const [headers, expected] of cases) {
    const { fetcher } = fake(() => new Response('{"error":"rate limited"}', { status: 429, headers }));
    await assert.rejects(new OpenAlexClient(KEY, fetcher).search('x', { limit: 1 }),
      (err: unknown) => err instanceof OpenAlexBudgetExhausted && err.retryAfterSecs === expected);
  }
  const { fetcher } = fake(() => new Response('', { status: 503 }));
  await assert.rejects(new OpenAlexClient(KEY, fetcher).search('x', { limit: 1 }), (err: unknown) => err instanceof OpenAlexError && err.status === 503);
});

test('linked_filters_and_sort', async () => {
  const { fetcher, calls } = fake(() => page([raw('W9', { cited_by_count: 5 })], { count: 73 }));
  const client = new OpenAlexClient(KEY, fetcher);
  const refs = await client.linked(['W2919115771', 'https://openalex.org/W2163605009'], 'references', 20);
  assert.deepEqual(refs, { works: [compactWork(raw('W9', { cited_by_count: 5 }))], total: 73 });
  assert.equal(calls[0].url.searchParams.get('filter'), 'cited_by:W2919115771|W2163605009');
  assert.equal(calls[0].url.searchParams.get('sort'), 'cited_by_count:desc');
  assert.equal(calls[0].url.searchParams.get('per-page'), '20');
  await client.linked(['W1'], 'citations', 3);
  assert.equal(calls[1].url.searchParams.get('filter'), 'cites:W1');
  assert.equal(calls[1].url.searchParams.get('per-page'), '3');
});

test('linked_multi_batch_merges_and_total_null', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `W${i + 1}`);
  const { fetcher, calls } = fake((_call, index) => index === 0
    ? page([raw('W900', { cited_by_count: 50 }), raw('W901', { cited_by_count: 30 }), raw('W902', { cited_by_count: 10 })], { count: 400 })
    : page([raw('W901', { cited_by_count: 30 }), raw('W903', { cited_by_count: 40 }), raw('W904', { cited_by_count: 20 })], { count: 200 }));
  const result = await new OpenAlexClient(KEY, fetcher).linked(ids, 'citations', 4);
  assert.deepEqual(calls.map(c => filterValues(c, 'cites').length), [100, 50]);
  assert.deepEqual(result.works.map(w => w.id), ['W900', 'W903', 'W901', 'W904']);
  assert.equal(result.total, null);
});

test('errors_and_inspect_never_contain_key', async () => {
  const errors: unknown[] = [];
  const failures: Array<() => Response> = [
    () => new Response(`bad key ${KEY}`, { status: 401 }),
    () => new Response(`limit ${KEY}`, { status: 429 }),
    () => new Response(`oops ${KEY}`, { status: 500 }),
    () => new Response(`not json ${KEY}`, { status: 200 }),
    () => { throw new TypeError(`fetch failed for Bearer ${KEY}`, { cause: new Error(KEY) }); },
  ];
  for (const fail of failures) {
    const client = new OpenAlexClient(KEY, fake(fail).fetcher);
    for (const call of [() => client.search('q', { limit: 1 }), () => client.linked(['W1'], 'references', 1)]) {
      try { await call(); assert.fail('expected a rejection'); } catch (err) { errors.push(err); }
    }
  }
  const client = new OpenAlexClient(KEY, fake(() => page([])).fetcher);
  for (const text of [inspect(client, { showHidden: true, depth: 10 }), JSON.stringify(client), String(client),
    ...errors.map(e => inspect(e, { showHidden: true, depth: 10 })), ...errors.map(e => JSON.stringify(e))]) {
    assert.equal(String(text).includes(KEY), false, text);
  }
  assert.ok(errors.every(e => e instanceof OpenAlexError || e instanceof OpenAlexBudgetExhausted));
});
