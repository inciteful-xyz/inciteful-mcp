import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ContentClient, contentLinks, parseBioC } from '../src/content.js';
import { compactWork, type Work } from '../src/openalex.js';

// Shape as served by pmcoa.cgi/BioC_json/PMC4373434/unicode on 2026-10-30, text shortened.
const bio = [{ documents: [{ id: 'PMC1', infons: { license: 'CC BY' }, passages: [
  { text: 'A study', infons: { section_type: 'TITLE', 'article-id_pmid': '1', 'article-id_pmc': 'PMC1' } },
  { text: 'An abstract.', infons: { section_type: 'ABSTRACT' } },
  { text: 'Introduction with actual body text.', infons: { section_type: 'INTRO' } },
  { text: 'Methods and results.', infons: { section_type: 'METHODS' } },
] }] }];

const work: Work = compactWork({
  id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/example',
  ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/1', pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/1' },
  best_oa_location: { pdf_url: 'https://repository.example/paper.pdf', landing_page_url: 'https://repository.example/paper', is_oa: true, license: 'cc-by', version: 'acceptedVersion', source: { display_name: 'Repository' } },
  locations: [{ pdf_url: 'https://repository.example/paper.pdf', is_oa: true }, { landing_page_url: 'https://publisher.example/paper', is_oa: false }],
})!;
const noPmc: Work = { ...work, ids: { pmid: '1', pmcid: null } };

function fake(handler: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fetcher, urls };
}

test('full-text links rank OA copies, preserve provenance and deduplicate URLs', () => {
  const links = contentLinks(work);
  assert.equal(links[0].url, 'https://repository.example/paper.pdf');
  assert.equal(links[0].license, 'cc-by');
  assert.equal(links.filter(l => l.url.endsWith('/paper.pdf')).length, 1);
  assert.ok(links.some(l => l.is_oa === false));
});

test('no_openalex_archive_links', async () => {
  const archived = compactWork({
    id: 'https://openalex.org/W1', content_urls: { pdf: 'https://content.openalex.org/works/W1.pdf' }, has_content: { pdf: true },
    best_oa_location: { pdf_url: 'https://content.openalex.org/works/W1.pdf', landing_page_url: 'https://repository.example/paper', is_oa: true },
    locations: [{ pdf_url: 'https://CONTENT.openalex.org/works/W1.pdf?x=1', is_oa: true }],
    open_access: { is_oa: true, oa_url: 'https://content.openalex.org/works/W1.pdf' },
  })!;
  const links = contentLinks(archived);
  assert.deepEqual(links.map(l => l.url), ['https://repository.example/paper']);
  const { fetcher, urls } = fake(() => { throw new Error('no download expected'); });
  const result = await new ContentClient(fetcher).readPaper(archived, 0, 100);
  assert.equal(urls.length, 0);
  assert.equal(result.links.some(l => new URL(l.url).hostname.endsWith('openalex.org')), false);
});

test('PMC full text is paginated without losing content or repeating downloads', async () => {
  const { fetcher, urls } = fake(() => Response.json(bio));
  const content = new ContentClient(fetcher);
  const first = await content.readPaper(work, 0, 10);
  assert.equal(first.text, parseBioC(bio).text.slice(0, 10));
  assert.equal(first.nextOffset, 10);
  const second = await content.readPaper(work, first.nextOffset!, 50000);
  assert.equal(first.text! + second.text!, parseBioC(bio).text);
  assert.equal(second.nextOffset, null);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].href, 'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/PMC1/unicode');
  assert.equal(first.license, 'CC BY');
  assert.equal(first.sha256, createHash('sha256').update(parseBioC(bio).text).digest('hex'));
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.links.length > 0);
});

test('an offset past the end returns no more text', async () => {
  const content = new ContentClient(fake(() => Response.json(bio)).fetcher);
  const result = await content.readPaper(work, 1_000_000, 10);
  assert.equal(result.text, '');
  assert.equal(result.nextOffset, null);
});

test('abstract-only and wrong-article responses are not mislabeled as full text', () => {
  assert.throws(() => parseBioC([{ documents: [{ id: 'PMC1', passages: [{ text: 'Only abstract', infons: { section_type: 'ABSTRACT' } }] }] }]), /no full-text body/);
  assert.throws(() => parseBioC(bio, 'PMC2'), /different article/);
});

test('a work without a PMCID returns candidate links without downloading', async () => {
  const { fetcher, urls } = fake(() => { throw new Error('No download expected'); });
  const result = await new ContentClient(fetcher).readPaper(noPmc, 0, 100);
  assert.equal(urls.length, 0);
  assert.equal(result.text, undefined);
  assert.equal(result.nextOffset, null);
  assert.equal(result.license, null);
  assert.equal(result.sha256, null);
  assert.ok(result.links.length > 0);
});

test('failed or unusable PMC responses fall back to candidate links', async () => {
  const responses: Array<() => Response> = [
    () => new Response('large', { headers: { 'content-length': String(13 * 1024 * 1024) } }),
    () => new Response('', { status: 404 }),
    () => new Response('[Error] : No result can be found.'),
    () => Response.json([{ documents: [{ ...bio[0].documents[0], id: 'PMC999', passages: [{ text: 'Body', infons: { section_type: 'INTRO' } }] }] }]),
  ];
  for (const respond of responses) {
    const result = await new ContentClient(fake(respond).fetcher).readPaper(work, 0, 100);
    assert.equal(result.text, undefined);
    assert.equal(result.nextOffset, null);
    assert.equal(result.sha256, null);
    assert.ok(result.links.length > 0);
  }
  const rejected = await new ContentClient(fake(() => { throw new TypeError('fetch failed'); }).fetcher).readPaper(work, 0, 100);
  assert.equal(rejected.text, undefined);
  assert.equal(rejected.sha256, null);
});

test('readPaper passes the caller signal to the PMC download', async () => {
  const seen: Array<AbortSignal | null | undefined> = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(init?.signal);
    throw init?.signal?.reason ?? new Error('no signal');
  }) as typeof fetch;
  const ac = new AbortController();
  ac.abort(new Error('ceiling'));
  const result = await new ContentClient(fetcher).readPaper(work, 0, 100, { signal: ac.signal });
  assert.equal(result.text, undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.aborted, true);
});
