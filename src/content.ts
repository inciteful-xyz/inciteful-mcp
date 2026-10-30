import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Work } from './openalex.js';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

export type ContentLink = {
  url: string; format: 'pdf' | 'landing_page'; source: string;
  is_oa: boolean | null; license: string | null; version: string | null;
  priority: number;
};

function publicLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    // OpenAlex's paid content archive is never offered.
    if (url.hostname === 'content.openalex.org') return;
    // Do not expose credentials if an upstream URL unexpectedly includes them.
    for (const key of [...url.searchParams.keys()]) if (/api[_-]?key|token|signature|credential/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return; }
}

export function contentLinks(work: Work): ContentLink[] {
  const links = new Map<string, ContentLink>();
  const add = (url: unknown, entry: Omit<ContentLink, 'url'>) => {
    const normalized = publicLink(url);
    if (normalized && !links.has(normalized)) links.set(normalized, { url: normalized, ...entry });
  };
  const locations = [work.best_oa_location, ...(Array.isArray(work.locations) ? work.locations : []), work.primary_location];
  for (const [index, item] of locations.entries()) {
    const location = object(item);
    const base = {
      source: string(object(location.source).display_name) ?? 'Publisher or repository',
      is_oa: typeof location.is_oa === 'boolean' ? location.is_oa : null,
      license: string(location.license) ?? null, version: string(location.version) ?? null,
    };
    const priority = index === 0 ? 0 : location.is_oa === true ? 10 : 20;
    add(location.pdf_url, { ...base, format: 'pdf', priority });
    add(location.landing_page_url, { ...base, format: 'landing_page', priority: priority + 1 });
  }
  add(object(work.open_access).oa_url, { source: 'OpenAlex best open-access link', format: 'landing_page', is_oa: true, license: null, version: null, priority: 12 });
  return [...links.values()].sort((a, b) => a.priority - b.priority);
}

const passageSchema = z.object({ text: z.string().default(''), infons: z.record(z.string(), z.unknown()).default({}) });
const documentSchema = z.object({ id: z.string(), infons: z.record(z.string(), z.unknown()).default({}), passages: z.array(passageSchema) });
export function parseBioC(data: unknown, abstractOnly = false, expectedId?: string) {
  const collections = z.array(z.object({ documents: z.array(documentSchema) })).parse(data);
  const doc = collections.flatMap(c => c.documents)[0];
  if (!doc) throw new Error('No article text was returned by PMC/PubMed.');
  if (expectedId && doc.id.toUpperCase() !== expectedId.toUpperCase() &&
    !doc.passages.some(p => String(p.infons['article-id_pmid']) === expectedId || String(p.infons['article-id_pmc']).toUpperCase() === expectedId.toUpperCase())) {
    throw new Error('PMC/PubMed returned text for a different article identifier.');
  }
  const passages = doc.passages.filter(p => p.text.trim());
  const abstracts = passages.filter(p => String(p.infons.section_type).toUpperCase() === 'ABSTRACT' || /^abstract/i.test(String(p.infons.type)));
  const body = passages.filter(p => !['TITLE', 'ABSTRACT', 'REF', 'REFS', 'REFERENCES'].includes(String(p.infons.section_type).toUpperCase()) && !/^abstract/i.test(String(p.infons.type)));
  if (!abstractOnly && !body.length) throw new Error('The source returned an abstract but no full-text body.');
  return {
    id: doc.id, title: passages.find(p => String(p.infons.section_type).toUpperCase() === 'TITLE')?.text,
    license: string(doc.infons.license) ?? null,
    text: (abstractOnly ? abstracts : passages).map(p => p.text).join('\n\n'),
  };
}

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const CACHE_ENTRIES = 8;
const CACHE_TTL_MS = 15 * 60 * 1000;

type Article = { text: string; sha256: string; license: string | null };
export type ReadResult = { text?: string; nextOffset: number | null; sha256: string; license: string | null; links: ContentLink[] };

/**
 * Full text from PMC BioC for works with a PMCID, paged by character offset. Otherwise, or when PMC
 * has no usable text, only the work's candidate links (OpenAlex locations) come back.
 */
export class ContentClient {
  readonly #cache = new Map<string, { article: Article; expires: number }>();
  readonly #fetch: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) { this.#fetch = fetcher; }

  /** The URL is built from the PMCID alone, never taken from publisher metadata. */
  async #download(url: URL): Promise<string> {
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error(`Content source returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) { await response.body?.cancel(); throw new Error('Article exceeds the 12 MiB download limit.'); }
    if (!response.body) throw new Error('Content source returned an empty response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_DOWNLOAD_BYTES) { await reader.cancel(); throw new Error('Article exceeds the 12 MiB download limit.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  }

  async #article(pmcid: string): Promise<Article | null> {
    const cached = this.#cache.get(pmcid);
    if (cached && cached.expires > Date.now()) return cached.article;
    this.#cache.delete(pmcid);
    let article: Article;
    try {
      const url = new URL(`https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/${encodeURIComponent(pmcid)}/unicode`);
      const parsed = parseBioC(JSON.parse(await this.#download(url)), false, pmcid);
      article = { text: parsed.text, sha256: createHash('sha256').update(parsed.text).digest('hex'), license: parsed.license };
    } catch {
      // Not in the PMC open-access set, unreadable, or the wrong article: the caller gets links instead.
      return null;
    }
    if (this.#cache.size >= CACHE_ENTRIES) this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(pmcid, { article, expires: Date.now() + CACHE_TTL_MS });
    return article;
  }

  /** `sha256` is of the whole article text, or `''` when no text was retrieved. */
  async readPaper(work: Work, offset: number, maxChars: number): Promise<ReadResult> {
    const links = contentLinks(work);
    const article = work.ids.pmcid ? await this.#article(work.ids.pmcid) : null;
    if (!article) return { nextOffset: null, sha256: '', license: null, links };
    const start = Math.min(offset, article.text.length);
    const end = Math.min(article.text.length, start + maxChars);
    return {
      text: article.text.slice(start, end), nextOffset: end < article.text.length ? end : null,
      sha256: article.sha256, license: article.license, links,
    };
  }
}
