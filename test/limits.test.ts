import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { mock, test } from 'node:test';
import { BuildCap, callerKey, RateLimiter, VENDOR_RANGES } from '../src/limits.js';

const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

test('caller_key_rules', () => {
  // CF-Connecting-IP wins over the peer; X-Forwarded-For is never read.
  assert.equal(callerKey(req('10.0.0.5', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(callerKey(req('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' })), '10.0.0.5');
  assert.equal(callerKey(req('10.0.0.5', { 'cf-connecting-ip': ' 203.0.113.7 ' })), '203.0.113.7');
  // An unparseable header falls back to the peer.
  assert.equal(callerKey(req('10.0.0.5', { 'cf-connecting-ip': 'not-an-ip' })), '10.0.0.5');
  // IPv4-mapped IPv6 is IPv4, in either spelling.
  assert.equal(callerKey(req('::ffff:198.51.100.23')), '198.51.100.23');
  assert.equal(callerKey(req('10.0.0.5', { 'cf-connecting-ip': '::FFFF:198.51.100.23' })), '198.51.100.23');
  assert.equal(callerKey(req('::ffff:c633:6417')), '198.51.100.23');
  // IPv6 is cut to its /64.
  assert.equal(callerKey(req('10.0.0.5', { 'cf-connecting-ip': '2001:db8:1:2:3:4:5:6' })), '2001:db8:1:2::/64');
  assert.equal(callerKey(req('2001:db8:1:2:aaaa::1')), '2001:db8:1:2::/64');
  assert.equal(callerKey(req('2001:DB8::1')), '2001:db8:0:0::/64');
  assert.equal(callerKey(req('fe80::1%eth0')), 'fe80:0:0:0::/64');
  assert.equal(callerKey(req('::1')), '0:0:0:0::/64');
  // No peer address at all.
  assert.equal(callerKey(req(undefined)), 'unknown');
});

function limiter(t: { now: number }) {
  return new RateLimiter({
    perMinute: 2, vendorPerMinute: 3, now: () => t.now,
    vendorRanges: { anthropic: ['160.79.104.0/21'], openai: ['104.208.184.192/28', '9.129.0.0/16'] },
  });
}

test('vendor_cidr_edges', () => {
  const t = { now: 0 };
  const l = limiter(t);
  // The first and last addresses of the /21 share one bucket of 3.
  assert.deepEqual(l.check('160.79.104.0'), { ok: true, retryAfterSecs: 0 });
  assert.deepEqual(l.check('160.79.111.255'), { ok: true, retryAfterSecs: 0 });
  assert.deepEqual(l.check('160.79.108.9'), { ok: true, retryAfterSecs: 0 });
  assert.equal(l.check('160.79.104.0').ok, false);
  assert.equal(l.check('160.79.111.255').ok, false);
  // Just outside the range on either side: per-key buckets of 2.
  for (const outside of ['160.79.103.255', '160.79.112.0']) {
    assert.equal(l.check(outside).ok, true);
    assert.equal(l.check(outside).ok, true);
    assert.equal(l.check(outside).ok, false, outside);
  }
  // IPv6 keys never match an IPv4 range.
  assert.equal(l.check('2001:db8:1:2::/64').ok, true);
});

test('one_bucket_per_vendor_across_its_ranges', () => {
  const t = { now: 0 };
  const l = limiter(t);
  // Two OpenAI ranges share one bucket of 3, apart from Anthropic's.
  assert.equal(l.check('104.208.184.192').ok, true);
  assert.equal(l.check('9.129.0.1').ok, true);
  assert.equal(l.check('104.208.184.207').ok, true);
  assert.equal(l.check('9.129.255.255').ok, false);
  assert.equal(l.check('160.79.104.1').ok, true);
});

test('shipped_vendor_ranges_are_labelled_by_vendor', () => {
  assert.deepEqual(Object.keys(VENDOR_RANGES), ['anthropic', 'openai']);
  assert.deepEqual(VENDOR_RANGES.anthropic, ['160.79.104.0/21']);
  assert.ok(VENDOR_RANGES.openai.length > 100);
});

test('bucket_refills', () => {
  const t = { now: 1_000_000 };
  const l = limiter(t);
  assert.equal(l.check('203.0.113.7').ok, true);
  assert.equal(l.check('203.0.113.7').ok, true);
  // 2 per minute: one token every 30 s.
  assert.deepEqual(l.check('203.0.113.7'), { ok: false, retryAfterSecs: 30 });
  // Another key has its own bucket.
  assert.equal(l.check('198.51.100.23').ok, true);
  t.now += 10_000;
  assert.deepEqual(l.check('203.0.113.7'), { ok: false, retryAfterSecs: 20 });
  t.now += 20_000;
  assert.deepEqual(l.check('203.0.113.7'), { ok: true, retryAfterSecs: 0 });
  assert.equal(l.check('203.0.113.7').ok, false);
  // A long idle refills to the cap, never beyond it.
  t.now += 3_600_000;
  assert.equal(l.check('203.0.113.7').ok, true);
  assert.equal(l.check('203.0.113.7').ok, true);
  assert.equal(l.check('203.0.113.7').ok, false);
  // Rejections don't consume tokens: 30 s later exactly one call passes.
  t.now += 30_000;
  assert.equal(l.check('203.0.113.7').ok, true);
  assert.equal(l.check('203.0.113.7').ok, false);
});

// ---------------------------------------------------------------------------------------------
// BuildCap. Deadlines are `now() + 50` on an injected clock that moves with the mocked timers.

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function capClock() {
  mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { t: 5_000, now: () => clock.t, tick(ms: number) { clock.t += ms; mock.timers.tick(ms); } };
  return clock;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

/** Settles to 'ok:<value>' or 'err:<name>' so a test can inspect a promise without awaiting it. */
function track<T>(p: Promise<T>) {
  const state = { value: 'pending' as string };
  p.then(v => { state.value = `ok:${String(v)}`; }, e => { state.value = `err:${(e as Error).name}`; });
  return state;
}

test('cap_4_in_flight', async (t) => {
  t.after(() => mock.timers.reset());
  const clock = capClock();
  const cap = new BuildCap(4, clock.now);
  const gates = Array.from({ length: 6 }, () => deferred());
  const started: number[] = [];
  const results = gates.map((g, i) => track(cap.run(`k${i}`, () => { started.push(i); return g.promise; }, clock.now() + 50)));
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(cap.inFlight(), 4);
  gates[1].resolve('one');
  await flush();
  assert.equal(results[1].value, 'ok:one');
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(cap.inFlight(), 4);
  gates[0].reject(new TypeError('boom'));
  await flush();
  assert.equal(results[0].value, 'err:TypeError');
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  for (const g of gates) g.resolve('done');
  await flush();
  assert.equal(cap.inFlight(), 0);
});

test('same_key_attaches_without_slot', async (t) => {
  t.after(() => mock.timers.reset());
  const clock = capClock();
  const cap = new BuildCap(1, clock.now);
  const gate = deferred();
  let calls = 0;
  const fn = () => { calls += 1; return gate.promise; };
  const a = track(cap.run('same', fn, clock.now() + 50));
  const b = track(cap.run('same', fn, clock.now() + 50));
  await flush();
  assert.equal(calls, 1);
  assert.equal(cap.inFlight(), 1);
  gate.resolve('built');
  await flush();
  assert.equal(a.value, 'ok:built');
  assert.equal(b.value, 'ok:built');
  assert.equal(cap.inFlight(), 0);
  // Once settled, the key is free: the next call runs fn again.
  const c = track(cap.run('same', async () => { calls += 1; return 'again'; }, clock.now() + 50));
  await flush();
  assert.equal(c.value, 'ok:again');
  assert.equal(calls, 2);
});

test('deadline_rejects_but_fn_continues_and_holds_slot', async (t) => {
  t.after(() => mock.timers.reset());
  const clock = capClock();
  const cap = new BuildCap(1, clock.now);
  const slow = deferred();
  const first = track(cap.run('slow', () => slow.promise, clock.now() + 50));
  await flush();
  clock.tick(50);
  await flush();
  assert.equal(first.value, 'err:BuildDeadlineError');
  // fn is still running upstream: the slot stays taken.
  assert.equal(cap.inFlight(), 1);
  // A retry with the same key attaches to the running build instead of taking a slot.
  let retryCalls = 0;
  const retry = track(cap.run('slow', () => { retryCalls += 1; return Promise.resolve('dup'); }, clock.now() + 50));
  // Another key waits for the slot.
  let otherStarted = false;
  const other = track(cap.run('other', async () => { otherStarted = true; return 'o'; }, clock.now() + 50));
  await flush();
  assert.equal(retryCalls, 0);
  assert.equal(otherStarted, false);
  slow.resolve('built');
  await flush();
  assert.equal(retry.value, 'ok:built');
  assert.equal(other.value, 'ok:o');
  assert.equal(otherStarted, true);
  assert.equal(cap.inFlight(), 0);
});

test('waiting_past_deadline_never_starts_fn', async (t) => {
  t.after(() => mock.timers.reset());
  const clock = capClock();
  const cap = new BuildCap(1, clock.now);
  const busy = deferred();
  track(cap.run('busy', () => busy.promise, clock.now() + 1_000));
  let started = false;
  const waiting = track(cap.run('waiting', async () => { started = true; return 'w'; }, clock.now() + 50));
  await flush();
  clock.tick(50);
  await flush();
  assert.equal(waiting.value, 'err:BuildDeadlineError');
  busy.resolve('done');
  await flush();
  assert.equal(started, false);
  assert.equal(cap.inFlight(), 0);
  // The expired key is gone: a fresh call with that key runs.
  const fresh = track(cap.run('waiting', async () => 'fresh', clock.now() + 50));
  await flush();
  assert.equal(fresh.value, 'ok:fresh');
});

test('sync_throw_releases_slot', async (t) => {
  t.after(() => mock.timers.reset());
  const clock = capClock();
  const cap = new BuildCap(1, clock.now);
  const thrown = track(cap.run('throws', () => { throw new RangeError('sync'); }, clock.now() + 50));
  await flush();
  assert.equal(thrown.value, 'err:RangeError');
  assert.equal(cap.inFlight(), 0);
  const next = track(cap.run('next', async () => 'n', clock.now() + 50));
  await flush();
  assert.equal(next.value, 'ok:n');
});

test('timer_firing_before_the_clock_never_starts_fn', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  // The clock and the timers drift: the deadline timer fires while now() is still 1 ms short.
  const clock = { t: 5_000 };
  const cap = new BuildCap(1, () => clock.t);
  const busy = deferred();
  track(cap.run('busy', () => busy.promise, clock.t + 10_000));
  let started = false;
  const waiting = track(cap.run('waiting', async () => { started = true; return 'w'; }, clock.t + 50));
  await flush();
  clock.t += 49;
  mock.timers.tick(50);
  await flush();
  assert.equal(waiting.value, 'err:BuildDeadlineError');
  // A slot frees inside that 1 ms window.
  busy.resolve('done');
  await flush();
  assert.equal(started, false);
  assert.equal(cap.inFlight(), 0);
});

test('waiting_build_survives_while_any_caller_waits', async (t) => {
  t.after(() => mock.timers.reset());
  const clock = capClock();
  const cap = new BuildCap(1, clock.now);
  const busy = deferred();
  track(cap.run('busy', () => busy.promise, clock.now() + 10_000));
  let starts = 0;
  const fn = async () => { starts += 1; return 'built'; };
  const early = track(cap.run('shared', fn, clock.now() + 50));
  const late = track(cap.run('shared', fn, clock.now() + 500));
  await flush();
  clock.tick(50);
  await flush();
  assert.equal(early.value, 'err:BuildDeadlineError');
  assert.equal(late.value, 'pending');
  busy.resolve('done');
  await flush();
  assert.equal(starts, 1);
  assert.equal(late.value, 'ok:built');
});
