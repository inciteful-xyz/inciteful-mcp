import { z } from 'zod';
import type { Config } from './config.js';
import { GraphError, GraphUnavailableError, QueryTimeoutError } from './errors.js';
import type { CondensedPaper, GraphMeta, SeedResolution } from './types.js';

/** Rejection codes (undici puts them on `err.cause.code`) meaning the primary was never reached. */
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);
/** graph-api's exact 400 body when the user's SQL hits its time limit. */
const TIME_LIMIT_BODY = 'Error: Query exceeded the time limit';
/** Long DOIs make resolve URLs large, so inputs go 100 per request. */
const RESOLVE_BATCH = 100;
const PRUNE = '10000';
/** Enough for every row of the `metadata` table. */
const METADATA_LIMIT = 100;
/** Bound on the 400 body carried as `GraphError.detail`. */
const MAX_DETAIL_CHARS = 2000;
/** Per-request timeout on `resolve`, which is never a graph build (builds are bounded by the build cap). */
const RESOLVE_TIMEOUT_MS = 30_000;

const resolutionSchema = z.array(z.object({
  input: z.string(), id: z.string().nullable(), reason: z.enum(['not_found', 'unavailable']).nullable(),
}));
const paperSchema = z.object({ id: z.string(), title: z.string().nullable().optional() }).passthrough();
const rowsSchema = z.array(z.record(z.string(), z.unknown()));
const connectorSchema = z.object({
  paths: z.array(z.array(z.string())),
  papers: z.array(paperSchema),
  connections: z.array(z.object({ citing: z.string(), cited: z.string() }).passthrough()),
  num_paths: z.number(), papers_searched: z.number(), max_hops: z.number(),
}).passthrough();

export type SimilarPaper = CondensedPaper & { score: number };
export type ConnectorPaper = CondensedPaper & { distance?: number; path_count?: number };
export type ConnectorResult = {
  paths: string[][];
  papers: ConnectorPaper[];
  connections: Array<{ citing: string; cited: string }>;
  num_paths: number;
  papers_searched: number;
  max_hops: number;
};

function isConnectionError(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && CONNECTION_CODES.has(code);
}

function header(res: Response, name: string): string | null {
  return res.headers.get(name)?.trim() || null;
}

function retryAfter(res: Response): number | null {
  const value = header(res, 'retry-after');
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

/** Appends `ids[]` the way graph-api's `IdList` reads them. */
function withIds(ids: string[], extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of ids) params.append('ids[]', id);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params;
}

/** Client for graph-api's `/openalex` scope, with failover to the secondary on connection errors only. */
export class GraphClient {
  lastMeta: GraphMeta = { snapshot: null, recentTier: null };
  readonly #primary: URL;
  readonly #secondary: URL;
  readonly #fetch: typeof fetch;

  constructor(cfg: Pick<Config, 'graphPrimary' | 'graphSecondary'>, fetcher: typeof fetch = fetch) {
    // A trailing slash keeps any path prefix of the base when resolving `openalex/...` against it.
    const base = (url: URL) => new URL(url.href.endsWith('/') ? url.href : `${url.href}/`);
    this.#primary = base(cfg.graphPrimary);
    this.#secondary = base(cfg.graphSecondary);
    this.#fetch = fetcher;
  }

