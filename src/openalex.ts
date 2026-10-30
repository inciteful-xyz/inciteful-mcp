import { inspect } from 'node:util';
import { z } from 'zod';
import { OpenAlexBudgetExhausted, OpenAlexError } from './errors.js';

const WORKS_URL = 'https://api.openalex.org/works';
/** OpenAlex's cap on OR-values in one filter, and on `per-page`. */
const MAX_OR_VALUES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
/** Fallback wait when a 429 names neither `Retry-After` nor `x-ratelimit-reset`. */
const DEFAULT_RETRY_SECS = 3600;
/** Only the fields `compactWork` reads. */
const SELECT = [
  'id', 'doi', 'title', 'publication_year', 'type', 'is_retracted', 'cited_by_count', 'ids', 'authorships',
  'primary_location', 'best_oa_location', 'locations', 'biblio', 'open_access', 'abstract_inverted_index',
].join(',');

export type WorkLocation = {
  is_oa: boolean | null;
  landing_page_url: string | null;
  pdf_url: string | null;
  license: string | null;
  version: string | null;
  source: { display_name: string | null; type: string | null } | null;
};

export type WorkAuthorship = {
  author_position: string | null;
  author: { id: string | null; display_name: string | null; orcid: string | null };
  institutions: Array<{ id: string | null; display_name: string | null; ror: string | null }>;
};

/** A compact OpenAlex work. `id` is the short `W…` form; `ids.pmid` is digits and `ids.pmcid` is `PMC…`. */
export type Work = {
  id: string;
  doi: string | null;
  title: string | null;
  publication_year: number | null;
  type: string | null;
  is_retracted: boolean | null;
  cited_by_count: number | null;
  abstract: string | null;
  ids: { pmid: string | null; pmcid: string | null };
  authorships: WorkAuthorship[];
  primary_location: WorkLocation | null;
  best_oa_location: WorkLocation | null;
  locations: WorkLocation[];
  biblio: { volume: string | null; issue: string | null; first_page: string | null; last_page: string | null };
  open_access: { is_oa: boolean | null; oa_url: string | null };
};

export type Unresolved = { input: string; reason: 'not_found' | 'unavailable' };

export function reconstructAbstract(index: unknown): string | null {
  if (index == null) return null;
  const parsed = z.record(z.string(), z.array(z.number().int().min(0).max(100000))).safeParse(index);
  if (!parsed.success) throw new Error('OpenAlex returned an invalid abstract index.');
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(parsed.data)) for (const position of positions) {
    if (words.has(position)) throw new Error('OpenAlex returned conflicting abstract positions.');
    words.set(position, word);
  }
  if (!words.size) return null;
  // Missing positions should not silently turn an incomplete index into an apparent full abstract.
  if (Math.max(...words.keys()) !== words.size - 1) throw new Error('OpenAlex returned an incomplete abstract index.');
  return [...words].sort(([a], [b]) => a - b).map(([, word]) => word).join(' ');
}

export function normalizeId(input: string): string {
  const value = input.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '').replace(/^https?:\/\/openalex\.org\//i, '');
  if (/^w\d+$/i.test(value)) return value.toUpperCase();
  const pmid = value.match(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?$/i);
  return pmid ? `pmid:${pmid[1]}` : value;
}

type Kind = 'openalex' | 'doi' | 'pmid' | 'pmcid';
/** One parsed input: the filter it goes in, the value sent, and the key results are matched on. */
type Parsed = { kind: Kind; value: string; key: string };

const pmcDigits = (value: string) =>
  value.trim().match(/^(?:pmcid:\s*)?PMC(\d+)$/i)?.[1]
  ?? value.trim().match(/^https?:\/\/(?:www\.ncbi\.nlm\.nih\.gov\/pmc|pmc\.ncbi\.nlm\.nih\.gov)\/articles\/(?:PMC)?(\d+)\/?$/i)?.[1];

function parseInput(input: string): Parsed | null {
  // A `,` or `|` would split the OpenAlex filter into other values; such an input is never sent.
  if (/[,|]/.test(input)) return null;
  const pmc = pmcDigits(input);
  if (pmc) return { kind: 'pmcid', value: `PMC${pmc}`, key: `pmcid:${pmc}` };
  const id = normalizeId(input);
  if (/^W\d+$/.test(id)) return { kind: 'openalex', value: id, key: id };
  const pmid = id.match(/^pmid:\s*(\d+)$/i)?.[1];
  if (pmid) return { kind: 'pmid', value: pmid, key: `pmid:${pmid}` };
  if (/^10\.\d+\/\S+$/.test(id)) return { kind: 'doi', value: id.toLowerCase(), key: `doi:${id.toLowerCase()}` };
  return null;
}

