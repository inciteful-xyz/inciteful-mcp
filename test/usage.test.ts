import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { UsageLog } from '../src/usage.js';
import type { UsageRow } from '../src/types.js';

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.23';
/** sha256(32 bytes of 0x01 + IP) and sha256(32 bytes of 0x02 + IP), hex. */
const HASH_SALT_1 = '3acdd70ddf793d50c3b2a9163488ba2c3e351d0db77e81519cf69d996ebc379d';
const HASH_SALT_2 = '0504104ba1a6b76c17adba7185151dbb3e19da0c13e65c97caefdea6f9bba510';

const dbPath = () => join(mkdtempSync(join(tmpdir(), 'usage-test-')), 'usage.sqlite');

/** A clock the test moves by assigning `clock.t`. */
function clockAt(iso: string) {
  const clock = { t: new Date(iso), now: () => clock.t };
  return clock;
}

/** Salt n is n bytes of the value n (1, 2, ...), so each salt is distinct and known. */
function countingRng() {
  const rng = { calls: [] as number[], fn: (n: number) => { rng.calls.push(n); return Buffer.alloc(n, rng.calls.length); } };
  return rng;
}

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  tool: 'search_literature', clientName: 'claude-ai', clientVersion: '1.0.0', callerKey: IP, durationMs: 120,
  outcome: 'ok', graphPapers: null, graphDepth: null, openalexCalls: null, ...over,
});

function readRows(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM usage ORDER BY rowid').all().map((r) => ({ ...r }));
  } finally { db.close(); }
}

test('salt_is_random_and_rotates_at_utc_midnight', () => {
  const path = dbPath();
  const clock = clockAt('2026-10-30T23:59:58.000Z');
  const rng = countingRng();
  const log = new UsageLog(path, { now: clock.now, randomBytes: rng.fn });
  log.record(row());
  clock.t = new Date('2026-10-30T23:59:59.000Z');
  log.record(row());
  clock.t = new Date('2026-10-31T00:00:00.000Z');
  log.record(row());
  log.close();

  // sha256(salt + callerKey): the salt changes with the UTC date, and only then.
  assert.deepEqual(readRows(path).map((r) => r.ip_hash), [HASH_SALT_1, HASH_SALT_1, HASH_SALT_2]);
  // 32 random bytes per salt, one salt per UTC day.
  assert.deepEqual(rng.calls, [32, 32]);

  // With the real RNG, two logs on the same day give different hashes: the salt is not derived from the date.
  const a = dbPath();
  const b = dbPath();
  const sameDay = clockAt('2026-10-30T12:00:00.000Z');
  for (const p of [a, b]) {
    const l = new UsageLog(p, { now: sameDay.now });
    l.record(row());
    l.close();
  }
  const [ha] = readRows(a).map((r) => r.ip_hash);
  const [hb] = readRows(b).map((r) => r.ip_hash);
  assert.match(String(ha), /^[0-9a-f]{64}$/);
  assert.match(String(hb), /^[0-9a-f]{64}$/);
  assert.notEqual(ha, hb);
});

test('nulls_stored_as_null', () => {
  const path = dbPath();
  const clock = clockAt('2026-10-30T18:02:11.123Z');
  const log = new UsageLog(path, { now: clock.now, randomBytes: countingRng().fn });
  log.record(row({ clientName: null, clientVersion: null }));
  log.record(row({
    tool: 'explore_citation_network', outcome: 'timeout', durationMs: 90_000.6, graphPapers: 0, graphDepth: 2, openalexCalls: 0,
  }));
  // Client-supplied strings are cut to 100 characters.
  log.record(row({ clientName: 'n'.repeat(10_000), clientVersion: 'v'.repeat(10_000) }));
  log.close();

  assert.deepEqual(readRows(path), [
    {
      ts: '2026-10-30T18:02:11.123Z', tool: 'search_literature', client_name: null, client_version: null, ip_hash: HASH_SALT_1,
      duration_ms: 120, outcome: 'ok', graph_papers: null, graph_depth: null, openalex_calls: null, count: null,
    },
    {
      // A real 0 stays 0; only absent values are NULL. Durations are whole milliseconds.
      ts: '2026-10-30T18:02:11.123Z', tool: 'explore_citation_network', client_name: 'claude-ai', client_version: '1.0.0',
      ip_hash: HASH_SALT_1, duration_ms: 90_001, outcome: 'timeout', graph_papers: 0, graph_depth: 2, openalex_calls: 0, count: null,
    },
    {
      ts: '2026-10-30T18:02:11.123Z', tool: 'search_literature', client_name: 'n'.repeat(100), client_version: 'v'.repeat(100),
      ip_hash: HASH_SALT_1, duration_ms: 120, outcome: 'ok', graph_papers: null, graph_depth: null, openalex_calls: null, count: null,
    },
  ]);
});

