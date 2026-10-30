import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toBibtex, toRis } from '../src/citations.js';
import type { Work } from '../src/openalex.js';

function work(over: Partial<Work> & { sourceType?: string | null; venue?: string | null } = {}): Work {
  const { sourceType = 'journal', venue = 'Nature', ...rest } = over;
  return {
    id: 'W1', doi: 'https://doi.org/10.1038/nature14539', title: 'Deep learning', publication_year: 2015, type: 'article',
    is_retracted: false, cited_by_count: 1, abstract: null, ids: { pmid: null, pmcid: null },
    authorships: [
      { author_position: 'first', author: { id: null, display_name: 'Yann LeCun', orcid: null }, institutions: [] },
      { author_position: 'last', author: { id: null, display_name: 'Geoffrey Hinton', orcid: null }, institutions: [] },
    ],
    primary_location: { is_oa: false, landing_page_url: null, pdf_url: null, license: null, version: null,
      source: venue === null ? null : { display_name: venue, type: sourceType } },
    best_oa_location: null, locations: [],
    biblio: { volume: '521', issue: '7553', first_page: '436', last_page: '444' },
    open_access: { is_oa: false, oa_url: null },
    ...rest,
  };
}

const bibType = (w: Work) => toBibtex([w]).match(/^@(\w+)\{/)?.[1];
const risType = (w: Work) => toRis([w]).match(/^TY {2}- (\w+)\r\n/)?.[1];

test('types_map', () => {
  const cases: Array<[Work, string, string]> = [
    [work({ type: 'article' }), 'article', 'JOUR'],
    [work({ type: 'review' }), 'article', 'JOUR'],
    [work({ type: 'letter' }), 'article', 'JOUR'],
    [work({ type: 'editorial' }), 'article', 'JOUR'],
    [work({ type: 'article', sourceType: 'conference' }), 'inproceedings', 'CONF'],
    [work({ type: 'book-chapter' }), 'incollection', 'CHAP'],
    [work({ type: 'book' }), 'book', 'BOOK'],
    [work({ type: 'preprint' }), 'misc', 'UNPB'],
    [work({ type: 'dissertation' }), 'phdthesis', 'THES'],
    [work({ type: 'report' }), 'techreport', 'RPRT'],
    [work({ type: 'dataset' }), 'misc', 'DATA'],
    [work({ type: 'peer-review' }), 'misc', 'GEN'],
    [work({ type: null }), 'misc', 'GEN'],
  ];
  for (const [w, bib, ris] of cases) {
    assert.equal(bibType(w), bib, `${w.type} ${w.primary_location?.source?.type}`);
    assert.equal(risType(w), ris, `${w.type} ${w.primary_location?.source?.type}`);
  }
  assert.match(toBibtex([work({ type: 'preprint' })]), /^ {2}note = \{Preprint\},$/m);
  assert.doesNotMatch(toBibtex([work({ type: 'dataset' })]), /note = /);
  // The venue goes in the field each entry type expects.
  assert.match(toBibtex([work()]), /^ {2}journal = \{Nature\},$/m);
  assert.match(toBibtex([work({ type: 'article', sourceType: 'conference', venue: 'NeurIPS' })]), /^ {2}booktitle = \{NeurIPS\},$/m);
});

test('bibtex_escapes_specials', () => {
  const out = toBibtex([work({ title: 'A\\B {C} 50% R&D $5 #1 snake_case ~x ^y', venue: 'J & K' })]);
  assert.match(out, /^ {2}title = \{A\\textbackslash\{\}B \\\{C\\\} 50\\% R\\&D \\\$5 \\#1 snake\\_case \\textasciitilde\{\}x \\textasciicircum\{\}y\},$/m);
  assert.match(out, /^ {2}journal = \{J \\& K\},$/m);
});

test('pages_double_dash_and_ris_SP_EP', () => {
  const bib = toBibtex([work()]);
  assert.match(bib, /^ {2}pages = \{436--444\},$/m);
  assert.match(bib, /^ {2}volume = \{521\},$/m);
  assert.match(bib, /^ {2}number = \{7553\},$/m);
  assert.match(bib, /^ {2}year = \{2015\},$/m);
  const ris = toRis([work()]);
  for (const line of ['SP  - 436', 'EP  - 444', 'VL  - 521', 'IS  - 7553', 'PY  - 2015', 'T2  - Nature']) {
    assert.ok(ris.includes(`\r\n${line}\r\n`), line);
  }
  const firstOnly = work({ biblio: { volume: null, issue: null, first_page: 'e123', last_page: null } });
  assert.match(toBibtex([firstOnly]), /^ {2}pages = \{e123\},$/m);
  assert.ok(toRis([firstOnly]).includes('\r\nSP  - e123\r\n'));
  assert.ok(!toRis([firstOnly]).includes('EP  -'));
  assert.ok(!toBibtex([firstOnly]).includes('volume'));
});

test('bare_doi', () => {
  assert.match(toBibtex([work()]), /^ {2}doi = \{10\.1038\/nature14539\},$/m);
  assert.ok(toRis([work()]).includes('\r\nDO  - 10.1038/nature14539\r\n'));
  assert.ok(!toBibtex([work()]).includes('doi.org'));
  assert.ok(!toRis([work()]).includes('doi.org'));
  // Underscores in a DOI are escaped like any other BibTeX value.
  assert.match(toBibtex([work({ doi: 'https://doi.org/10.1/a_b' })]), /^ {2}doi = \{10\.1\/a\\_b\},$/m);
  assert.doesNotMatch(toBibtex([work({ doi: null })]), /doi = /);
});

test('ris_line_format_and_ER', () => {
  const ris = toRis([work(), work({ id: 'W2', title: 'Second\nline' })]);
  assert.ok(ris.endsWith('ER  - \r\n'));
  assert.ok(!/(?<!\r)\n/.test(ris), 'only CRLF line endings');
  const lines = ris.split('\r\n').filter(l => l !== '');
  for (const line of lines) assert.match(line, /^[A-Z][A-Z0-9] {2}- /);
  assert.equal(lines.filter(l => l.startsWith('TY  - ')).length, 2);
  assert.equal(lines.filter(l => l === 'ER  - ').length, 2);
  assert.deepEqual(lines.filter(l => l.startsWith('AU  - ')).slice(0, 2), ['AU  - Yann LeCun', 'AU  - Geoffrey Hinton']);
  assert.ok(lines.includes('TI  - Deep learning'));
  assert.ok(lines.includes('TI  - Second line'), 'newlines inside a value are collapsed');
  assert.equal(lines[0], 'TY  - JOUR');
});

test('keys_ascii_and_deduped', () => {
  const out = toBibtex([
    work({ title: 'Deep learning' }),
    work({ id: 'W2', title: 'Deep, learning again' }),
    work({ id: 'W3', title: 'Deep thoughts' }),
    work({ id: 'W4', title: '«Ölçek» études', publication_year: 2020,
      authorships: [{ author_position: 'first', author: { id: null, display_name: 'José Müller-Ñúñez', orcid: null }, institutions: [] }] }),
    work({ id: 'W5', title: null, publication_year: null, authorships: [] }),
  ]);
  const keys = [...out.matchAll(/^@\w+\{([^,]*),$/gm)].map(m => m[1]);
  assert.deepEqual(keys, ['LeCun2015Deep', 'LeCun2015Deepa', 'LeCun2015Deepb', 'MullerNunez2020Olcek', 'W5']);
  for (const k of keys) assert.match(k, /^[A-Za-z0-9]+$/);
  assert.match(out, /^ {2}author = \{Yann LeCun and Geoffrey Hinton\},$/m);
});

test('no_inciteful_keyword', () => {
  const all = toBibtex([work()]) + toRis([work()]);
  assert.ok(!/inciteful/i.test(all));
  assert.ok(!/keywords|^KW {2}-/m.test(all));
});
