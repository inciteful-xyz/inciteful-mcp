import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { reviewOptionsSchema, reviewQuery, reviewSections } from '../src/review.js';

function fixture(multiple: boolean) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE papers (paper_id TEXT, doi TEXT, authors TEXT, title TEXT, journal TEXT,
    published_year INTEGER, num_cited_by INTEGER, num_citing INTEGER, num_authors INTEGER,
    distance INTEGER, page_rank REAL, adamic_adar REAL, cocite REAL);
    CREATE TABLE authors (paper_id TEXT, author_id TEXT, name TEXT, sequence INTEGER,
    partial_page_rank REAL, published_year INTEGER, affiliation TEXT, affiliation_id TEXT);`);
  const insert = db.prepare('INSERT INTO papers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const year = new Date().getUTCFullYear();
  insert.run('seed', '', '[]', 'Seed', 'Journal', year, 100, 100, 1, multiple ? 1 : 0, 10, 10, 10);
  if (multiple) insert.run('virtual', '', '[]', 'Virtual', '', year, 0, 0, 0, 0, 20, 20, 20);
  insert.run('a', '10.1234/a', '[]', "O'Brien 100%_ study", 'Journal', year, 10, 20, 1, multiple ? 2 : 1, 0.8, null, 1);
  insert.run('b', '10.1234/b', '[]', 'Older paper', 'Journal', year - 20, 20, 30, 1, multiple ? 2 : 1, 0.9, 0.2, 0);
  insert.run('far', '10.1234/c', '[]', 'Far paper', 'Other', year, 5, 15, 1, multiple ? 3 : 2, 0.1, 0.9, 0.9);
  const author = db.prepare('INSERT INTO authors VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  author.run('a', 'A1', 'Same Name', 0, 0.8, year, 'Institute', 'I1');
  author.run('b', 'A2', 'Same Name', 0, 0.9, year - 20, 'Institute', 'I1');
  return db;
}

test('all dashboard queries execute for single and multiple seeds and exclude seeds from rankings', () => {
  for (const multiple of [false, true]) {
    const db = fixture(multiple);
    try {
      for (const section of reviewSections) {
        const rows = db.prepare(reviewQuery(section, multiple, reviewOptionsSchema.parse({ limit: 2 }))).all();
        if (section === 'similar_paper_graph') assert.ok(rows.some(r => r.paper_id === 'seed'));
        else {
          assert.ok(rows.length <= 2);
          assert.ok(rows.every(r => r.paper_id !== 'seed' && r.paper_id !== 'virtual'), section);
        }
      }
    } finally { db.close(); }
  }
});

test('multi-seed similarity and review queries restrict distance 2; influence includes farther papers', () => {
  const db = fixture(true);
  try {
    const options = reviewOptionsSchema.parse({ limit: 10 });
    for (const section of ['similar_papers', 'review_papers'] as const) {
      const rows = db.prepare(reviewQuery(section, true, options)).all();
      assert.ok(rows.every(r => r.distance === 2));
      assert.ok(rows.some(r => r.paper_id === 'a'), 'co-citation-only papers remain eligible');
    }
    assert.ok(db.prepare(reviewQuery('important_papers', true, options)).all().some(r => r.paper_id === 'far'));
  } finally { db.close(); }
});

test('year and literal title filters handle quotes and wildcard characters', () => {
  const db = fixture(false);
  try {
    const options = reviewOptionsSchema.parse({ title_contains: "O'Brien 100%_", year_from: new Date().getUTCFullYear() });
    const rows = db.prepare(reviewQuery('similar_papers', false, options)).all();
    assert.deepEqual(rows.map(r => r.paper_id), ['a']);
    const attack = reviewOptionsSchema.parse({ title_contains: "' OR 1=1 --" });
    assert.equal(db.prepare(reviewQuery('similar_papers', false, attack)).all().length, 0);
  } finally { db.close(); }
});

test('authors with the same name remain separate, and upcoming authors use filtered graph years', () => {
  const db = fixture(false);
  try {
    const options = reviewOptionsSchema.parse({});
    assert.equal(db.prepare(reviewQuery('top_authors', false, options)).all().length, 2);
    assert.deepEqual(db.prepare(reviewQuery('upcoming_authors', false, options)).all().map(r => r.author_id), ['A1']);
  } finally { db.close(); }
});