  /**
   * Sends to the primary, and once to the secondary only when the primary could not be reached.
   * Any HTTP status is final, and so is any other rejection (headers timeout, abort): the request
   * may already be building a graph upstream, and a retry would start a duplicate build.
   * A rejection with no HTTP response becomes `GraphUnavailableError(null)`, except when the caller's
   * own `caller` signal aborted it: that abort is rethrown as it is, so the caller can tell it apart.
   */
  async #request(path: string, params: URLSearchParams, init: RequestInit = {}, caller?: AbortSignal): Promise<{ res: Response; meta: GraphMeta }> {
    const send = (base: URL) => {
      const url = new URL(path, base);
      url.search = params.toString();
      return this.#fetch(url, { ...init, redirect: 'error' });
    };
    const unavailable = (err: unknown) => (caller?.aborted ? err : new GraphUnavailableError(null));
    let res: Response;
    try {
      res = await send(this.#primary);
    } catch (err) {
      if (init.signal?.aborted || !isConnectionError(err)) throw unavailable(err);
      try {
        res = await send(this.#secondary);
      } catch (second) {
        throw unavailable(second);
      }
    }
    const meta: GraphMeta = { snapshot: header(res, 'x-graph-snapshot'), recentTier: header(res, 'x-graph-recent-tier') };
    this.lastMeta = meta;
    if (res.ok) return { res, meta };
    if (res.status === 503) {
      await res.body?.cancel();
      throw new GraphUnavailableError(retryAfter(res));
    }
    if (res.status === 400) {
      const body = (await res.text()).trim();
      if (body === TIME_LIMIT_BODY) throw new QueryTimeoutError();
      throw new GraphError(400, body.slice(0, MAX_DETAIL_CHARS));
    }
    await res.body?.cancel();
    throw new GraphError(res.status);
  }

  async #json<T>(schema: z.ZodType<T>, path: string, params: URLSearchParams, init?: RequestInit, caller?: AbortSignal): Promise<{ data: T; meta: GraphMeta }> {
    const { res, meta } = await this.#request(path, params, init, caller);
    let body: unknown;
    try { body = await res.json(); } catch { throw new GraphError(res.status); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new GraphError(res.status);
    return { data: parsed.data, meta };
  }

  /**
   * Resolves inputs to OpenAlex W ids, in input order. `resolve([])` makes one request (fills `lastMeta`).
   * Each request has its own timeout; `signal` (the tool call's ceiling) aborts them all.
   */
  async resolve(inputs: string[], opts: { signal?: AbortSignal } = {}): Promise<{ results: SeedResolution[] } & GraphMeta> {
    const batches: string[][] = [];
    for (let i = 0; i < inputs.length; i += RESOLVE_BATCH) batches.push(inputs.slice(i, i + RESOLVE_BATCH));
    if (!batches.length) batches.push([]);
    const answers = await Promise.all(batches.map(batch => {
      const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      return this.#json(resolutionSchema, 'openalex/resolve', withIds(batch), { signal }, opts.signal);
    }));
    return { results: answers.flatMap(a => a.data), ...answers[answers.length - 1].meta };
  }

  /** graph-api's fast similarity, in its order (descending score; seeds and score-0 rows at the tail). */
  async similar(ids: string[], n: number): Promise<{ papers: SimilarPaper[] } & GraphMeta> {
    const schema = z.array(paperSchema.extend({ num_cited_by: z.number(), num_citing: z.number(), score: z.number() }));
    const { data, meta } = await this.#json(schema, 'openalex/paper/similar', withIds(ids, { n: String(n) }));
    return { papers: data as SimilarPaper[], ...meta };
  }

  /** Runs `sql` on the graph built from `ids`. The body is the raw SQL; graph-api applies `limit`. */
  async query(ids: string[], sql: string, limit: number): Promise<{ rows: Record<string, unknown>[] } & GraphMeta> {
    const options = { prune: PRUNE, limit: String(limit) };
    const [path, params] = ids.length === 1
      ? [`openalex/query/${encodeURIComponent(ids[0])}`, withIds([], options)]
      : ['openalex/query', withIds(ids, options)];
    const { data, meta } = await this.#json(rowsSchema, path, params, {
      method: 'POST', body: sql, headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'application/json' },
    });
    return { rows: data, ...meta };
  }

  /** The graph's `metadata` table as name → value. */
  async metadata(ids: string[]): Promise<Record<string, string>> {
    const { rows } = await this.query(ids, 'SELECT name, value FROM metadata', METADATA_LIMIT);
    const out: Record<string, string> = {};
    for (const row of rows) if (typeof row.name === 'string' && row.value != null) out[row.name] = String(row.value);
    return out;
  }

  /** Citation paths between two papers; `extended` widens the search (`extend=5`). */
  async connector(from: string, to: string, extended: boolean): Promise<ConnectorResult & GraphMeta> {
    const params = new URLSearchParams({ from, to, extend: extended ? '5' : '0' });
    const { data, meta } = await this.#json(connectorSchema, 'openalex/connector', params);
    // Path papers come as full PaperViews with (empty) edge lists; drop the lists.
    const papers = data.papers.map(({ citing: _citing, cited_by: _citedBy, ...paper }) => paper as ConnectorPaper);
    return {
      paths: data.paths, papers, connections: data.connections.map(({ citing, cited }) => ({ citing, cited })),
      num_paths: data.num_paths, papers_searched: data.papers_searched, max_hops: data.max_hops, ...meta,
    };
  }
}
