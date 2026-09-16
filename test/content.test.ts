import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchApi, type Fetch, type Work } from '../src/api.js';
import { PaperContent, contentLinks, extractTei, parseBioC, reconstructAbstract } from '../src/content.js';

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

function setup(data: Work = work, download?: Fetch, env: NodeJS.ProcessEnv = {}) {
  const api = new ResearchApi({}, async () => Response.json(data));
  return new PaperContent(api, env, download ?? (async () => Response.json(bio)));
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
  assert.ok(links.find(l => l.format === 'tei_xml')?.requires_api_key);
});

test('metadata cannot redirect archive credentials to an arbitrary host', async () => {
  const urls: URL[] = [];
  const content = setup({ ...work, ids: {}, content_urls: { grobid_xml: 'https://attacker.example/steal?api_key=secret' } }, async input => {
    urls.push(new URL(String(input)));
    return new Response('<TEI><text><body><p>Article text.</p></body></text></TEI>');
  }, { OPENALEX_API_KEY: 'secret' });
  const result = await content.fullText('W1', 'openalex', 0, 1000);
  assert.equal(urls[0].hostname, 'content.openalex.org');
  assert.equal(urls[0].searchParams.get('api_key'), 'secret');
  assert.equal(result.status, 'available');
  assert.doesNotMatch(JSON.stringify(result), /secret|attacker/);
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
  const first = await content.fullText('PMC1', 'auto', 0, 10);
  assert.equal(first.status, 'available');
  if (!('next_offset' in first)) throw new Error('Expected page');
  const second = await content.fullText('PMC1', 'auto', first.next_offset!, 50000);
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

test('TEI extraction preserves inline order and paragraph structure, and rejects HTML/DTD', () => {
  assert.equal(extractTei('<TEI><text><body><head>Results</head><p>First <hi>important</hi> result &amp; next.</p><p>Second.</p></body></text></TEI>'), 'Results\n\nFirst important result & next.\n\nSecond.');
  assert.throws(() => extractTei('<html><body>Login</body></html>'), /TEI/);
  assert.throws(() => extractTei('<!DOCTYPE x [<!ENTITY x "evil">]><TEI/>'), /unsupported/);
});

test('missing archive key returns candidate links rather than pretending to retrieve text', async () => {
  const content = setup({ ...work, ids: {} }, async () => { throw new Error('No download expected'); });
  const result = await content.fullText('W1', 'auto', 0, 100);
  assert.equal(result.status, 'not_retrieved');
  assert.ok(result.links.length > 0);
  assert.match(JSON.stringify(result), /OPENALEX_API_KEY/);
});

test('downloads are bounded and errors never expose request credentials', async () => {
  const content = setup({ ...work, ids: {} }, async () => new Response('large', { headers: { 'content-length': String(13 * 1024 * 1024) } }), { OPENALEX_API_KEY: 'private-secret' });
  const result = await content.fullText('W1', 'openalex', 0, 100);
  assert.equal(result.status, 'not_retrieved');
  assert.match(JSON.stringify(result), /12 MiB/);
  assert.doesNotMatch(JSON.stringify(result), /private-secret/);
});
