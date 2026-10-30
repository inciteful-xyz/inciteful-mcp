import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchApi, type Fetch, type Work } from '../src/api.js';
import { PaperContent, contentLinks, parseBioC, reconstructAbstract } from '../src/content.js';

const bio = [{ documents: [{ id: 'PMC1', infons: { license: 'CC BY' }, passages: [
  { text: 'A study', infons: { section_type: 'TITLE', 'article-id_pmid': '1' } },
  { text: 'An abstract.', infons: { section_type: 'ABSTRACT' } },
  { text: 'Introduction with actual body text.', infons: { section_type: 'INTRO' } },
  { text: 'Methods and results.', infons: { section_type: 'METHODS' } },
] }] }];

const work: Work = {
  id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/example', ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/1/' },
  best_oa_location: { pdf_url: 'https://repository.example/paper.pdf', landing_page_url: 'https://repository.example/paper', is_oa: true, license: 'cc-by', version: 'acceptedVersion', source: { display_name: 'Repository' } },
  locations: [{ pdf_url: 'https://repository.example/paper.pdf', is_oa: true }, { landing_page_url: 'https://publisher.example/paper', is_oa: false }],
  has_content: { grobid_xml: true, pdf: true },
};

function setup(data: Work = work, download?: Fetch) {
  const api = new ResearchApi(new URL('https://graph.test'), 1000, {}, async () => Response.json(data));
  return new PaperContent(api, download ?? (async () => Response.json(bio)));
}

test('reconstructs abstract positions and repeated tokens without relying on key order', () => {
  assert.equal(reconstructAbstract({ paper: [2], The: [0], describes: [3], new: [1, 4], methods: [5] }), 'The new paper describes new methods');
  assert.equal(reconstructAbstract(null), null);
  assert.throws(() => reconstructAbstract({ word: [1000000] }), /invalid/);
  assert.throws(() => reconstructAbstract({ word: [2] }), /incomplete/);
  assert.throws(() => reconstructAbstract({ a: [0], b: [0] }), /conflicting/);
});

test('full-text links rank OA copies, preserve provenance and deduplicate URLs', () => {
  const links = contentLinks(work);
  assert.equal(links[0].url, 'https://repository.example/paper.pdf');
  assert.equal(links[0].license, 'cc-by');
  assert.equal(links.filter(l => l.url.endsWith('/paper.pdf')).length, 1);
  assert.ok(links.some(l => l.is_oa === false));
});

test('full-text links never point at the paid OpenAlex content archive', () => {
  const links = contentLinks({ ...work, content_urls: { pdf: 'https://content.openalex.org/works/W1.pdf' } });
  assert.deepEqual(links.filter(l => l.url.includes('content.openalex.org')), []);
});

test('OpenAlex abstract is returned without a content download', async () => {
  const content = setup({ ...work, abstract_inverted_index: { My: [0], abstract: [1] } }, async () => { throw new Error('Must not download'); });
  assert.equal((await content.abstract('W1')).text, 'My abstract');
});

test('missing OpenAlex abstract falls back to PubMed BioC', async () => {
  let url = '';
  const content = setup(work, async input => { url = String(input); return Response.json(bio); });
  const result = await content.abstract('pmid:1');
  assert.equal(result.text, 'An abstract.');
  assert.match(url, /pubmed\.cgi\/BioC_json\/1\/unicode/);
});

test('PMC full text is paginated without losing content or repeating downloads', async () => {
  let calls = 0;
  const content = setup(work, async () => { calls++; return Response.json(bio); });
  const first = await content.fullText('PMC1', 0, 10);
  assert.equal(first.status, 'available');
  if (!('next_offset' in first)) throw new Error('Expected page');
  const second = await content.fullText('PMC1', first.next_offset!, 50000);
  assert.equal(first.text + second.text, parseBioC(bio).text);
  assert.equal(calls, 1);
  assert.equal(first.license, 'CC BY');
  if (!('content_sha256' in second)) throw new Error('Expected page');
  assert.equal(first.content_sha256, second.content_sha256);
});

test('abstract-only and wrong-article responses are not mislabeled as full text', () => {
  assert.throws(() => parseBioC([{ documents: [{ id: 'PMC1', passages: [{ text: 'Only abstract', infons: { section_type: 'ABSTRACT' } }] }] }]), /no full-text body/);
  assert.throws(() => parseBioC(bio, false, 'PMC2'), /different article/);
});

test('a work without PMC text returns candidate links rather than pretending to retrieve text', async () => {
  const content = setup({ ...work, ids: {} }, async () => { throw new Error('No download expected'); });
  const result = await content.fullText('W1', 0, 100);
  assert.equal(result.status, 'not_retrieved');
  assert.ok(result.links.length > 0);
});

test('downloads are bounded', async () => {
  const content = setup(work, async () => new Response('large', { headers: { 'content-length': String(13 * 1024 * 1024) } }));
  const result = await content.fullText('W1', 0, 100);
  assert.equal(result.status, 'not_retrieved');
  assert.match(JSON.stringify(result), /12 MiB/);
});