test('stores_no_raw_ip_and_uses_wal', () => {
  const path = dbPath();
  const log = new UsageLog(path, { now: clockAt('2026-10-30T18:02:11.000Z').now });
  log.record(row());
  log.recordRejection(IP);
  log.close();
  const values = readRows(path).flatMap((r) => Object.values(r)).map(String);
  assert.ok(values.length > 0);
  assert.ok(values.every((v) => !v.includes(IP)));
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'wal' });
  } finally { db.close(); }
});

test('unknown_tool_is_null', () => {
  const path = dbPath();
  const log = new UsageLog(path, { now: clockAt('2026-10-30T18:02:11.000Z').now });
  const tools = [
    'search_literature', 'get_papers', 'find_similar_papers', 'explore_citation_network',
    'connect_papers', 'query_citation_graph', 'read_paper', 'export_citations',
    'drop_table', 'SEARCH_LITERATURE', '', 'toString', '__proto__', null,
  ];
  for (const tool of tools) log.record(row({ tool, outcome: 'tool_error' }));
  log.close();
  assert.deepEqual(readRows(path).map((r) => r.tool), [
    'search_literature', 'get_papers', 'find_similar_papers', 'explore_citation_network',
    'connect_papers', 'query_citation_graph', 'read_paper', 'export_citations',
    null, null, null, null, null, null,
  ]);
});

test('rejections_aggregated_per_minute', () => {
  const path = dbPath();
  const clock = clockAt('2026-10-30T12:00:05.000Z');
  const rng = countingRng();
  const log = new UsageLog(path, { now: clock.now, randomBytes: rng.fn });
  const at = (iso: string, key: string) => { clock.t = new Date(iso); log.recordRejection(key); };

  at('2026-10-30T12:00:05.000Z', IP);
  at('2026-10-30T12:00:30.000Z', IP);
  at('2026-10-30T12:00:30.000Z', OTHER_IP);
  at('2026-10-30T12:00:59.999Z', IP);
  at('2026-10-30T12:01:00.000Z', IP);
  // Nothing reaches the DB before a flush.
  assert.deepEqual(readRows(path), []);
  // At 12:01:00 the 12:00 minute has ended and is written; 12:01 is still open and stays in memory.
  log.flush();

  const pick = (r: Record<string, unknown>) => [r.ts, r.ip_hash === HASH_SALT_1 ? 'IP' : 'OTHER', r.count];
  assert.deepEqual(readRows(path).map(pick), [
    ['2026-10-30T12:00:00.000Z', 'IP', 3],
    ['2026-10-30T12:00:00.000Z', 'OTHER', 1],
  ]);
  const [first] = readRows(path);
  assert.deepEqual(first, {
    ts: '2026-10-30T12:00:00.000Z', tool: null, client_name: null, client_version: null, ip_hash: HASH_SALT_1,
    duration_ms: null, outcome: 'rate_limited', graph_papers: null, graph_depth: null, openalex_calls: null, count: 3,
  });

  // A flush mid-minute writes nothing for the current minute.
  at('2026-10-30T12:01:30.000Z', IP);
  log.flush();
  assert.equal(readRows(path).length, 2);
  // The first flush after the minute ends writes it once.
  clock.t = new Date('2026-10-30T12:02:00.000Z');
  log.flush();
  log.flush();
  assert.deepEqual(readRows(path).map(pick).slice(2), [['2026-10-30T12:01:00.000Z', 'IP', 2]]);

  // close() writes every pending minute, the current one included.
  at('2026-10-30T12:02:10.000Z', IP);
  log.close();
  assert.deepEqual(readRows(path).map(pick), [
    ['2026-10-30T12:00:00.000Z', 'IP', 3],
    ['2026-10-30T12:00:00.000Z', 'OTHER', 1],
    ['2026-10-30T12:01:00.000Z', 'IP', 2],
    ['2026-10-30T12:02:00.000Z', 'IP', 1],
  ]);
});

