import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { ASSETS, createApp, drain, trackInFlight } from '../src/http.js';
import { pages as realPages } from '../src/pages/index.js';
import type { RateLimiter } from '../src/limits.js';
import type { GraphMeta, PageCtx, Pages, UsageRow } from '../src/types.js';
import { raw, serve } from './helpers.js';

const PROD_HOST = 'incitefulmed.com';
const config = loadConfig({
  GRAPH_API_PRIMARY_URL: 'http://graph-api-academic', GRAPH_API_SECONDARY_URL: 'http://graph-api',
  OPENALEX_ACADEMIC_API_KEY: 'test-key', PUBLIC_BASE_URL: `https://${PROD_HOST}/academic/mcp`, USAGE_DB_PATH: '/nonexistent/usage.sqlite',
});

const ALLOW_HEADERS = 'content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id';

function fakes(opts: { mcp?: McpHttpHandler; limit?: { ok: boolean; retryAfterSecs: number } } = {}) {
  const calls = { mcp: [] as Request[], limiter: [] as string[], rejections: [] as string[], graphMeta: 0, pages: [] as Array<[string, PageCtx]> };
  const page = (name: string) => (ctx: PageCtx) => { calls.pages.push([name, ctx]); return `<!doctype html><title>${name}</title>`; };
  const pages: Pages = { landing: page('landing'), privacy: page('privacy'), terms: page('terms'), notFound: page('notFound') };
  const mcp = opts.mcp ?? ({
    async fetch(request: Request) {
      calls.mcp.push(request);
      return new Response('{"jsonrpc":"2.0","result":{},"id":1}', {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-cache, no-transform' },
      });
    },
    async close() {},
  } as unknown as McpHttpHandler);
  const limiter = {
    check(key: string) { calls.limiter.push(key); return opts.limit ?? { ok: true, retryAfterSecs: 0 }; },
  } as unknown as RateLimiter;
  const usage = {
    record(_row: UsageRow) {},
    recordRejection(key: string) { calls.rejections.push(key); },
    close() {},
  };
  const graphMeta = (): GraphMeta => { calls.graphMeta += 1; return { snapshot: '2026-10-15', recentTier: null }; };
  const assetsDir = mkdtempSync(join(tmpdir(), 'assets-'));
  writeFileSync(join(assetsDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(tmpdir(), 'secret.txt'), 'outside the assets dir');
  const app = createApp({ config, mcp, pages, graphMeta, limiter, usage, assetsDir });
  return { app, calls };
}

async function withApp<T>(opts: Parameters<typeof fakes>[0], fn: (s: { port: number; base: string; calls: ReturnType<typeof fakes>['calls'] }) => Promise<T>) {
  const { app, calls } = fakes(opts);
  const server = await serve(app);
  try { return await fn({ port: server.port, base: server.base, calls }); } finally { await server.close(); }
}

const POST_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const POST_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

test('html_get_variants_get_page', async () => {
  await withApp({}, async ({ port, calls }) => {
    for (const accept of ['text/html,application/xhtml+xml', '*/*', undefined, 'application/json']) {
      const r = await raw(port, 'GET', '/academic/mcp', accept === undefined ? {} : { accept });
      assert.equal(r.status, 200, String(accept));
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(r.headers.vary, 'Accept');
      assert.equal(r.headers['cache-control'], 'no-cache');
      assert.equal(r.body, '<!doctype html><title>landing</title>');
    }
    const head = await raw(port, 'HEAD', '/academic/mcp', { accept: '*/*' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(head.headers.vary, 'Accept');
    assert.equal(head.headers['content-length'], String('<!doctype html><title>landing</title>'.length));
    assert.equal(head.body, '');
    // The page gets the canonical base URL and the graph snapshot.
    assert.deepEqual(calls.pages[0], ['landing', { publicBaseUrl: config.publicBaseUrl, snapshot: '2026-10-15', recentTier: null }]);
    assert.equal(calls.mcp.length, 0);
    for (const path of ['/academic/mcp/privacy', '/academic/mcp/terms']) {
      const r = await raw(port, 'GET', path);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
      assert.match(r.body, path.endsWith('privacy') ? /privacy/ : /terms/);
      assert.equal((await raw(port, 'HEAD', path)).status, 200);
      assert.equal((await raw(port, 'POST', path)).status, 405);
    }
  });
});

test('query_string_ignored', async () => {
  await withApp({}, async ({ port }) => {
    const r = await raw(port, 'GET', '/academic/mcp?utm_source=x');
    assert.equal(r.status, 200);
    assert.equal(r.body, '<!doctype html><title>landing</title>');
    assert.equal((await raw(port, 'GET', '/academic/mcp/privacy?ref=y')).body, '<!doctype html><title>privacy</title>');
    assert.equal((await raw(port, 'GET', '/healthz?probe=1')).body, 'ok');
  });
});

test('post_goes_to_mcp_no_redirect_with_slash', async () => {
  await withApp({}, async ({ port, calls }) => {
    for (const path of ['/academic/mcp', '/academic/mcp/', '/academic/mcp?x=1']) {
      const r = await raw(port, 'POST', path, POST_HEADERS, POST_BODY);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.location, undefined);
      assert.equal(r.body, '{"jsonrpc":"2.0","result":{},"id":1}');
    }
    assert.equal(calls.mcp.length, 3);
    assert.equal(calls.mcp[0].method, 'POST');
    assert.equal(await calls.mcp[1].text(), POST_BODY);
  });
});

test('options_preflight_cors', async () => {
  await withApp({}, async ({ port, calls }) => {
    for (const path of ['/academic/mcp', '/academic/mcp/']) {
      const r = await raw(port, 'OPTIONS', path, {
        origin: 'https://claude.ai', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, mcp-protocol-version',
      });
      assert.equal(r.status, 204);
      assert.equal(r.headers['access-control-allow-origin'], '*');
      assert.equal(r.headers['access-control-allow-methods'], 'POST, GET, OPTIONS');
      assert.equal(r.headers['access-control-allow-headers'], ALLOW_HEADERS);
      assert.equal(r.headers['access-control-max-age'], '86400');
      assert.equal(r.headers['content-length'], undefined);
      assert.equal(r.body, '');
    }
    assert.deepEqual(calls.limiter, []);
    assert.equal(calls.mcp.length, 0);
  });
});

test('sse_get_and_delete_405', async () => {
  await withApp({}, async ({ port, calls }) => {
    for (const path of ['/academic/mcp', '/academic/mcp/']) {
      const sse = await raw(port, 'GET', path, { accept: 'text/event-stream' });
      assert.equal(sse.status, 405, path);
      assert.equal(sse.headers['x-robots-tag'], 'noindex');
      const mixed = await raw(port, 'GET', path, { accept: 'application/json, text/event-stream' });
      assert.equal(mixed.status, 405);
      const del = await raw(port, 'DELETE', path);
      assert.equal(del.status, 405);
      assert.equal(del.headers.allow, 'GET, HEAD, POST, OPTIONS');
      assert.equal(del.headers['cache-control'], 'no-store, no-transform');
      assert.equal(del.headers['access-control-allow-origin'], '*');
      assert.equal((await raw(port, 'PUT', path, {}, '{}')).status, 405);
    }
    assert.equal(calls.mcp.length, 0);
    assert.deepEqual(calls.limiter, []);
  });
});

test('slash_html_get_301', async () => {
  await withApp({}, async ({ port }) => {
    for (const method of ['GET', 'HEAD']) {
      const r = await raw(port, method, '/academic/mcp/', { accept: 'text/html' });
      assert.equal(r.status, 301, method);
      assert.equal(r.headers.location, '/academic/mcp');
    }
    const q = await raw(port, 'GET', '/academic/mcp/?utm_source=x');
    assert.equal(q.status, 301);
    assert.equal(q.headers.location, '/academic/mcp?utm_source=x');
  });
});

test('unknown_subpath_and_preflight_path_404', async () => {
  await withApp({}, async ({ port, calls }) => {
    for (const path of ['/academic/mcp-preflight', '/academic/mcp/nope', '/academic/mcp/privacy/', '/', '/academic', '/academic/mcpx', '//academic/mcp']) {
      for (const method of ['GET', 'POST']) {
        const r = await raw(port, method, path);
        assert.equal(r.status, 404, `${method} ${path}`);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(r.body, '<!doctype html><title>notFound</title>');
      }
    }
    assert.equal(calls.mcp.length, 0);
    assert.deepEqual(calls.limiter, []);
  });
});

test('asset_allowlist_and_traversal_404', async () => {
  await withApp({}, async ({ port }) => {
    const ok = await raw(port, 'GET', '/academic/mcp/assets/favicon.svg');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/svg+xml');
    assert.equal(ok.headers['cache-control'], 'public, max-age=86400');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['x-robots-tag'], 'noindex');
    assert.equal(ok.body, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const head = await raw(port, 'HEAD', '/academic/mcp/assets/favicon.svg');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const post = await raw(port, 'POST', '/academic/mcp/assets/favicon.svg', {}, '{}');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    for (const path of [
      '/academic/mcp/assets/../../etc/passwd', '/academic/mcp/assets/%2e%2e/%2e%2e/etc/passwd', '/academic/mcp/assets/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
      '/academic/mcp/assets/..%2fsecret.txt', '/academic/mcp/assets/../secret.txt', '/academic/mcp/assets/', '/academic/mcp/assets/other.svg',
      '/academic/mcp/assets/favicon.svg/', '/academic/mcp/assets/./favicon.svg', '/academic/mcp/assets/FAVICON.SVG',
    ]) {
      const r = await raw(port, 'GET', path);
      assert.equal(r.status, 404, path);
      assert.doesNotMatch(r.body, /root:|outside the assets dir/);
    }
  });
});

test('noindex_rules', async () => {
  await withApp({}, async ({ port }) => {
    // Non-HTML responses always carry it, on any host.
    for (const [method, path, body] of [['POST', '/academic/mcp', POST_BODY], ['GET', '/healthz', undefined], ['OPTIONS', '/academic/mcp', undefined], ['DELETE', '/academic/mcp', undefined], ['GET', '/academic/mcp/', undefined]] as const) {
      for (const host of [PROD_HOST, 'staging.example.org']) {
        const r = await raw(port, method, path, { host, ...(method === 'POST' ? POST_HEADERS : {}) }, body);
        assert.equal(r.headers['x-robots-tag'], 'noindex', `${method} ${path} ${host}`);
      }
    }
    // HTML on the production host: no X-Robots-Tag. On any other host: noindex.
    for (const path of ['/academic/mcp', '/academic/mcp/privacy', '/academic/mcp/terms', '/nope']) {
      assert.equal((await raw(port, 'GET', path, { host: PROD_HOST })).headers['x-robots-tag'], undefined, path);
      assert.equal((await raw(port, 'GET', path, { host: 'INCITEFULMED.COM' })).headers['x-robots-tag'], undefined, path);
      assert.equal((await raw(port, 'GET', path, { host: 'staging.incitefulmed.com' })).headers['x-robots-tag'], 'noindex', path);
      assert.equal((await raw(port, 'GET', path)).headers['x-robots-tag'], 'noindex', path);
    }
  });
});

test('rate_limit_through_app', async () => {
  await withApp({}, async ({ port, calls }) => {
    const r = await raw(port, 'POST', '/academic/mcp', { ...POST_HEADERS, 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }, POST_BODY);
    assert.equal(r.status, 200);
    // A spoofed X-Forwarded-For is ignored: without CF-Connecting-IP the key is the peer.
    await raw(port, 'POST', '/academic/mcp/', { ...POST_HEADERS, 'x-forwarded-for': '198.51.100.1' }, POST_BODY);
    assert.deepEqual(calls.limiter, ['203.0.113.7', '127.0.0.1']);
    // HTML, OPTIONS, health and 404s never reach the limiter.
    await raw(port, 'GET', '/academic/mcp');
    await raw(port, 'HEAD', '/academic/mcp');
    await raw(port, 'GET', '/academic/mcp/');
    await raw(port, 'OPTIONS', '/academic/mcp');
    await raw(port, 'GET', '/healthz');
    await raw(port, 'GET', '/academic/mcp/privacy');
    await raw(port, 'POST', '/nope');
    assert.equal(calls.limiter.length, 2);
  });
  await withApp({ limit: { ok: false, retryAfterSecs: 17 } }, async ({ port, calls }) => {
    const r = await raw(port, 'POST', '/academic/mcp', { ...POST_HEADERS, 'cf-connecting-ip': '203.0.113.7' }, POST_BODY);
    assert.equal(r.status, 429);
    assert.equal(r.headers['retry-after'], '17');
    assert.equal(r.headers['cache-control'], 'no-store, no-transform');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['x-robots-tag'], 'noindex');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(r.body), { jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded; retry in 17 seconds.' }, id: null });
    assert.deepEqual(calls.rejections, ['203.0.113.7']);
    assert.equal(calls.mcp.length, 0);
  });
});

test('oversized_body_413_has_mcp_headers', async () => {
  // toNodeHandler answers this itself (4 MiB limit), without calling the handler's fetch.
  await withApp({}, async ({ port, calls }) => {
    // Declares a body over 4 MiB and sends only its start: the adapter rejects on Content-Length, and
    // the test reads the answer without racing a large upload against the server closing the socket.
    const r = await new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port, method: 'POST', path: '/academic/mcp', agent: false,
        headers: { ...POST_HEADERS, 'content-length': String(4 * 1024 * 1024 + 1) },
      }, res => { res.resume(); resolve({ status: res.statusCode ?? 0, headers: res.headers }); req.destroy(); });
      req.on('error', reject);
      req.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"');
    });
    assert.equal(r.status, 413);
    assert.equal(r.headers['cache-control'], 'no-store, no-transform');
    assert.equal(r.headers['x-robots-tag'], 'noindex');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(calls.mcp.length, 0);
  });
});

