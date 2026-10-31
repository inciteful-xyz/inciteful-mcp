// Limits and constants for the hosted server (plan Global Constraints), the caller key, the rate
// limiter and the build cap.

import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { BuildDeadlineError } from './errors.js';
import type { BuildCapLike } from './types.js';

/** The eight tool names. `tools.ts` registers exactly these; the usage log stores any other name as NULL. */
export const TOOL_NAMES = [
  'search_literature', 'get_papers', 'find_similar_papers', 'explore_citation_network',
  'connect_papers', 'query_citation_graph', 'read_paper', 'export_citations',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Ceiling on one tool call. The graph call behind a timed-out tool call keeps running upstream. */
export const TOOL_CEILING_MS = 90_000;
/**
 * Added to the ceiling before a tool call's non-build work is aborted, so a build that reaches the
 * deadline reports "still building" (the build cap's error) rather than the generic timeout.
 */
export const GRACE_MS = 1_000;
/** Longest wait for a graph's `metadata` after its query; the stats are dropped when it runs out. */
export const METADATA_WAIT_MS = 5_000;
/** Graph builds in flight at once. A build is any call to `/query`, `/paper/similar` or `/connector`. */
export const BUILD_CAP = 4;

/** `get_papers` and `export_citations`. */
export const MAX_PAPER_IDS = 100;
/** Seeds per graph tool. */
export const MAX_SEEDS = 500;
/** `limit` caps: `search_literature`; `find_similar_papers` and `explore_citation_network`; `query_citation_graph`. */
export const MAX_SEARCH_LIMIT = 50;
export const MAX_ANALYSIS_LIMIT = 100;
export const MAX_SQL_LIMIT = 500;
/** Characters in `query_citation_graph`'s `sql` and `search_literature`'s `query`. */
export const MAX_SQL_CHARS = 10_000;
export const MAX_QUERY_CHARS = 1_000;
/** Characters in one paper id or seed (a DOI, OpenAlex ID, PMID or PMCID). */
export const MAX_ID_CHARS = 300;
/** `read_paper`'s `max_chars`. */
export const MAX_READ_CHARS = 50_000;
/** Serialized result size (`Buffer.byteLength` of the JSON) above which rows are trimmed. */
export const OUTPUT_CAP_BYTES = 60_000;
/** Seed-set links to the web app carry at most this many ids, to fit URL limits. */
export const URL_SEED_CAP = 50;

/** Requests per minute per caller key, and per vendor range for keys inside one. */
export const RATE_LIMIT_PER_MINUTE = 60;
export const VENDOR_RATE_LIMIT_PER_MINUTE = 600;

/** Anthropic's published egress range. */
export const ANTHROPIC_RANGES: readonly string[] = ['160.79.104.0/21'];

/**
 * OpenAI's published ChatGPT actions egress ranges, from https://openai.com/chatgpt-actions.json
 * (fetched 2026-10-30; the file's creationTime is 2026-10-27T18:08:43). Refresh from that URL.
 */
export const OPENAI_RANGES: readonly string[] = [
  '104.208.184.192/28', '104.210.139.192/28', '104.210.139.224/28', '13.237.176.161/32', '13.238.110.96/32',
  '13.65.138.112/28', '13.67.72.16/28', '13.71.2.208/28', '13.76.116.80/28', '13.76.32.208/28', '13.83.237.176/28',
  '132.196.82.48/28', '134.138.52.16/28', '134.138.52.64/28', '134.138.57.64/28', '134.138.57.80/28',
  '134.149.233.80/28', '134.33.102.192/28', '135.116.136.160/28', '135.13.64.240/28', '135.220.73.208/28',
  '135.222.99.32/28', '135.237.133.48/28', '137.135.191.176/28', '145.132.136.96/28', '15.168.252.168/32',
  '172.162.248.64/28', '172.170.1.80/28', '172.170.225.0/28', '172.170.241.80/28', '172.172.206.48/28',
  '172.175.152.224/28', '172.177.53.240/28', '172.183.143.224/28', '172.192.112.208/28', '172.198.58.176/28',
  '172.198.79.112/28', '172.199.137.80/28', '172.204.96.80/28', '172.206.38.240/28', '172.207.1.32/28',
  '172.215.215.32/28', '191.232.238.96/28', '191.234.167.144/28', '191.237.249.64/28', '20.102.212.144/28',
  '20.125.112.224/28', '20.168.7.192/28', '20.169.78.48/28', '20.169.78.64/28', '20.169.86.224/28',
  '20.170.184.16/28', '20.170.184.32/28', '20.170.184.48/28', '20.170.184.64/28', '20.170.184.80/28',
  '20.172.29.32/28', '20.206.101.192/28', '20.212.62.208/28', '20.215.187.208/28', '20.215.219.208/28',
  '20.219.161.192/28', '20.219.184.96/28', '20.227.140.32/28', '20.228.106.176/28', '20.235.87.224/28',
  '20.249.63.208/28', '20.250.136.64/28', '20.254.201.208/28', '20.44.100.224/28', '20.45.178.144/28',
  '20.55.229.144/28', '20.57.199.192/28', '20.63.221.64/28', '20.78.130.48/28', '20.98.18.80/28',
  '23.101.217.176/28', '23.102.141.32/28', '23.98.186.64/28', '23.98.186.96/28', '4.151.119.48/28',
  '4.151.71.176/28', '4.189.118.208/28', '4.197.115.112/28', '4.197.64.0/28', '4.197.64.48/28', '4.201.232.64/28',
  '4.205.128.176/28', '4.218.24.64/28', '4.226.200.16/28', '4.226.226.32/28', '40.119.36.240/28', '40.124.161.0/28',
  '43.202.230.227/32', '44.249.227.138/32', '48.221.184.80/28', '48.221.184.96/28', '48.221.40.176/28',
  '51.57.0.96/28', '51.59.24.64/28', '51.59.24.80/28', '51.59.48.80/28', '52.148.129.32/28', '52.165.212.48/28',
  '52.17.188.55/32', '52.172.129.160/28', '52.173.221.16/28', '52.173.234.16/28', '52.173.234.80/28',
  '52.190.137.144/28', '52.190.137.16/28', '52.190.139.48/28', '52.190.142.64/28', '52.190.251.112/28',
  '52.208.217.159/32', '52.231.30.48/28', '52.231.39.144/28', '52.242.132.224/28', '52.242.132.240/28',
  '52.255.109.144/28', '52.255.109.80/28', '52.255.109.96/28', '52.255.111.0/28', '52.43.161.225/32',
  '54.180.197.31/32', '56.155.71.179/32', '57.154.174.112/28', '57.154.187.32/28', '68.154.28.96/28',
  '68.220.57.64/28', '70.153.32.16/28', '70.153.32.32/28', '70.156.152.96/28', '74.161.200.96/28',
  '74.224.217.64/28', '74.226.253.160/28', '74.248.37.160/28', '74.7.35.112/28', '74.7.35.48/28', '74.7.36.64/28',
  '74.7.36.80/28', '74.7.36.96/28', '85.211.128.16/28', '85.211.128.32/28', '9.129.0.0/16', '9.160.128.16/28',
  '9.160.128.64/28', '9.160.96.16/28', '9.205.128.32/28', '9.205.128.48/28', '9.205.8.48/28', '9.205.8.64/28',
  '9.234.96.192/28', '9.234.97.96/28',
];

/** Every vendor range; each range gets its own shared bucket. */
export const VENDOR_RANGES: readonly string[] = [...ANTHROPIC_RANGES, ...OPENAI_RANGES];

/** Usage rows older than this are purged. */
export const USAGE_RETENTION_DAYS = 90;
/** Characters kept of the client-supplied `clientInfo` name and version. */
export const USAGE_CLIENT_MAX_CHARS = 100;
/** Random bytes in the daily `ip_hash` salt. */
export const USAGE_SALT_BYTES = 32;

// ---------------------------------------------------------------------------------------------
// Caller key

/** The eight 16-bit groups of an IPv6 address (zone id dropped), or null. */
function ipv6Groups(addr: string): number[] | null {
  const bare = addr.replace(/%.*$/, '');
  if (isIP(bare) !== 6) return null;
  let text = bare;
  // A trailing dotted IPv4 part becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const parse = (part: string) => (part ? part.split(':').map(h => parseInt(h, 16)) : []);
  const left = parse(head);
  const right = tail === null ? [] : parse(tail);
  const fill = tail === null ? [] : new Array<number>(8 - left.length - right.length).fill(0);
  const groups = [...left, ...fill, ...right];
  return groups.length === 8 ? groups : null;
}

/** IPv4 stays as it is; IPv4-mapped IPv6 becomes IPv4; other IPv6 becomes its /64. Null if not an IP. */
function normalizeIp(raw: string): string | null {
  const addr = raw.trim();
  if (isIP(addr) === 4) return addr;
  const g = ipv6Groups(addr);
  if (!g) return null;
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
  }
  return `${g.slice(0, 4).map(x => x.toString(16)).join(':')}::/64`;
}

