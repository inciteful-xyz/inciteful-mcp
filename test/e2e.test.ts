// End to end: the real app, the real tool factory and the real usage log, with fake upstreams.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { inspect } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { loadConfig } from '../src/config.js';
import { ContentClient } from '../src/content.js';
import { GraphClient } from '../src/graph.js';
import { createApp, recordToolCalls } from '../src/http.js';
import { BuildCap, RateLimiter, RATE_LIMIT_PER_MINUTE, VENDOR_RANGES, VENDOR_RATE_LIMIT_PER_MINUTE } from '../src/limits.js';
import { OpenAlexClient } from '../src/openalex.js';
import { createServerFactory } from '../src/tools.js';
import type { Pages } from '../src/types.js';
import { UsageLog } from '../src/usage.js';
import { serve } from './helpers.js';

const KEY = 'sk-SENTINEL-KEY-7f3a91c2';
const QUERY = 'SENTINELQUERY_vagus_b81';
const SQL_MARK = 'SENTINELSQL_c44';
const SEED = '10.9999/SENTINELSEED_d19';
const IP = '203.0.113.99';
const SENTINELS = [KEY, QUERY, SQL_MARK, SEED, 'SENTINELSEED', IP];

const pages: Pages = {
  landing: () => '<p>landing</p>', privacy: () => '<p>privacy</p>', terms: () => '<p>terms</p>', notFound: () => '<p>404</p>',
};

type Mode = 401 | 429 | 500 | 'network' | 'ok';