test('healthz_makes_no_upstream_calls', async () => {
  await withApp({}, async ({ port, calls }) => {
    for (const method of ['GET', 'HEAD']) {
      const r = await raw(port, method, '/healthz');
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(r.body, method === 'GET' ? 'ok' : '');
    }
    assert.equal(calls.mcp.length, 0);
    assert.equal(calls.graphMeta, 0);
    assert.equal(calls.pages.length, 0);
    assert.deepEqual(calls.limiter, []);
  });
});

// ---------------------------------------------------------------------------------------------
// The real SDK handler behind the app: headers must reach the client before a slow tool's result.

const TOOL_DELAY_MS = 400;
const HEADERS_MARGIN_MS = 100;

function slowToolHandler() {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'slow', version: '0.0.0' });
    server.registerTool('slow', { description: 'waits', inputSchema: z.object({}) }, async () => {
      await new Promise(resolve => setTimeout(resolve, TOOL_DELAY_MS));
      return { content: [{ type: 'text', text: 'done' }] };
    });
    return server;
  }, { responseMode: 'sse', keepAliveMs: 15_000 });
}

test('mcp_response_headers', async () => {
  for (const modern of [false, true]) {
    const handler = slowToolHandler();
    await withApp({ mcp: handler }, async ({ base }) => {
      const seen: Array<{ at: number; body: string; headers: Headers }> = [];
      const client = new Client({ name: 'hdr-test', version: '1.0.0' }, modern ? { versionNegotiation: { mode: 'auto' } } : undefined);
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/academic/mcp`), {
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const res = await fetch(input, init);
          seen.push({ at: performance.now(), body: typeof init?.body === 'string' ? init.body : '', headers: res.headers });
          return res;
        },
      });
      await client.connect(transport);
      try {
        const callStarted = performance.now();
        const result = await client.callTool({ name: 'slow', arguments: {} });
        const resultAt = performance.now();
        assert.deepEqual((result as { content: unknown }).content, [{ type: 'text', text: 'done' }]);
        const call = seen.find(s => s.body.includes('"tools/call"'));
        assert.ok(call, `tools/call seen (modern=${modern})`);
        assert.equal(call.headers.get('content-type'), 'text/event-stream', `modern=${modern}`);
        assert.equal(call.headers.get('cache-control'), 'no-store, no-transform');
        assert.equal(call.headers.get('x-robots-tag'), 'noindex');
        assert.equal(call.headers.get('access-control-allow-origin'), '*');
        // The headers arrived well before the tool finished.
        assert.ok(call.at - callStarted < HEADERS_MARGIN_MS, `headers after ${call.at - callStarted} ms (modern=${modern})`);
        assert.ok(resultAt - call.at >= TOOL_DELAY_MS / 2, `result ${resultAt - call.at} ms after headers (modern=${modern})`);
        if (!modern) {
          const init = seen.find(s => s.body.includes('"initialize"'));
          assert.ok(init, 'the 2025 client initializes first');
          assert.equal(init.headers.get('cache-control'), 'no-store, no-transform');
        }
      } finally {
        await client.close();
        await handler.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// SIGTERM drain

function gatedMcp() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const mcp = {
    async fetch() {
      entered();
      await gate;
      return new Response('{"jsonrpc":"2.0","result":{},"id":1}', { headers: { 'content-type': 'application/json' } });
    },
    async close() {},
  } as unknown as McpHttpHandler;
  return { mcp, release, reached };
}

async function drainServer(mcp: McpHttpHandler) {
  const { app } = fakes({ mcp });
  const tracked = trackInFlight(app);
  const server = createServer(tracked.listener);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, tracked, port: (server.address() as AddressInfo).port };
}

test('drain_waits_for_in_flight_then_closes', async () => {
  const { mcp, release, reached } = gatedMcp();
  const { server, tracked, port } = await drainServer(mcp);
  const inFlight = raw(port, 'POST', '/academic/mcp', POST_HEADERS, POST_BODY);
  await reached;
  assert.equal(tracked.inFlight(), 1);
  let drained: boolean | 'pending' = 'pending';
  const draining = drain(server, tracked, 5_000).then(v => { drained = v; });
  // No new connections once draining.
  await assert.rejects(raw(port, 'GET', '/healthz'), { code: 'ECONNREFUSED' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(drained, 'pending');
  release();
  const r = await inFlight;
  assert.equal(r.status, 200);
  await draining;
  assert.equal(drained, true);
  assert.equal(tracked.inFlight(), 0);
  assert.equal(server.listening, false);
});

test('drain_gives_up_at_the_timeout', async () => {
  const { mcp, reached } = gatedMcp();
  const { server, tracked, port } = await drainServer(mcp);
  const inFlight = raw(port, 'POST', '/academic/mcp', POST_HEADERS, POST_BODY);
  await reached;
  assert.equal(await drain(server, tracked, 50), false);
  // The stuck request's connection was closed.
  await assert.rejects(inFlight);
  assert.equal(server.listening, false);
});

test('drain_deadline_covers_connections_that_never_close', async () => {
  const { mcp } = gatedMcp();
  const { server, tracked, port } = await drainServer(mcp);
  // A request whose headers never finish: no request is in flight, but the connection isn't idle.
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>(resolve => socket.once('connect', () => resolve()));
  socket.on('error', () => {});
  socket.write('POST /academic/mcp HTTP/1.1\r\nHost: x\r\n');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(tracked.inFlight(), 0);
  const started = performance.now();
  assert.equal(await drain(server, tracked, 100), false);
  assert.ok(performance.now() - started < 1_000);
  assert.equal(server.listening, false);
  socket.destroy();
});

test('pages_send_csp_whose_hash_matches_the_copy_script', async () => {
  // The header is checked against the script as rendered, so editing the script can't silently
  // leave Copy blocked by a stale hash.
  const html = realPages.landing({ publicBaseUrl: config.publicBaseUrl, snapshot: null, recentTier: null });
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(inline.length, 1);
  const hash = createHash('sha256').update(inline[0], 'utf8').digest('base64');
  await withApp({}, async ({ port }) => {
    for (const path of ['/academic/mcp', '/academic/mcp/privacy', '/academic/mcp/terms', '/academic/mcp/nope']) {
      const r = await raw(port, 'GET', path);
      const csp = String(r.headers['content-security-policy']);
      assert.equal(csp, `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, path);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin', path);
    }
  });
});

test('page_assets_are_allowlisted_and_present', () => {
  const dir = new URL('../assets/', import.meta.url);
  const onDisk = new Set(readdirSync(dir));
  // Every allowlisted file exists, and every file but the example (read, not served) is allowlisted.
  for (const [name, asset] of Object.entries(ASSETS)) assert.ok(existsSync(new URL(asset.file, dir)), name);
  assert.deepEqual([...onDisk].filter(f => !Object.values(ASSETS).some(a => a.file === f)), ['example.json']);
  // Every asset the pages reference is allowlisted.
  const ctx = { publicBaseUrl: config.publicBaseUrl, snapshot: null, recentTier: null };
  const referenced = new Set<string>();
  for (const page of Object.values(realPages)) {
    for (const m of page(ctx).matchAll(/\/academic\/mcp\/assets\/([^"')?\s]+)/g)) referenced.add(m[1]);
  }
  assert.deepEqual([...referenced].sort(), ['dm-sans-latin-ext-wght-normal.woff2', 'dm-sans-latin-wght-normal.woff2', 'favicon.svg', 'icon.png', 'og.png']);
  for (const name of referenced) assert.ok(Object.hasOwn(ASSETS, name), name);
});
