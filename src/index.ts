// Entry point: config, clients, usage log, MCP handler, HTTP server on 0.0.0.0:8080, SIGTERM/SIGINT drain.
// Output is startup lines and fixed warnings only; nothing here prints request data or config values.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { loadConfig, type Config } from './config.js';
import { ContentClient } from './content.js';
import { GraphClient } from './graph.js';
import { createApp, drain, recordToolCalls, trackInFlight } from './http.js';
import { BUILD_CAP, BuildCap, RATE_LIMIT_PER_MINUTE, RateLimiter, VENDOR_RANGES, VENDOR_RATE_LIMIT_PER_MINUTE } from './limits.js';
import { OpenAlexClient } from './openalex.js';
import { pages } from './pages/index.js';
import { createServerFactory } from './tools.js';
import { UsageLog } from './usage.js';

const HOST = '0.0.0.0';
const PORT = 8080;
/** In-flight requests get this long after SIGTERM; the pod's grace period is 100 s. */
const DRAIN_TIMEOUT_MS = 90_000;
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url));

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  // loadConfig's messages name the variable, never its value.
  console.error(err instanceof Error ? err.message : 'invalid configuration');
  process.exit(1);
}

const graph = new GraphClient(config);
const openalex = new OpenAlexClient(config.openalexKey);
const content = new ContentClient();
const usage = new UsageLog(config.usageDbPath, { now: () => new Date() });
// A path that can't be opened is a deploy error: fail now, not run for weeks without a usage log.
// UsageLog has already warned with the error kind; this line names the variable, never its value.
if (!usage.isOpen) {
  console.error('usage log: cannot open USAGE_DB_PATH; exiting');
  process.exit(1);
}
const buildCap = new BuildCap(BUILD_CAP);
const limiter = new RateLimiter({
  perMinute: RATE_LIMIT_PER_MINUTE, vendorPerMinute: VENDOR_RATE_LIMIT_PER_MINUTE, vendorRanges: VENDOR_RANGES, now: Date.now,
});
const factory = createServerFactory({
  graph, openalex, content, buildCap, version: VERSION, publicBaseUrl: config.publicBaseUrl, now: () => new Date(),
  onToolSettled: recordToolCalls(usage),
});
const handler = createMcpHandler(factory, { responseMode: 'sse', keepAliveMs: 15_000 });

// One resolve so the pages have a graph snapshot date; a failure only leaves it blank.
await graph.resolve([]).catch(() => {});

const tracked = trackInFlight(createApp({
  config, mcp: handler, pages, graphMeta: () => graph.lastMeta, limiter, usage, assetsDir: ASSETS_DIR,
}));
const server = createServer(tracked.listener);
server.listen(PORT, HOST, () => {
  console.log(`inciteful-mcp ${VERSION} listening on ${HOST}:${PORT}`);
});

// SIGTERM from Kubernetes and docker stop; SIGINT for Ctrl-C in a local `docker run -it` (as PID 1,
// node has no default action for either).
let stopping = false;
const onStop = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: draining`);
  void (async () => {
    const finished = await drain(server, tracked, DRAIN_TIMEOUT_MS).catch(() => false);
    if (!finished) console.warn('drain timed out; closing open connections');
    await handler.close().catch(() => {});
    usage.close();
    process.exit(0);
  })();
};
process.on('SIGTERM', onStop);
process.on('SIGINT', onStop);