/** Upstream graph-api, OpenAlex and PMC behind one fake `fetch`. */
function upstreams() {
  const state = { mode: 'ok' as Mode, calls: [] as Array<{ url: string; authorization: string | null }> };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    state.calls.push({ url, authorization: headers.get('authorization') });
    if (state.mode === 'network') throw new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: 'ECONNREFUSED' }) });
    if (state.mode !== 'ok') {
      // Error bodies that echo the request, as a misbehaving upstream might.
      return new Response(`upstream error for ${url} ${String(init?.body ?? '')}`, { status: state.mode, headers: { 'retry-after': '30' } });
    }
    if (url.startsWith('https://api.openalex.org/works')) {
      return Response.json({ results: [], meta: { count: 0, next_cursor: null } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { state, fakeFetch };
}

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const config = loadConfig({
    GRAPH_API_PRIMARY_URL: 'http://graph-api-academic', GRAPH_API_SECONDARY_URL: 'http://graph-api', OPENALEX_ACADEMIC_API_KEY: KEY,
    PUBLIC_BASE_URL: 'https://incitefulmed.com/academic/mcp', USAGE_DB_PATH: join(dir, 'usage.sqlite'), ...env,
  });
  const { state, fakeFetch } = upstreams();
  const graph = new GraphClient(config, fakeFetch);
  const openalex = new OpenAlexClient(config.openalexKey, fakeFetch);
  const content = new ContentClient(fakeFetch);
  const usage = new UsageLog(config.usageDbPath, { now: () => new Date() });
  const buildCap = new BuildCap(4);
  const limiter = new RateLimiter({ perMinute: RATE_LIMIT_PER_MINUTE, vendorPerMinute: VENDOR_RATE_LIMIT_PER_MINUTE, vendorRanges: VENDOR_RANGES, now: Date.now });
  const factory = createServerFactory({
    graph, openalex, content, buildCap, version: '0.0.0-test', publicBaseUrl: config.publicBaseUrl, now: () => new Date(),
    onToolSettled: recordToolCalls(usage),
  });
  const mcp = createMcpHandler(factory, { responseMode: 'sse', keepAliveMs: 15_000 });
  const app = createApp({ config, mcp, pages, graphMeta: () => graph.lastMeta, limiter, usage, assetsDir: dir });
  return { config, state, graph, openalex, content, usage, buildCap, limiter, mcp, app };
}

type Seen = { status: number; method: string; headers: Array<[string, string]>; body: string; read: Promise<void> };

async function connect(base: string, opts: { modern: boolean; headers?: Record<string, string>; name?: string; seen?: Seen[] }) {
  const client = new Client({ name: opts.name ?? 'e2e-client', version: '3.1.4' }, opts.modern ? { versionNegotiation: { mode: 'auto' } } : undefined);
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/academic/mcp`), {
    requestInit: { headers: opts.headers ?? {} },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (opts.seen) {
        const copy = res.clone();
        const entry: Seen = { status: res.status, method: init?.method ?? 'GET', headers: [...res.headers], body: '', read: Promise.resolve() };
        // Chunk by chunk, so what arrived is kept even if the client closes the stream early.
        entry.read = (async () => {
          const decoder = new TextDecoder();
          try {
            for await (const chunk of copy.body ?? []) entry.body += decoder.decode(chunk as Uint8Array, { stream: true });
          } catch { /* closed by the client */ }
        })();
        opts.seen.push(entry);
      }
      return res;
    },
  });
  await client.connect(transport);
  return client;
}

/** Captures everything written to stdout and stderr while `fn` runs (and still passes it through). */
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const tap = (original: typeof out) => ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof out;
  process.stdout.write = tap(out);
  process.stderr.write = tap(err);
  try {
    const result = await fn();
    return { result, output: chunks.join('') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function usageRows(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT * FROM usage ORDER BY rowid').all().map(r => ({ ...r })); } finally { db.close(); }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test('key_and_request_data_never_leak', async () => {
  const s = setup();
  const server = await serve(s.app);
  const seen: Seen[] = [];
  const results: unknown[] = [];
  const { output } = await captureOutput(async () => {
    for (const modern of [true, false]) {
      const client = await connect(server.base, { modern, headers: { 'CF-Connecting-IP': IP }, seen });
      try {
        for (const mode of [401, 429, 500, 'network'] as const) {
          s.state.mode = mode;
          const calls: Array<[string, Record<string, unknown>]> = [
            ['search_literature', { query: QUERY }],
            ['find_similar_papers', { seeds: [SEED] }],
            ['explore_citation_network', { seeds: [SEED], analysis: 'important', title_all: [QUERY] }],
            ['query_citation_graph', { seeds: [SEED], sql: `SELECT paper_id FROM papers WHERE title = '${SQL_MARK}'` }],
            ['connect_papers', { from: SEED, to: `${SEED}x` }],
          ];
          for (const [name, args] of calls) {
            const r = await client.callTool({ name, arguments: args });
            assert.equal((r as { isError?: boolean }).isError, true, `${name} ${mode}`);
            results.push(r);
          }
        }
      } finally { await client.close(); }
    }
    await flush();
    s.usage.close();
    await s.mcp.close();
  });
  await server.close();

  // Upstreams were reached in every failure mode, and the key only ever travelled in Authorization.
  assert.ok(s.state.calls.some(c => c.url.startsWith('https://api.openalex.org/')));
  assert.ok(s.state.calls.some(c => c.url.startsWith('http://graph-api/openalex/')), 'failover to the secondary on network errors');
  for (const c of s.state.calls) {
    assert.ok(!c.url.includes(KEY));
    if (c.url.startsWith('https://api.openalex.org/')) assert.equal(c.authorization, `Bearer ${KEY}`);
    else assert.equal(c.authorization, null);
  }

  const haystacks: Array<[string, string]> = [
    ['stdout/stderr', output],
    ...seen.map((r, i): [string, string] => [`response ${i} (${r.status})`, `${JSON.stringify(r.headers)}\n${r.body}`]),
    ['tool results', JSON.stringify(results)],
    ['inspect config', inspect(s.config, { depth: 10, showHidden: true })],
    ['inspect config, no custom inspect', inspect(s.config, { depth: 10, showHidden: true, customInspect: false })],
    ['JSON config', JSON.stringify(s.config)],
    ['inspect clients', inspect([s.graph, s.openalex, s.content, s.buildCap, s.limiter, s.usage], { depth: 10, showHidden: true })],
    ['JSON clients', JSON.stringify([s.graph, s.openalex, s.content])],
  ];
  const rows = usageRows(s.config.usageDbPath);
  assert.equal(rows.length, 40, 'one usage row per tool call: 2 clients x 4 failure modes x 5 tools');
  for (const [i, row] of rows.entries()) {
    for (const [column, value] of Object.entries(row)) haystacks.push([`usage row ${i} ${column}`, String(value)]);
  }
  assert.ok(seen.length >= 40, `responses captured: ${seen.length}`);
  await Promise.all(seen.map(r => r.read));
  const empty = seen.filter(r => r.body === '' && r.status !== 202).map(r => `${r.method} ${r.status}`);
  assert.deepEqual(empty, [], 'every response with a body was read');
  for (const [where, text] of haystacks) {
    for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `${sentinel} leaked into ${where}`);
  }
});

test('one_usage_row_per_tool_call', async () => {
  const s = setup();
  const server = await serve(s.app);
  const ua = `e2e-agent/2.0 ${'x'.repeat(150)}`;
  const modern = await connect(server.base, { modern: true, name: 'e2e-modern' });
  await modern.listTools();
  await modern.callTool({ name: 'search_literature', arguments: { query: 'vagus nerve' } });
  await modern.callTool({ name: 'get_papers', arguments: { ids: ['W123'] } });
  await modern.close();
  const legacy = await connect(server.base, { modern: false, name: 'e2e-legacy', headers: { 'User-Agent': ua } });
  await legacy.listTools();
  await legacy.callTool({ name: 'search_literature', arguments: { query: 'vagus nerve' } });
  await legacy.close();
  await flush();
  s.usage.close();
  await s.mcp.close();
  await server.close();

  const rows = usageRows(s.config.usageDbPath).map(r => ({
    tool: r.tool, client_name: r.client_name, client_version: r.client_version, outcome: r.outcome,
    graph_papers: r.graph_papers, graph_depth: r.graph_depth, openalex_calls: r.openalex_calls, count: r.count,
  }));
  assert.deepEqual(rows, [
    // 2026-07-28: client info from the request envelope.
    { tool: 'search_literature', client_name: 'e2e-modern', client_version: '3.1.4', outcome: 'ok', graph_papers: null, graph_depth: null, openalex_calls: 1, count: null },
    { tool: 'get_papers', client_name: 'e2e-modern', client_version: '3.1.4', outcome: 'ok', graph_papers: null, graph_depth: null, openalex_calls: 1, count: null },
    // 2025: no client info on a stateless request, so the User-Agent, cut to 100 characters.
    { tool: 'search_literature', client_name: ua.slice(0, 100), client_version: null, outcome: 'ok', graph_papers: null, graph_depth: null, openalex_calls: 1, count: null },
  ]);
  for (const r of usageRows(s.config.usageDbPath)) {
    assert.match(String(r.ip_hash), /^[0-9a-f]{64}$/);
    assert.equal(typeof r.duration_ms, 'number');
    assert.ok(Number(r.duration_ms) >= 0);
  }
});

/** Every console call in src, as written. Only startup lines and warnings with fixed text or an error kind. */
const CONSOLE_ALLOWLIST = new Set([
  'console.warn(`usage log: ${op} failed (${kind})`);',
  "console.error(err instanceof Error ? err.message : 'invalid configuration');",
  'console.log(`inciteful-mcp ${VERSION} listening on ${HOST}:${PORT}`);',
  'console.log(`${signal}: draining`);',
  "console.error('usage log: cannot open USAGE_DB_PATH; exiting');",
  "console.warn('drain timed out; closing open connections');",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('console_calls_allowlisted', () => {
  const src = new URL('../src/', import.meta.url).pathname;
  const found: string[] = [];
  for (const file of sourceFiles(src)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!/\bconsole\b/.test(line)) continue;
      // The call itself, from `console.` to the end of the statement.
      found.push(/console\.\w+\(.*\);/.exec(line)?.[0] ?? line.trim());
    }
  }
  assert.ok(found.length > 0);
  for (const line of found) assert.ok(CONSOLE_ALLOWLIST.has(line), `console call not allowlisted: ${line}`);
  // process.stdout/stderr writes would bypass the allowlist.
  for (const file of sourceFiles(src)) assert.doesNotMatch(readFileSync(file, 'utf8'), /process\.(stdout|stderr)\.write/, file);
});
