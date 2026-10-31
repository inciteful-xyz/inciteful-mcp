// Usage log: one SQLite row per tool call, plus one row per (minute, caller) for rate-limit
// rejections. It never stores queries, SQL, seeds, paper ids or raw IPs: the caller key is kept only
// as sha256(salt + key), with a random salt that lives in memory and is replaced each UTC day.
// Failures never reach the caller; they log one warning that names the error kind only.

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { TOOL_NAMES, USAGE_RETENTION_DAYS, USAGE_SALT_BYTES } from './limits.js';
import type { UsageRow, UsageSink } from './types.js';

const FLUSH_INTERVAL_MS = 60_000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage (
    ts TEXT, tool TEXT, client_name TEXT, client_version TEXT, ip_hash TEXT, duration_ms INTEGER,
    outcome TEXT, graph_papers INTEGER, graph_depth INTEGER, openalex_calls INTEGER, count INTEGER
  );
  CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);
  -- One rejection row per (minute, ip_hash), however many flushes the minute spans.
  CREATE UNIQUE INDEX IF NOT EXISTS usage_rejection_minute ON usage (ts, ip_hash)
    WHERE outcome = 'rate_limited' AND duration_ms IS NULL;
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

export class UsageLog implements UsageSink {
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;
  private db: DatabaseSync | null = null;
  private insert: StatementSync | null = null;
  private upsertRejection: StatementSync | null = null;
  private deleteOld: StatementSync | null = null;
  private salt: Buffer | null = null;
  private saltDay = '';
  /** Rejection counts by `${minuteIso}\n${ipHash}`, written by flush(). */
  private rejections = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly warned = new Set<string>();

  constructor(path: string, opts: { now: () => Date; randomBytes?: (n: number) => Buffer }) {
    this.now = opts.now;
    this.randomBytes = opts.randomBytes ?? cryptoRandomBytes;
    try {
      const db = new DatabaseSync(path);
      try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec(SCHEMA);
        this.insert = db.prepare(
          `INSERT INTO usage (ts, tool, client_name, client_version, ip_hash, duration_ms, outcome, graph_papers, graph_depth, openalex_calls, count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.upsertRejection = db.prepare(
          `INSERT INTO usage (ts, ip_hash, outcome, count) VALUES (?, ?, 'rate_limited', ?)
           ON CONFLICT (ts, ip_hash) WHERE outcome = 'rate_limited' AND duration_ms IS NULL
           DO UPDATE SET count = usage.count + excluded.count`,
        );
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
      this.insert.run(
        this.now().toISOString(),
        row.tool !== null && KNOWN_TOOLS.has(row.tool) ? row.tool : null,
        row.clientName ?? null,
        row.clientVersion ?? null,
        this.ipHash(row.callerKey),
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

  /** Counts a 429 in memory; flush() writes one `rate_limited` row per (minute, caller). */
  recordRejection(callerKey: string): void {
    if (!this.db) return;
    try {
      const minute = new Date(Math.floor(this.now().getTime() / 60_000) * 60_000).toISOString();
      const key = `${minute}\n${this.ipHash(callerKey)}`;
      this.rejections.set(key, (this.rejections.get(key) ?? 0) + 1);
    } catch (err) {
      this.warn('write', err);
    }
  }

  flush(): void {
    if (this.rejections.size === 0) return;
    const pending = this.rejections;
    this.rejections = new Map();
    if (!this.db || !this.upsertRejection) return;
    try {
      this.db.exec('BEGIN');
      try {
        for (const [key, count] of pending) {
          const [minute, ipHash] = key.split('\n');
          this.upsertRejection.run(minute, ipHash, count);
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

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.flush();
    const db = this.db;
    this.db = null;
    this.insert = this.upsertRejection = this.deleteOld = null;
    this.rejections.clear();
    if (!db) return;
    try {
      db.close();
    } catch (err) {
      this.warn('close', err);
    }
  }

  private ipHash(callerKey: string): string {
    const day = this.now().toISOString().slice(0, 10);
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
