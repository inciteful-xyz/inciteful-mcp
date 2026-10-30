import { TitleFilterError } from './errors.js';

export const MAX_TERM_CHARS = 100;
export const MAX_TERMS = 20;

export type TitleFilter = { all?: string[]; any?: string[]; none?: string[] };

/** A literal FTS5 string: everything inside double quotes is text, with `"` written as `""`. */
const quote = (term: string) => `"${term.replace(/"/g, '""')}"`;

/**
 * Builds one FTS5 MATCH expression over `title_search.search_text` from structured terms, with a single
 * column filter around the whole expression. Every term is quoted, so no input is read as FTS5 syntax.
 * Returns null when no usable term is given.
 */
export function buildTitleMatch(f: TitleFilter): string | null {
  // Control characters are removed; tabs and newlines become spaces first, so the words they separate stay
  // apart. A term with no letter or digit would be an empty FTS5 phrase, so it is dropped.
  const clean = (terms: string[] | undefined) => (terms ?? [])
    .map(t => t.replace(/[\t\n\v\f\r]/g, ' ').replace(/\p{Cc}/gu, '').trim())
    .filter(t => /[\p{L}\p{N}]/u.test(t));
  const all = clean(f.all);
  const any = clean(f.any);
  const none = clean(f.none);
  const terms = [...all, ...any, ...none];
  if (!terms.length) return null;
  if (terms.length > MAX_TERMS) throw new TitleFilterError(`Title filters take at most ${MAX_TERMS} terms in total.`);
  if (terms.some(t => [...t].length > MAX_TERM_CHARS)) {
    throw new TitleFilterError(`Each title filter term can be at most ${MAX_TERM_CHARS} characters.`);
  }
  if (!all.length && !any.length) throw new TitleFilterError('title_none needs title_all or title_any');

  const group = (ts: string[], op: 'AND' | 'OR') => `(${ts.map(quote).join(` ${op} `)})`;
  const positive = [all.length ? group(all, 'AND') : null, any.length ? group(any, 'OR') : null]
    .filter((g): g is string => g !== null).join(' AND ');
  const expression = none.length ? `${positive} NOT ${group(none, 'OR')}` : positive;
  return `search_text : ( ${expression} )`;
}
