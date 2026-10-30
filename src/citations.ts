import type { Work } from './openalex.js';

type Kind = { bib: string; ris: string; preprint?: true };

function kindOf(w: Work): Kind {
  switch (w.type) {
    case 'article':
      return w.primary_location?.source?.type === 'conference' ? { bib: 'inproceedings', ris: 'CONF' } : { bib: 'article', ris: 'JOUR' };
    case 'review':
    case 'letter':
    case 'editorial':
      return { bib: 'article', ris: 'JOUR' };
    case 'book-chapter': return { bib: 'incollection', ris: 'CHAP' };
    case 'book': return { bib: 'book', ris: 'BOOK' };
    case 'preprint': return { bib: 'misc', ris: 'UNPB', preprint: true };
    case 'dissertation': return { bib: 'phdthesis', ris: 'THES' };
    case 'report': return { bib: 'techreport', ris: 'RPRT' };
    case 'dataset': return { bib: 'misc', ris: 'DATA' };
    default: return { bib: 'misc', ris: 'GEN' };
  }
}

/** The BibTeX field each entry type expects the venue in. */
const VENUE_FIELD: Record<string, string> = {
  article: 'journal', inproceedings: 'booktitle', incollection: 'booktitle', book: 'publisher',
  phdthesis: 'school', techreport: 'institution', misc: 'howpublished',
};

/** One line, trimmed; null when empty. */
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
};

const bareDoi = (doi: string | null) => clean(doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ''));
const authors = (w: Work) => w.authorships.map(a => clean(a.author.display_name)).filter((n): n is string => n !== null);
const venue = (w: Work) => clean(w.primary_location?.source?.display_name);

const BIB_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&', '$': '\\$', '#': '\\#', '_': '\\_',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};
const bibEscape = (s: string) => s.replace(/[\\{}%&$#_~^]/g, c => BIB_ESCAPES[c]!);
/** An escaped author name. A name containing the word "and" is braced, so BibTeX keeps it as one author. */
const bibAuthor = (name: string) => (/\band\b/i.test(name) ? `{${bibEscape(name)}}` : bibEscape(name));

/** ASCII letters and digits only: accents are dropped from their base letters, everything else is removed. */
const ascii = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '');

function baseKey(w: Work): string {
  const last = authors(w)[0]?.split(' ').at(-1) ?? '';
  const word = (w.title ?? '').split(/\s+/).map(ascii).find(x => x !== '') ?? '';
  return ascii(last) + (w.publication_year ?? '') + word || ascii(w.id);
}

/** Suffixes after the first use of a key: a, b, ..., z, aa, ab, ... */
function suffix(n: number): string {
  let s = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(97 + (i % 26)) + s;
  return s;
}

function keys(works: Work[]): string[] {
  const used = new Set<string>();
  return works.map(w => {
    const base = baseKey(w);
    let key = base;
    for (let n = 0; used.has(key); n++) key = base + suffix(n);
    used.add(key);
    return key;
  });
}

export function toBibtex(works: Work[]): string {
  const ks = keys(works);
  return works.map((w, i) => {
    const kind = kindOf(w);
    const first = clean(w.biblio.first_page);
    const last = clean(w.biblio.last_page);
    const fields: Array<[string, string | null]> = [
      ['title', clean(w.title)],
      ['author', authors(w).map(bibAuthor).join(' and ') || null],
      [VENUE_FIELD[kind.bib]!, venue(w)],
      ['year', w.publication_year === null ? null : String(w.publication_year)],
      ['volume', clean(w.biblio.volume)],
      ['number', clean(w.biblio.issue)],
      ['pages', first && last && first !== last ? `${first}--${last}` : first ?? last],
      ['doi', bareDoi(w.doi)],
      ['note', kind.preprint ? 'Preprint' : null],
    ];
    // Author names are escaped in bibAuthor, so their grouping braces survive.
    const body = fields.filter((f): f is [string, string] => f[1] !== null)
      .map(([name, value]) => `  ${name} = {${name === 'author' ? value : bibEscape(value)}},\n`).join('');
    return `@${kind.bib}{${ks[i]},\n${body}}\n`;
  }).join('\n');
}

export function toRis(works: Work[]): string {
  return works.map(w => {
    const lines: Array<[string, string | null]> = [
      ['TY', kindOf(w).ris],
      ...authors(w).map((a): [string, string] => ['AU', a]),
      ['TI', clean(w.title)],
      ['T2', venue(w)],
      ['PY', w.publication_year === null ? null : String(w.publication_year)],
      ['VL', clean(w.biblio.volume)],
      ['IS', clean(w.biblio.issue)],
      ['SP', clean(w.biblio.first_page)],
      ['EP', clean(w.biblio.last_page)],
      ['DO', bareDoi(w.doi)],
    ];
    return lines.filter((l): l is [string, string] => l[1] !== null)
      .map(([tag, value]) => `${tag}  - ${value}\r\n`).join('') + 'ER  - \r\n';
  }).join('\r\n');
}
