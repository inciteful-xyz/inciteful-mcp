import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { analyses, analysisSql, methodFor, type Analysis } from '../src/templates.js';
import { buildTitleMatch } from '../src/titlefilter.js';

const YEAR = new Date().getUTCFullYear();
const sections = new Map<string, string>();
{
  const sql = readFileSync(new URL('./fixtures/graph-schema.sql', import.meta.url), 'utf8');
  for (const part of sql.split(/^-- @section /m).slice(1)) {
    const nl = part.indexOf('\n');
    sections.set(part.slice(0, nl).trim(), part.slice(nl + 1));
  }
}

type Paper = {
  id: string; title: string; year: number; journal: string; distance: number;
  pr: number; aa: number | null; cocite: number | null; citing: number; citedBy: number;
  authors: Array<[authorId: string, name: string, affiliation: string, affiliationId: string]>;
};

/** Single seed: W1 at distance 0. Multiple: W0 at 0 (as the loader writes it), seeds W1 and W6 at 1. */
function graph(multiple: boolean): DatabaseSync {
  const d = (single: number) => (multiple ? single + 1 : single);
  const papers: Paper[] = [
    { id: 'W1', title: 'Seed paper on the vagus nerve', year: YEAR - 5, journal: 'Seed Journal', distance: d(0),
      pr: 0.9, aa: null, cocite: null, citing: 50, citedBy: 50, authors: [['A1', 'Seed Author', 'Seed Inst', 'I1']] },
    { id: 'W2', title: 'COVID-19: vagal "nerve" stimulation', year: YEAR, journal: 'Neuro Journal', distance: d(1),
      pr: 0.3, aa: 0.5, cocite: 0.2, citing: 15, citedBy: 4,
      authors: [['A2', 'Ada Covid', 'Covid Inst', 'I2'], ['A3', 'Bo Covid', '', '']] },
    { id: 'W3', title: "Cats' study of nerve growth", year: YEAR - 1, journal: 'Vet Journal', distance: d(1),
      pr: 0.2, aa: 0.4, cocite: 0.1, citing: 12, citedBy: 3, authors: [['A4', 'Cat Person', 'Vet Inst', 'I3']] },
    { id: 'W4', title: 'An older review of nerve stimulation', year: YEAR - 20, journal: 'Review Journal', distance: d(2),
      pr: 0.1, aa: 0.1, cocite: null, citing: 40, citedBy: 9, authors: [['A5', 'Old Reviewer', 'Old Inst', 'I4']] },
    { id: 'W5', title: 'Distant paper about dogs', year: YEAR - 2, journal: 'Dog Journal', distance: d(2),
      pr: 0.05, aa: null, cocite: null, citing: 1, citedBy: 1, authors: [['A6', 'Dog Person', 'Dog Inst', 'I5']] },
  ];
  if (multiple) {
    papers.push({ id: 'W6', title: 'Second seed on nerve stimulation', year: YEAR - 3, journal: 'Seed Journal', distance: 1,
      pr: 0.8, aa: null, cocite: null, citing: 30, citedBy: 30, authors: [['A7', 'Other Seed', 'Seed Inst', 'I1']] });
    papers.push({ id: 'W0', title: 'Temp Paper', year: 1900, journal: 'Temp Source', distance: 0,
      pr: 0.95, aa: null, cocite: null, citing: 2, citedBy: 0, authors: [] });
    // Nothing cites W0, so cocite is NULL everywhere in a multi-seed graph.
    for (const p of papers) p.cocite = null;
  }

  const db = new DatabaseSync(':memory:');
  db.exec(sections.get('init')!);
  const paper = db.prepare(`INSERT INTO papers (paper_id, doi, authors, num_authors, title, published_year, journal)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const author = db.prepare(`INSERT OR IGNORE INTO authors
    (paper_id, author_id, name, sequence, affiliation, affiliation_id, ror, published_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of papers) {
    paper.run(p.id, `10.1/${p.id}`, JSON.stringify(p.authors.map(([id, name]) => ({ author_id: id, name }))),
      p.authors.length, p.title, p.year, p.journal);
    p.authors.forEach(([id, name, aff, affId], i) => author.run(p.id, id, name, i, aff, affId || null, null, p.year));
  }
  const meta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  for (const [k, v] of [['graph_depth', '2'], ['graph_snapshot', '2026-10-15'], ['prune_threshold', '10000'],
    ['highly_cited_not_expanded', '0'], ['seeds_not_expanded', '0']]) meta.run(k, v);
  db.exec(sections.get('finalize_base')!);
  const analysis = db.prepare(`UPDATE papers SET num_citing = ?, num_cited_by = ?, distance = ?, page_rank = ?,
    adamic_adar = ?, cocite = ? WHERE paper_id = ?`);
  for (const p of papers) analysis.run(p.citing, p.citedBy, p.distance, p.pr, p.aa, p.cocite, p.id);
  db.exec(sections.get('partial_page_rank')!);
  db.exec(sections.get('finalize_analysis')!);
  return db;
}

const dbs = { single: graph(false), multiple: graph(true) };
const run = (multiple: boolean, a: Analysis, o: Partial<Parameters<typeof analysisSql>[2]> = {}) =>
  (multiple ? dbs.multiple : dbs.single).prepare(analysisSql(a, multiple, { titleMatch: null, limit: 10, ...o })).all();
const paperAnalyses = ['similar', 'important', 'reviews', 'recent'] as const;
const ids = (rows: Record<string, unknown>[]) => rows.map(r => r.paper_id);

test('every analysis x {single, multiple} x {no filter, filter} runs on the real schema', () => {
  assert.deepEqual([...analyses], ['similar', 'important', 'reviews', 'recent', 'authors', 'journals', 'institutions']);
  const filters = [null, buildTitleMatch({ all: ['covid-19'] }), buildTitleMatch({ any: ["cats'", 'nerve'], none: ['dogs'] })];
  let runs = 0;
  for (const multiple of [false, true]) for (const a of analyses) for (const titleMatch of filters) {
    const rows = run(multiple, a, { titleMatch });
    runs++;
    if ((paperAnalyses as readonly string[]).includes(a)) {
      for (const r of rows) assert.ok(!['W0', 'W1', 'W6'].includes(r.paper_id as string), `${a} ${multiple} returned a seed`);
    }
    if (a === 'important' && titleMatch === null) assert.ok(rows.length > 0, `important ${multiple} returned nothing`);
  }
  assert.equal(runs, 2 * 7 * 3);
});

test('title_filter_matches_expected_rows', () => {
  for (const multiple of [false, true]) {
    const covid = buildTitleMatch({ all: ['covid-19'] });
    assert.deepEqual(ids(run(multiple, 'important', { titleMatch: covid })), ['W2']);
    assert.deepEqual(ids(run(multiple, 'similar', { titleMatch: covid })), ['W2']);
    assert.deepEqual(run(multiple, 'authors', { titleMatch: covid }).map(r => r.author_id).sort(), ['A2', 'A3']);
    assert.deepEqual(run(multiple, 'journals', { titleMatch: covid }).map(r => r.journal), ['Neuro Journal']);
    assert.deepEqual(run(multiple, 'institutions', { titleMatch: covid }).map(r => r.affiliation), ['Covid Inst']);

    // An apostrophe in a term goes through SQL quoting and FTS5 quoting.
    const cats = buildTitleMatch({ any: ["cats'"] });
    assert.deepEqual(ids(run(multiple, 'important', { titleMatch: cats })), ['W3']);

    const nerve = ids(run(multiple, 'important', { titleMatch: buildTitleMatch({ all: ['nerve'] }) }));
    assert.deepEqual(nerve.sort(), ['W2', 'W3', 'W4']);
    const noCovid = ids(run(multiple, 'important', { titleMatch: buildTitleMatch({ all: ['nerve'], none: ['covid-19'] }) }));
    assert.deepEqual(noCovid.sort(), ['W3', 'W4']);
    // The column filter keeps terms off the indexed paper_id column: no title contains "W4".
    assert.deepEqual(run(multiple, 'important', { titleMatch: buildTitleMatch({ all: ['W4'] }) }), []);
    // Quotes and colons inside terms run without error.
    run(multiple, 'important', { titleMatch: buildTitleMatch({ all: ['vagal "nerve"', 'a:b'] }) });
  }
});

test('limit_and_years_applied', () => {
  for (const multiple of [false, true]) {
    assert.equal(run(multiple, 'important', { limit: 2 }).length, 2);
    assert.deepEqual(ids(run(multiple, 'important', { limit: 1 })), ['W2']);
    assert.deepEqual(ids(run(multiple, 'important', { yearFrom: YEAR - 1 })).sort(), ['W2', 'W3']);
    assert.deepEqual(ids(run(multiple, 'important', { yearTo: YEAR - 2 })).sort(), ['W4', 'W5']);
    assert.deepEqual(ids(run(multiple, 'important', { yearFrom: YEAR - 1, yearTo: YEAR - 1 })), ['W3']);
    assert.equal(run(multiple, 'authors', { limit: 1 }).length, 1);
    assert.equal(run(multiple, 'journals', { limit: 1 }).length, 1);
    assert.equal(run(multiple, 'institutions', { limit: 1 }).length, 1);
  }
  // recent: the last three years only.
  assert.deepEqual(ids(run(false, 'recent')).sort(), ['W2', 'W3', 'W5']);
  assert.throws(() => analysisSql('important', false, { titleMatch: null, limit: 1.5 }));
  assert.throws(() => analysisSql('important', false, { titleMatch: null, limit: 10, yearFrom: Number.NaN }));
});

test('multi_seed_uses_distance_2', () => {
  // Single seed: similar papers come from every distance (W4 is at 2 with a positive Adamic/Adar).
  assert.deepEqual(ids(run(false, 'similar')), ['W2', 'W3', 'W4']);
  assert.deepEqual(ids(run(false, 'reviews')).sort(), ['W2', 'W3', 'W4', 'W5']);
  // Multi-seed: only distance 2 (the seeds' direct neighbours). W4 moves to distance 3 and drops out
  // although its Adamic/Adar is still positive.
  const multiSimilar = run(true, 'similar');
  assert.deepEqual(ids(multiSimilar), ['W2', 'W3']);
  assert.ok(multiSimilar.every(r => r.distance === 2));
  const multiReviews = run(true, 'reviews');
  assert.deepEqual(ids(multiReviews).sort(), ['W2', 'W3']);
  assert.ok(multiReviews.every(r => r.distance === 2));
  // Rankings by influence still cover farther papers (W4 and W5 are at distance 3 in the multi-seed graph).
  assert.deepEqual(ids(run(true, 'important')).sort(), ['W2', 'W3', 'W4', 'W5']);
  assert.ok(analysisSql('similar', true, { titleMatch: null, limit: 5 }).includes('p.distance = 2'));
  assert.ok(!analysisSql('similar', false, { titleMatch: null, limit: 5 }).includes('p.distance = 2'));
});

test('title filter SQL uses the title_search table function with quotes doubled', () => {
  const sql = analysisSql('important', false, { titleMatch: `search_text : ( ("cats'") )`, limit: 5 });
  assert.ok(sql.includes(`p.paper_id IN (SELECT paper_id FROM title_search('search_text : ( ("cats''") )'))`));
  assert.ok(!/LIKE '%/.test(sql));
});

test('methodFor names each method', () => {
  assert.equal(methodFor('important', true), 'page_rank (local; multi-seed graph rooted at a synthetic paper citing all seeds)');
  assert.equal(methodFor('references', false), 'OpenAlex cited_by:/cites: filter, sorted by global cited_by_count');
  assert.equal(methodFor('citations', true), 'OpenAlex cited_by:/cites: filter, sorted by global cited_by_count');
  assert.equal(methodFor('fast_similar', false), 'fast similarity: Adamic/Adar + Salton, depth 1');
  assert.equal(methodFor('fast_similar', true), 'fast similarity: Adamic/Adar, depth 1 (multi-seed)');
  for (const a of analyses) for (const multiple of [false, true]) assert.ok(methodFor(a, multiple).length > 0);
});