/**
 * The rate-limit and usage key: `CF-Connecting-IP` when it holds an IP, else the TCP peer.
 * `X-Forwarded-For` is never read: any client can set it.
 */
export function callerKey(req: IncomingMessage): string {
  const header = req.headers['cf-connecting-ip'];
  const cf = typeof header === 'string' ? normalizeIp(header) : null;
  if (cf) return cf;
  const peer = req.socket.remoteAddress;
  return (peer && normalizeIp(peer)) ?? 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Rate limiter

const ipv4ToInt = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

type Range = { label: string; base: number; size: number };

function parseRange(cidr: string): Range {
  const [ip, bits] = cidr.split('/');
  const prefix = Number(bits);
  if (isIP(ip) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`invalid IPv4 CIDR: ${cidr}`);
  const size = 2 ** (32 - prefix);
  return { label: cidr, base: Math.floor(ipv4ToInt(ip) / size) * size, size };
}

type Bucket = { tokens: number; at: number; capacity: number };

/** Buckets kept before full (idle) ones are swept. */
const BUCKET_SWEEP_AT = 10_000;

/**
 * A token bucket per caller key, refilling continuously at `perMinute` per minute up to `perMinute`.
 * Keys inside a vendor range share that range's bucket of `vendorPerMinute`.
 */
export class RateLimiter {
  readonly #perMinute: number;
  readonly #vendorPerMinute: number;
  readonly #ranges: Range[];
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(opts: { perMinute: number; vendorPerMinute: number; vendorRanges: readonly string[]; now: () => number }) {
    this.#perMinute = opts.perMinute;
    this.#vendorPerMinute = opts.vendorPerMinute;
    this.#ranges = opts.vendorRanges.map(parseRange);
    this.#now = opts.now;
  }

  check(key: string): { ok: boolean; retryAfterSecs: number } {
    const now = this.#now();
    const range = isIP(key) === 4 ? this.#rangeOf(ipv4ToInt(key)) : null;
    const id = range ? `range:${range.label}` : `key:${key}`;
    const capacity = range ? this.#vendorPerMinute : this.#perMinute;
    let bucket = this.#buckets.get(id);
    if (!bucket) {
      if (this.#buckets.size >= BUCKET_SWEEP_AT) this.#sweep(now);
      bucket = { tokens: capacity, at: now, capacity };
      this.#buckets.set(id, bucket);
    }
    this.#refill(bucket, now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, retryAfterSecs: 0 };
    }
    const msPerToken = 60_000 / capacity;
    // Rounded to whole ms first, so float error can't add a second.
    const waitMs = Math.round((1 - bucket.tokens) * msPerToken);
    return { ok: false, retryAfterSecs: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  #rangeOf(ip: number): Range | null {
    return this.#ranges.find(r => ip >= r.base && ip < r.base + r.size) ?? null;
  }

  #refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + (elapsed * bucket.capacity) / 60_000);
    bucket.at = now;
  }

  /** Drops buckets that have refilled to capacity: forgetting them changes nothing. */
  #sweep(now: number): void {
    for (const [id, bucket] of this.#buckets) {
      this.#refill(bucket, now);
      if (bucket.tokens >= bucket.capacity) this.#buckets.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Build cap

type Build = {
  key: string;
  fn: () => Promise<unknown>;
  /** While waiting: the latest deadline of the calls attached to it. */
  deadline: number;
  started: boolean;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

/**
 * At most `max` graph builds in flight. Calls with the same key share one build and one slot.
 * A call that reaches its deadline is rejected with `BuildDeadlineError`; a build that has not
 * started by then never starts, and one that has keeps running and holds its slot and key until it
 * settles, so a retry attaches to it instead of starting a duplicate build upstream.
 */
export class BuildCap implements BuildCapLike {
  readonly #max: number;
  readonly #now: () => number;
  readonly #builds = new Map<string, Build>();
  readonly #queue: Build[] = [];
  #active = 0;

  constructor(max: number, now: () => number = Date.now) {
    this.#max = max;
    this.#now = now;
  }

  /** Builds running (holding a slot). */
  inFlight(): number {
    return this.#active;
  }

  run<T>(key: string, fn: () => Promise<T>, deadlineAt: number): Promise<T> {
    let build = this.#builds.get(key);
    if (build) {
      if (!build.started) build.deadline = Math.max(build.deadline, deadlineAt);
    } else {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
      build = { key, fn, deadline: deadlineAt, started: false, promise, resolve, reject };
      this.#builds.set(key, build);
      this.#queue.push(build);
      this.#pump();
    }
    return this.#wait(build, deadlineAt) as Promise<T>;
  }

  #wait(build: Build, deadlineAt: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BuildDeadlineError());
        this.#expire(build);
      }, Math.max(0, deadlineAt - this.#now()));
      build.promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /** Forgets a build that is still waiting once every call attached to it has passed its deadline. */
  #expire(build: Build): void {
    if (build.started || build.deadline > this.#now()) return;
    const i = this.#queue.indexOf(build);
    if (i >= 0) this.#queue.splice(i, 1);
    if (this.#builds.get(build.key) === build) this.#builds.delete(build.key);
  }

  #pump(): void {
    while (this.#active < this.#max && this.#queue.length) {
      const build = this.#queue.shift()!;
      if (build.deadline <= this.#now()) {
        if (this.#builds.get(build.key) === build) this.#builds.delete(build.key);
        continue;
      }
      this.#start(build);
    }
  }

  #start(build: Build): void {
    build.started = true;
    this.#active += 1;
    let running: Promise<unknown>;
    try {
      running = Promise.resolve(build.fn());
    } catch (err) {
      running = Promise.reject(err);
    }
    const release = () => {
      this.#active -= 1;
      if (this.#builds.get(build.key) === build) this.#builds.delete(build.key);
      this.#pump();
    };
    running.then(
      (v) => { release(); build.resolve(v); },
      (e) => { release(); build.reject(e); },
    );
  }
}
