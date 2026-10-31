// The HTTP front: routing at /academic/mcp (spec §4.2), CORS, the rate limit, the request context
// for usage rows, and the SIGTERM drain. Nothing here logs request data: the one warning is a fixed string.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';
import { Server as NetServer } from 'node:net';
import { join } from 'node:path';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { callerKey, type RateLimiter } from './limits.js';
import { PAGE_CSP } from './pages/index.js';
import type { ToolSettled } from './tools.js';
import type { GraphMeta, Pages, UsageSink } from './types.js';

const MCP_PATH = '/academic/mcp';
const MCP_SLASH = '/academic/mcp/';
const ASSET_PREFIX = '/academic/mcp/assets/';

const ALLOW_MCP = 'GET, HEAD, POST, OPTIONS';
const ALLOW_PAGE = 'GET, HEAD';

const CORS_PREFLIGHT = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id',
  'Access-Control-Max-Age': '86400',
} as const;

/** The font files never change in place; a new font gets a new name. */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
/** Images and the licence can be replaced at launch under the same name, so they are cached a day. */
const CACHE_DAY = 'public, max-age=86400';

/**
 * Served asset names → file in `assetsDir`, its type and its cache policy. Only these names are
 * served, so no request path ever reaches the file system. `example.json` is read by the landing
 * page, not served.
 */
export const ASSETS: Readonly<Record<string, { file: string; type: string; cache: string }>> = {
  'favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml', cache: CACHE_DAY },
  'icon.png': { file: 'icon.png', type: 'image/png', cache: CACHE_DAY },
  'og.png': { file: 'og.png', type: 'image/png', cache: CACHE_DAY },
  'dm-sans-latin-wght-normal.woff2': { file: 'dm-sans-latin-wght-normal.woff2', type: 'font/woff2', cache: CACHE_IMMUTABLE },
  'dm-sans-latin-ext-wght-normal.woff2': { file: 'dm-sans-latin-ext-wght-normal.woff2', type: 'font/woff2', cache: CACHE_IMMUTABLE },
  'DM-Sans-OFL.txt': { file: 'DM-Sans-OFL.txt', type: 'text/plain; charset=utf-8', cache: CACHE_DAY },
};

/** On every HTML page. */
const PAGE_HEADERS = {
  'Content-Security-Policy': PAGE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
} as const;

/** On every MCP response, including the 413 and 500 that toNodeHandler builds itself. */
const MCP_HEADERS = {
  'Cache-Control': 'no-store, no-transform',
  'X-Robots-Tag': 'noindex',
  'Access-Control-Allow-Origin': '*',
} as const;
const MCP_HEADER_NAMES = new Set(Object.keys(MCP_HEADERS).map(k => k.toLowerCase()));

// ---------------------------------------------------------------------------------------------
// Request context and usage rows

/** Per MCP request; `onToolSettled` reads it to write the usage row. Holds no request content. */
export type RequestContext = { callerKey: string; userAgent: string | null; startedAt: number };
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * The factory's `onToolSettled`: one usage row per `tools/call`. Client name and version come from
 * the 2026 envelope's client info, else the User-Agent stands in for the name (the usage log cuts both).
 */
export function recordToolCalls(usage: UsageSink, now: () => number = Date.now): (e: ToolSettled) => void {
  return (e) => {
    const ctx = requestContext.getStore();
    if (!ctx) return;
    usage.record({
      tool: e.tool,
      clientName: e.clientInfo ? e.clientInfo.name : ctx.userAgent,
      clientVersion: e.clientInfo ? e.clientInfo.version : null,
      callerKey: ctx.callerKey,
      durationMs: Math.max(0, now() - ctx.startedAt),
      outcome: e.outcome,
      graphPapers: e.graphPapers,
      graphDepth: e.graphDepth,
      openalexCalls: e.openalexCalls,
    });
  };
}

// ---------------------------------------------------------------------------------------------
// The app

export type AppDeps = {
  config: Config;
  mcp: McpHttpHandler;
  pages: Pages;
  graphMeta: () => GraphMeta;
  limiter: Pick<RateLimiter, 'check'>;
  usage: UsageSink & { recordRejection(k: string): void };
  assetsDir: string;
};