/** The keys a work answers to, matching `parseInput`'s keys. */
function workKeys(work: Work): string[] {
  const keys = [work.id];
  if (work.doi) keys.push(`doi:${normalizeId(work.doi).toLowerCase()}`);
  if (work.ids.pmid) keys.push(`pmid:${work.ids.pmid}`);
  if (work.ids.pmcid) keys.push(`pmcid:${work.ids.pmcid.slice(3)}`);
  return keys;
}

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function location(value: unknown): WorkLocation | null {
  if (value == null || typeof value !== 'object') return null;
  const loc = obj(value);
  const source = loc.source == null ? null : { display_name: str(obj(loc.source).display_name), type: str(obj(loc.source).type) };
  return {
    is_oa: bool(loc.is_oa), landing_page_url: str(loc.landing_page_url), pdf_url: str(loc.pdf_url),
    license: str(loc.license), version: str(loc.version), source,
  };
}

/** Compacts a raw OpenAlex work: the abstract rebuilt, nested objects cut to what the tools use. `null` without a W id. */
export function compactWork(raw: unknown): Work | null {
  const w = obj(raw);
  const id = typeof w.id === 'string' ? normalizeId(w.id) : '';
  if (!/^W\d+$/.test(id)) return null;
  let abstract: string | null;
  // A malformed index costs the abstract, never the work.
  try { abstract = reconstructAbstract(w.abstract_inverted_index); } catch { abstract = null; }
  const ids = obj(w.ids);
  const pmid = str(ids.pmid) ? normalizeId(str(ids.pmid)!).match(/^(?:pmid:)?(\d+)$/)?.[1] ?? null : null;
  const pmc = str(ids.pmcid) ? pmcDigits(str(ids.pmcid)!) : undefined;
  const biblio = obj(w.biblio);
  const oa = obj(w.open_access);
  return {
    id, doi: str(w.doi), title: str(w.title), publication_year: num(w.publication_year), type: str(w.type),
    is_retracted: bool(w.is_retracted), cited_by_count: num(w.cited_by_count), abstract,
    ids: { pmid, pmcid: pmc ? `PMC${pmc}` : null },
    authorships: list(w.authorships).map(item => {
      const a = obj(item);
      const author = obj(a.author);
      return {
        author_position: str(a.author_position),
        author: { id: str(author.id), display_name: str(author.display_name), orcid: str(author.orcid) },
        institutions: list(a.institutions).map(i => ({ id: str(obj(i).id), display_name: str(obj(i).display_name), ror: str(obj(i).ror) })),
      };
    }),
    primary_location: location(w.primary_location),
    best_oa_location: location(w.best_oa_location),
    locations: list(w.locations).map(location).filter((l): l is WorkLocation => l !== null),
    biblio: { volume: str(biblio.volume), issue: str(biblio.issue), first_page: str(biblio.first_page), last_page: str(biblio.last_page) },
    open_access: { is_oa: bool(oa.is_oa), oa_url: str(oa.oa_url) },
  };
}

