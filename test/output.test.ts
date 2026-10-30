import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capResult } from '../src/output.js';

const HINT = 'Output truncated; narrow the request (lower limit, fewer seeds, a title filter).';
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const result = (rows: unknown[]) => ({
  rows,
  seeds: ['W1', 'W2'],
  provenance: { tool: 'explore_citation_network' },
  diagnostics: { advisories: ['Retraction and preprint flags: use get_papers.'], unresolved_seeds: [] },
});

test('under_cap_untouched', () => {
  const value = result([{ id: 1 }, { id: 2 }]);
  const out = capResult(value, 10_000);
  assert.deepEqual(out, { ...value, truncated: false });
  assert.deepEqual(capResult(value).truncated, false);
});

test('over_cap_trims_rows_only_and_flags', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, title: 'x'.repeat(90) }));
  const value = result(rows);
  const out = capResult(value, 2_000);
  assert.equal(out.truncated, true);
  assert.ok(out.rows.length > 0 && out.rows.length < 100);
  assert.deepEqual(out.rows, rows.slice(0, out.rows.length), 'trimmed from the end');
  assert.ok(bytes(out) <= 2_000);
  // One more row would not have fitted.
  assert.ok(bytes({ ...out, rows: rows.slice(0, out.rows.length + 1) }) > 2_000);
  assert.deepEqual(out.seeds, value.seeds);
  assert.deepEqual(out.provenance, value.provenance);
  assert.deepEqual(out.diagnostics.advisories, ['Retraction and preprint flags: use get_papers.', HINT]);
  assert.equal(value.rows.length, 100, 'input not mutated');
  assert.equal(value.diagnostics.advisories.length, 1, 'input diagnostics not mutated');
});

test('single_huge_row_gives_zero_rows', () => {
  const out = capResult(result([{ text: 'x'.repeat(70_000) }]));
  assert.deepEqual(out.rows, []);
  assert.equal(out.truncated, true);
  assert.ok(out.diagnostics.advisories.includes(HINT));
});

test('a result without diagnostics gets the hint in a new diagnostics block', () => {
  const out = capResult({ rows: [{ text: 'x'.repeat(500) }] }, 100) as { rows: unknown[]; truncated: boolean; diagnostics?: { advisories: string[] } };
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.diagnostics, { advisories: [HINT] });
});

test('measures_bytes_not_chars', () => {
  // 30 rows of 1,000 three-byte characters: ~30k chars, ~90k bytes.
  const rows = Array.from({ length: 30 }, () => ({ title: '漢'.repeat(1_000) }));
  assert.ok(JSON.stringify(result(rows)).length < 60_000);
  const out = capResult(result(rows));
  assert.equal(out.truncated, true);
  assert.ok(bytes(out) <= 60_000);
  assert.ok(out.rows.length < 30 && out.rows.length >= 19);
});