/** `Host` without a default port, lower-cased. */
function hostOf(req: IncomingMessage): string {
  return (req.headers.host ?? '').toLowerCase().replace(/:(80|443)$/, '');
}

export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const prodHost = deps.config.publicBaseUrl.host.toLowerCase();
  const assetCache = new Map<string, Buffer>();

  // The SDK's responses get our cache, indexing and CORS headers. They are set on the Response,
  // because toNodeHandler writes the Response's headers itself.
  const mcpNode = toNodeHandler({
    fetch: async (request: Request, options?: Parameters<McpHttpHandler['fetch']>[1]) => {
      const response = await deps.mcp.fetch(request, options);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(MCP_HEADERS)) headers.set(name, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  });

  const send = (req: IncomingMessage, res: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: string | Buffer = '') => {
    // A 204 has no body and must not carry Content-Length.
    res.writeHead(status, status === 204 ? headers : { 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  /** Every non-HTML response is noindex. */
  const sendOther = (req: IncomingMessage, res: ServerResponse, status: number, headers: OutgoingHttpHeaders, body?: string | Buffer) =>
    send(req, res, status, { 'X-Robots-Tag': 'noindex', ...headers }, body);

  /** HTML is noindex only off the production host. */
  const sendHtml = (req: IncomingMessage, res: ServerResponse, status: number, page: keyof Pages) => {
    const html = deps.pages[page]({ publicBaseUrl: deps.config.publicBaseUrl, ...deps.graphMeta() });
    // no-transform: Cloudflare then leaves the HTML alone (Email Obfuscation would inject a script
    // the CSP blocks, turning the support address into "[email protected]").
    const headers: OutgoingHttpHeaders = { 'Content-Type': 'text/html; charset=utf-8', Vary: 'Accept', 'Cache-Control': 'no-cache, no-transform', ...PAGE_HEADERS };
    if (hostOf(req) !== prodHost) headers['X-Robots-Tag'] = 'noindex';
    send(req, res, status, headers, html);
  };

  const methodNotAllowed = (req: IncomingMessage, res: ServerResponse, allow: string, mcp: boolean) => {
    if (mcp) {
      const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
      sendOther(req, res, 405, { Allow: allow, 'Content-Type': 'application/json', ...MCP_HEADERS }, body);
    } else {
      sendOther(req, res, 405, { Allow: allow, 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
    }
  };

  async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = callerKey(req);
    const verdict = deps.limiter.check(key);
    if (!verdict.ok) {
      deps.usage.recordRejection(key);
      const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: `Rate limit exceeded; retry in ${verdict.retryAfterSecs} seconds.` }, id: null });
      sendOther(req, res, 429, { 'Retry-After': String(verdict.retryAfterSecs), 'Content-Type': 'application/json', ...MCP_HEADERS }, body);
      return;
    }
    const ua = req.headers['user-agent'];
    const ctx: RequestContext = { callerKey: key, userAgent: typeof ua === 'string' && ua ? ua : null, startedAt: Date.now() };
    // Every response toNodeHandler writes, including the 413 and 500 it builds without calling our
    // fetch, gets MCP_HEADERS: values in writeHead's headers object would win over setHeader, so
    // same-named entries there are dropped first.
    // Node also holds written headers until the first body chunk, and an SSE stream's first chunk is
    // the tool result. Flush them at once, so proxies and the client see the response start before
    // any read timeout.
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
    res.writeHead = ((...args: unknown[]) => {
      for (const [name, value] of Object.entries(MCP_HEADERS)) res.setHeader(name, value);
      const fixed = args.map(arg => (arg && typeof arg === 'object' && !Array.isArray(arg)
        ? Object.fromEntries(Object.entries(arg).filter(([name]) => !MCP_HEADER_NAMES.has(name.toLowerCase())))
        : arg));
      const out = writeHead(...fixed);
      res.flushHeaders();
      return out;
    }) as ServerResponse['writeHead'];
    await requestContext.run(ctx, () => mcpNode(req, res));
  }

  async function serveAsset(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const asset = Object.hasOwn(ASSETS, name) ? ASSETS[name] : undefined;
    if (!asset) return sendHtml(req, res, 404, 'notFound');
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, ALLOW_PAGE, false);
    let body = assetCache.get(name);
    if (!body) {
      try {
        body = await readFile(join(deps.assetsDir, asset.file));
      } catch {
        return sendHtml(req, res, 404, 'notFound');
      }
      assetCache.set(name, body);
    }
    sendOther(req, res, 200, { 'Content-Type': asset.type, 'Cache-Control': asset.cache, 'X-Content-Type-Options': 'nosniff' }, body);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const pathname = q === -1 ? url : url.slice(0, q);
    const method = req.method ?? 'GET';
    const getOrHead = method === 'GET' || method === 'HEAD';

    if (pathname === MCP_PATH || pathname === MCP_SLASH) {
      if (method === 'POST') return serveMcp(req, res);
      if (method === 'OPTIONS') return sendOther(req, res, 204, CORS_PREFLIGHT);
      if (method === 'GET' && (req.headers.accept ?? '').toLowerCase().includes('text/event-stream')) {
        return methodNotAllowed(req, res, ALLOW_MCP, true);
      }
      if (!getOrHead) return methodNotAllowed(req, res, ALLOW_MCP, true);
      if (pathname === MCP_SLASH) return sendOther(req, res, 301, { Location: MCP_PATH + (q === -1 ? '' : url.slice(q)) });
      return sendHtml(req, res, 200, 'landing');
    }
    if (pathname === `${MCP_PATH}/privacy` || pathname === `${MCP_PATH}/terms`) {
      if (!getOrHead) return methodNotAllowed(req, res, ALLOW_PAGE, false);
      return sendHtml(req, res, 200, pathname.endsWith('privacy') ? 'privacy' : 'terms');
    }
    if (pathname.startsWith(ASSET_PREFIX)) return serveAsset(req, res, pathname.slice(ASSET_PREFIX.length));
    if (pathname === '/healthz') {
      if (!getOrHead) return methodNotAllowed(req, res, ALLOW_PAGE, false);
      return sendOther(req, res, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'ok');
    }
    return sendHtml(req, res, 404, 'notFound');
  }

  return (req, res) => {
    route(req, res).catch(() => {
      // No logging: the error could carry request data. Answer if we still can.
      if (!res.headersSent) sendOther(req, res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
      else res.destroy();
    });
  };
}

// ---------------------------------------------------------------------------------------------
// In-flight tracking and the SIGTERM drain

export type Tracked = {
  listener: (req: IncomingMessage, res: ServerResponse) => void;
  inFlight: () => number;
  /** Resolves when no request is in flight. */
  idle: () => Promise<void>;
};

/**
 * Tracks requests from arrival until their response closes. 'close' follows 'finish', which fires
 * once the socket has handed every byte to the kernel, or the connection was aborted.
 */
export function trackInFlight(listener: (req: IncomingMessage, res: ServerResponse) => void): Tracked {
  const open = new Set<ServerResponse>();
  let waiters: Array<() => void> = [];
  return {
    listener: (req, res) => {
      open.add(res);
      res.once('close', () => {
        open.delete(res);
        if (open.size === 0) {
          const ready = waiters;
          waiters = [];
          for (const w of ready) w();
        }
      });
      listener(req, res);
    },
    inFlight: () => open.size,
    idle: () => (open.size === 0 ? Promise.resolve() : new Promise<void>(resolve => waiters.push(resolve))),
  };
}

export type Stoppable = { server: Server; tracked: Tracked; close: () => Promise<void> };

/**
 * SIGTERM/SIGINT: stop accepting connections, wait up to `timeoutMs` for in-flight requests, run
 * `close`, then `exit(0)`, whether the requests finished or not. `null` (startup hasn't built the
 * server yet) exits at once. Open connections are left to the exit: by then every finished response
 * is with the kernel, which still delivers it after the process ends.
 */
export async function shutdown(s: Stoppable | null, timeoutMs: number, exit: (code: number) => void): Promise<void> {
  if (s) {
    // net.Server#close, not http.Server#close: that one also destroys idle keep-alive connections,
    // and counts as idle a connection whose response has ended with bytes still in Node's write
    // buffer, which are then lost. Safe on a server that isn't listening yet.
    NetServer.prototype.close.call(s.server);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const finished = await Promise.race([s.tracked.idle().then(() => true), timedOut]);
    clearTimeout(timer);
    if (!finished) console.warn('drain timed out; exiting with requests in flight');
    await s.close().catch(() => {});
  }
  exit(0);
}