function retrySecs(res: Response): number {
  for (const name of ['retry-after', 'x-ratelimit-reset']) {
    const value = res.headers.get(name)?.trim();
    if (value && /^\d+$/.test(value)) return Number(value);
  }
  return DEFAULT_RETRY_SECS;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const pageSchema = z.object({
  meta: z.object({ count: z.number().nullable().optional(), next_cursor: z.string().nullable().optional() }).passthrough(),
  results: z.array(z.unknown()),
});
type Page = { works: Work[]; count: number | null; nextCursor: string | null };

/** OpenAlex `/works` client. The key is sent only as `Authorization: Bearer`. */
export class OpenAlexClient {
  readonly #key: string;
  readonly #fetch: typeof fetch;

  constructor(key: string, fetcher: typeof fetch = fetch) {
    this.#key = key;
    this.#fetch = fetcher;
  }

  [inspect.custom]() { return 'OpenAlexClient {}'; }
  toJSON() { return {}; }

  /**
   * One `/works` request. Errors carry only a status: never the URL (search terms), the response
   * body or a rejection's message, any of which could echo the request or the key.
   */
  async #works(params: Record<string, string>): Promise<Page> {
    const url = new URL(WORKS_URL);
    url.search = new URLSearchParams({ ...params, select: SELECT, corpus: 'all' }).toString();
    let res: Response;
    try {
      res = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${this.#key}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OpenAlexError(0);
    }
    if (res.status === 429) {
      await res.body?.cancel();
      throw new OpenAlexBudgetExhausted(retrySecs(res));
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new OpenAlexError(res.status);
    }
    let body: unknown;
    try { body = await res.json(); } catch { throw new OpenAlexError(res.status); }
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) throw new OpenAlexError(res.status);
    return {
      works: parsed.data.results.map(compactWork).filter((w): w is Work => w !== null),
      count: parsed.data.meta.count ?? null,
      nextCursor: parsed.data.meta.next_cursor ?? null,
    };
  }

  /** Relevance search. `openAccess: true` keeps only open-access works; `false` or absent applies no filter. */
  async search(query: string, opts: { limit: number; cursor?: string; yearFrom?: number; yearTo?: number; openAccess?: boolean }): Promise<{ works: Work[]; nextCursor: string | null }> {
    const filters: string[] = [];
    if (opts.yearFrom !== undefined) filters.push(`from_publication_date:${opts.yearFrom}-01-01`);
    if (opts.yearTo !== undefined) filters.push(`to_publication_date:${opts.yearTo}-12-31`);
    if (opts.openAccess) filters.push('is_oa:true');
    const params: Record<string, string> = { search: query, 'per-page': String(opts.limit), cursor: opts.cursor ?? '*' };
    if (filters.length) params.filter = filters.join(',');
    const { works, nextCursor } = await this.#works(params);
    return { works, nextCursor };
  }

  /**
   * Batch lookup by W id, DOI, PMID or PMCID, at most 100 OR-values per request. Works come back in
   * input order, once each. Unparseable inputs are `not_found`; inputs of a failed request are `unavailable`.
   */
  async works(ids: string[]): Promise<{ works: Work[]; unresolved: Unresolved[] }> {
    const parsed = ids.map(parseInput);
    const byKind = new Map<Kind, Set<string>>();
    for (const p of parsed) if (p) byKind.set(p.kind, (byKind.get(p.kind) ?? new Set()).add(p.value));
    const batches = [...byKind].flatMap(([kind, values]) => chunks([...values], MAX_OR_VALUES).map(group => ({ kind, group })));
    const settled = await Promise.allSettled(batches.map(({ kind, group }) =>
      this.#works({ filter: `${kind}:${group.join('|')}`, 'per-page': String(MAX_OR_VALUES) })));

    const found = new Map<string, Work>();
    const failed = new Set<string>();
    let budget: OpenAlexBudgetExhausted | null = null;
    for (const [i, outcome] of settled.entries()) {
      const { kind, group } = batches[i];
      if (outcome.status === 'fulfilled') {
        for (const work of outcome.value.works) for (const key of workKeys(work)) found.set(key, work);
      } else {
        if (outcome.reason instanceof OpenAlexBudgetExhausted) budget = outcome.reason;
        for (const value of group) failed.add(`${kind}:${value}`);
      }
    }

    const works = new Map<string, Work>();
    const unresolved: Unresolved[] = [];
    for (const [i, p] of parsed.entries()) {
      const work = p && found.get(p.key);
      if (work) works.set(work.id, work);
      else unresolved.push({ input: ids[i], reason: p && failed.has(`${p.kind}:${p.value}`) ? 'unavailable' : 'not_found' });
    }
    // Out of budget with nothing to show: the caller needs the retry time, not a list of `unavailable`.
    if (budget && !works.size) throw budget;
    return { works: [...works.values()], unresolved };
  }

  /**
   * References (`cited_by:`) or citations (`cites:`) of the given works, by global `cited_by_count`.
   * One request gives OpenAlex's `total`; several are merged, deduplicated and cut, with `total` null.
   */
  async linked(ids: string[], direction: 'references' | 'citations', limit: number): Promise<{ works: Work[]; total: number | null }> {
    const filter = direction === 'references' ? 'cited_by' : 'cites';
    const values = [...new Set(ids.map(normalizeId).filter(id => /^W\d+$/.test(id)))];
    if (!values.length) return { works: [], total: 0 };
    const pages = await Promise.all(chunks(values, MAX_OR_VALUES).map(group =>
      this.#works({ filter: `${filter}:${group.join('|')}`, sort: 'cited_by_count:desc', 'per-page': String(limit) })));
    if (pages.length === 1) return { works: pages[0].works, total: pages[0].count };
    const merged = new Map<string, Work>();
    for (const work of pages.flatMap(p => p.works)) if (!merged.has(work.id)) merged.set(work.id, work);
    const works = [...merged.values()].sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0)).slice(0, limit);
    return { works, total: null };
  }
}
