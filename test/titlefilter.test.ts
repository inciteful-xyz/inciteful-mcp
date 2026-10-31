import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTitleMatch } from '../src/titlefilter.js';
import { TitleFilterError } from '../src/errors.js';

test('quotes_and_escapes', () => {
  assert.equal(buildTitleMatch({ all: ['covid-19'] }), 'search_text : ( ("covid-19") )');
  assert.equal(buildTitleMatch({ all: ['vagal "nerve"'] }), 'search_text : ( ("vagal ""nerve""") )');
  assert.equal(buildTitleMatch({ any: ['a:b', "cats'"] }), `search_text : ( ("a:b" OR "cats'") )`);
  assert.equal(buildTitleMatch({ all: ['  NEAR(x) AND y*  '] }), 'search_text : ( ("NEAR(x) AND y*") )');
});

test('single_column_filter_wraps_all_groups', () => {
  assert.equal(
    buildTitleMatch({ all: ['a', 'b'], any: ['c', 'd'], none: ['e'] }),
    'search_text : ( ("a" AND "b") AND ("c" OR "d") NOT ("e") )',
  );
  assert.equal(buildTitleMatch({ any: ['c', 'd'], none: ['e', 'f'] }), 'search_text : ( ("c" OR "d") NOT ("e" OR "f") )');
  assert.equal(buildTitleMatch({ all: ['a'], none: ['e'] }), 'search_text : ( ("a") NOT ("e") )');
  assert.equal(buildTitleMatch({ all: ['a', ' '], any: [] }), 'search_text : ( ("a") )');
});

test('none_only_throws', () => {
  assert.throws(() => buildTitleMatch({ none: ['e'] }),
    (e: unknown) => e instanceof TitleFilterError && e.message === 'title_none needs title_all or title_any');
  assert.throws(() => buildTitleMatch({ all: ['  '], none: ['e'] }), TitleFilterError);
});

test('empty_returns_null', () => {
  assert.equal(buildTitleMatch({}), null);
  assert.equal(buildTitleMatch({ all: [], any: [], none: [] }), null);
  assert.equal(buildTitleMatch({ all: ['', '   '], none: [' '] }), null);
});

test('limits_terms', () => {
  assert.equal(buildTitleMatch({ all: ['x'.repeat(100)] }), `search_text : ( ("${'x'.repeat(100)}") )`);
  assert.throws(() => buildTitleMatch({ all: ['x'.repeat(101)] }), TitleFilterError);
  // Length is counted after trimming.
  assert.ok(buildTitleMatch({ all: [` ${'x'.repeat(100)} `] }));
  const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
  assert.ok(buildTitleMatch({ all: twenty.slice(0, 10), any: twenty.slice(10, 15), none: twenty.slice(15) }));
  assert.throws(() => buildTitleMatch({ all: twenty.slice(0, 10), any: twenty.slice(10), none: ['extra'] }), TitleFilterError);
  // Empty terms are dropped before counting.
  assert.ok(buildTitleMatch({ all: [...twenty, '', ' '] }));
});

test('control_characters_are_stripped', () => {
  assert.equal(buildTitleMatch({ all: ['ner\u0000ve\u0007'] }), 'search_text : ( ("nerve") )');
  // Tabs and newlines between words become spaces, so the words stay apart.
  assert.equal(buildTitleMatch({ all: ['vagal\tnerve\n'] }), 'search_text : ( ("vagal nerve") )');
  assert.equal(buildTitleMatch({ all: ['\u0000\u001f'] }), null);
});

test('terms_without_letters_or_digits_are_dropped', () => {
  assert.equal(buildTitleMatch({ all: ['nerve', '-'] }), buildTitleMatch({ all: ['nerve'] }));
  assert.equal(buildTitleMatch({ all: ['nerve'], any: ['"', '...'], none: ['*'] }), 'search_text : ( ("nerve") )');
  assert.equal(buildTitleMatch({ any: ['é'] }), 'search_text : ( ("é") )');
  assert.equal(buildTitleMatch({ any: ['19'] }), 'search_text : ( ("19") )');
  // Every term dropped: the usual rules apply.
  assert.equal(buildTitleMatch({ all: ['-', '()'] }), null);
  assert.throws(() => buildTitleMatch({ all: ['-'], none: ['covid'] }),
    (e: unknown) => e instanceof TitleFilterError && e.message === 'title_none needs title_all or title_any');
});