test('purge_deletes_over_90_days', () => {
  const path = dbPath();
  const clock = clockAt('2026-07-01T00:00:00.000Z');
  const log = new UsageLog(path, { now: clock.now });
  for (const iso of [
    '2026-07-01T00:00:00.000Z',
    '2026-07-01T23:59:59.999Z',
    '2026-07-02T00:00:00.000Z',
    '2026-07-03T00:00:00.000Z',
  ]) {
    clock.t = new Date(iso);
    log.record(row());
  }
  // 2026-07-01 + 90 days = 2026-09-29. A row exactly 90 days old stays; 1 ms older goes.
  clock.t = new Date('2026-09-29T00:00:00.000Z');
  assert.equal(log.purge(), 0);
  clock.t = new Date('2026-09-29T00:00:00.001Z');
  assert.equal(log.purge(), 1);
  clock.t = new Date('2026-09-30T00:00:00.000Z');
  assert.equal(log.purge(), 1);
  log.close();
  assert.deepEqual(readRows(path).map((r) => r.ts), ['2026-07-02T00:00:00.000Z', '2026-07-03T00:00:00.000Z']);

  // Startup purges too.
  const reopened = new UsageLog(path, { now: () => new Date('2026-10-01T00:00:00.000Z') });
  reopened.close();
  assert.deepEqual(readRows(path).map((r) => r.ts), ['2026-07-03T00:00:00.000Z']);
});

test('timers_are_unrefd', (t) => {
  const timers = new Map<number | undefined, { fn: () => void; timer: NodeJS.Timeout }>();
  const real = globalThis.setInterval;
  const spy = t.mock.method(globalThis, 'setInterval', ((fn: () => void, ms?: number) => {
    const timer = real(fn, ms);
    timers.set(ms, { fn, timer });
    return timer;
  }) as typeof setInterval);
  const path = dbPath();
  const clock = clockAt('2026-07-01T12:00:05.000Z');
  const log = new UsageLog(path, { now: clock.now });
  spy.mock.restore();
  try {
    assert.deepEqual([...timers.keys()].sort((a, b) => Number(a) - Number(b)), [60_000, 86_400_000]);
    assert.ok([...timers.values()].every((x) => !x.timer.hasRef()));

    // The 60 s callback flushes and does not purge; the 24 h callback purges.
    log.record(row());
    log.recordRejection(IP);
    clock.t = new Date('2026-12-01T00:00:00.000Z');
    timers.get(60_000)!.fn();
    assert.deepEqual(readRows(path).map((r) => r.outcome), ['ok', 'rate_limited']);
    timers.get(86_400_000)!.fn();
    assert.equal(readRows(path).length, 0);
  } finally { log.close(); }
});

test('flush_runs_every_minute_and_purge_daily', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const path = dbPath();
  const clock = clockAt('2026-07-01T12:00:05.000Z');
  const log = new UsageLog(path, { now: clock.now });
  try {
    log.record(row());
    log.recordRejection(IP);
    clock.t = new Date('2026-07-01T12:01:05.000Z');
    t.mock.timers.tick(59_999);
    assert.equal(readRows(path).length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(readRows(path).map((r) => r.outcome), ['ok', 'rate_limited']);

    // Far past retention, the next 60 s tick still leaves the old rows: purge is not on the minute timer.
    clock.t = new Date('2026-12-01T00:00:00.000Z');
    t.mock.timers.tick(60_000);
    assert.equal(readRows(path).length, 2);
    t.mock.timers.tick(86_400_000 - 120_000);
    assert.equal(readRows(path).length, 0);
  } finally { log.close(); }
});

test('db_failure_does_not_throw', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'usage-test-'));
  const file = join(dir, 'not-a-dir');
  writeFileSync(file, '');
  const unwritable = join(file, 'usage.sqlite');
  const clock = clockAt('2026-10-30T18:02:11.000Z');

  // Open fails: the constructor throws (startup exits on it), and nothing is printed here.
  assert.throws(() => new UsageLog(unwritable, { now: clock.now }), { code: 'ERR_SQLITE_ERROR' });
  assert.equal(warn.mock.callCount(), 0);

  // Writes fail after a good open (the table is dropped underneath): no throw, one warning per kind.
  const path = dbPath();
  const log = new UsageLog(path, { now: clock.now });
  const other = new DatabaseSync(path);
  other.exec('DROP TABLE usage');
  other.close();
  log.record(row());
  log.record(row());
  log.recordRejection(IP);
  clock.t = new Date('2026-10-30T18:03:00.000Z'); // the rejection's minute has ended
  log.flush();
  assert.equal(log.purge(), 0);
  log.close();
  log.close();
  const messages = warn.mock.calls.map((c) => c.arguments.join(' '));
  assert.deepEqual(messages, [
    'usage log: write failed (ERR_SQLITE_ERROR)',
    'usage log: flush failed (ERR_SQLITE_ERROR)',
    'usage log: purge failed (ERR_SQLITE_ERROR)',
  ]);
  for (const m of messages) {
    assert.ok(!m.includes(dir) && !m.includes(path) && !m.includes(IP));
  }
});
