// Usage log: one SQLite row per tool call, plus one row per (minute, caller) for rate-limit
// rejections. It never stores queries, SQL, seeds, paper ids or raw IPs: the caller key is kept only
// as sha256(salt + key), with a random salt that lives in memory and is replaced each UTC day.
// Failures never reach the caller; they log one warning that names the error kind only.

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { TOOL_NAMES, USAGE_CLIENT_MAX_CHARS, USAGE_RETENTION_DAYS, USAGE_SALT_BYTES } from './limits.js';
import type { UsageRow, UsageSink } from './types.js';

const FLUSH_INTERVAL_MS = 60_000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage (
    ts TEXT, tool TEXT, client_name TEXT, client_version TEXT, ip_hash TEXT, duration_ms INTEGER,
    outcome TEXT, graph_papers INTEGER, graph_depth INTEGER, openalex_calls INTEGER, count INTEGER
  );
  CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);
`;

type Op = 'open' | 'write' | 'flush' | 'purge' | 'close';

/** `err.code` or `err.name` when it is a plain identifier; never the message, which may hold a path. */
function errorKind(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | null;
  for (const v of [e?.code, e?.name]) {
    if (typeof v === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(v)) return v;
  }
  return 'Error';
}

/** Client-supplied strings are cut to a fixed length, without leaving half a surrogate pair. */
function clip(s: string | null): string | null {
  if (s === null || s.length <= USAGE_CLIENT_MAX_CHARS) return s;
  return s.slice(0, USAGE_CLIENT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, '');
}

const minuteOf = (d: Date) => new Date(Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS).toISOString();

export class UsageLog implements UsageSink {
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;
  private db: DatabaseSync | null = null;
  private insert: StatementSync | null = null;
  private insertRejection: StatementSync | null = null;
  private deleteOld: StatementSync | null = null;
  private salt: Buffer | null = null;
  private saltDay = '';
  /** Rejection counts by minute start (ISO), then ip_hash. flush() writes minutes that have ended. */
  private rejections = new Map<string, Map<string, number>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly warned = new Set<string>();

  constructor(path: string, opts: { now: () => Date; randomBytes?: (n: number) => Buffer }) {
    this.now = opts.now;
    this.randomBytes = opts.randomBytes ?? cryptoRandomBytes;
    try {
      const db = new DatabaseSync(path);
      try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec(SCHEMA);
        this.insert = db.prepare(
          `INSERT INTO usage (ts, tool, client_name, client_version, ip_hash, duration_ms, outcome, graph_papers, graph_depth, openalex_calls, count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.insertRejection = db.prepare(`INSERT INTO usage (ts, ip_hash, outcome, count) VALUES (?, ?, 'rate_limited', ?)`);
        this.deleteOld = db.prepare('DELETE FROM usage WHERE ts < ?');
      } catch (err) {
        db.close();
        throw err;
      }
      this.db = db;
    } catch (err) {
      this.warn('open', err);
      return;
    }
    this.purge();
    this.timers.push(
      setInterval(() => this.flush(), FLUSH_INTERVAL_MS).unref(),
      setInterval(() => this.purge(), PURGE_INTERVAL_MS).unref(),
    );
  }

  record(row: UsageRow): void {
    if (!this.insert) return;
    try {
      const now = this.now();
      this.insert.run(
        now.toISOString(),
        row.tool !== null && KNOWN_TOOLS.has(row.tool) ? row.tool : null,
        clip(row.clientName ?? null),
        clip(row.clientVersion ?? null),
        this.ipHash(row.callerKey, now),
        Math.round(row.durationMs),
        row.outcome,
        row.graphPapers ?? null,
        row.graphDepth ?? null,
        row.openalexCalls ?? null,
        row.count ?? null,
      );
    } catch (err) {
      this.warn('write', err);
    }
  }

  /** Counts a 429 in memory; one `rate_limited` row per (minute, caller) is written once the minute ends. */
  recordRejection(callerKey: string): void {
    if (!this.db) return;
    try {
      const now = this.now();
      const minute = minuteOf(now);
      const ipHash = this.ipHash(callerKey, now);
      let counts = this.rejections.get(minute);
      if (!counts) this.rejections.set(minute, (counts = new Map()));
      counts.set(ipHash, (counts.get(ipHash) ?? 0) + 1);
    } catch (err) {
      this.warn('write', err);
    }
  }

  /** Writes the rejection counts of every minute that has ended. */
  flush(): void {
    this.writeRejections(minuteOf(this.now()));
  }

  /** Deletes rows older than the retention window; returns how many. */
  purge(): number {
    if (!this.deleteOld) return 0;
    try {
      const cutoff = new Date(this.now().getTime() - USAGE_RETENTION_DAYS * DAY_MS).toISOString();
      return Number(this.deleteOld.run(cutoff).changes);
    } catch (err) {
      this.warn('purge', err);
      return 0;
    }
  }

  /** Stops the timers, writes every pending minute (the current one too) and closes the DB. */
  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.writeRejections(null);
    const db = this.db;
    this.db = null;
    this.insert = this.insertRejection = this.deleteOld = null;
    this.salt = null;
    this.saltDay = '';
    if (!db) return;
    try {
      db.close();
    } catch (err) {
      this.warn('close', err);
    }
  }

  /** Writes and forgets pending minutes before `before` (an ISO minute start), or all of them when null. */
  private writeRejections(before: string | null): void {
    const due = [...this.rejections.keys()].filter((m) => before === null || m < before);
    if (due.length === 0) return;
    const batches = due.map((m) => [m, this.rejections.get(m)!] as const);
    for (const m of due) this.rejections.delete(m);
    if (!this.db || !this.insertRejection) return;
    try {
      this.db.exec('BEGIN');
      try {
        for (const [minute, counts] of batches) {
          for (const [ipHash, count] of counts) this.insertRejection.run(minute, ipHash, count);
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      this.warn('flush', err);
    }
  }

  private ipHash(callerKey: string, now: Date): string {
    const day = now.toISOString().slice(0, 10);
    if (this.salt === null || day !== this.saltDay) {
      this.salt = this.randomBytes(USAGE_SALT_BYTES);
      this.saltDay = day;
    }
    return createHash('sha256').update(this.salt).update(callerKey).digest('hex');
  }

  private warn(op: Op, err: unknown): void {
    const kind = errorKind(err);
    const key = `${op}:${kind}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`usage log: ${op} failed (${kind})`);
  }
}
