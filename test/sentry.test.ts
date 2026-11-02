import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ErrorEvent } from '@sentry/node';
import { initErrorReporting, redactUrlQueries, scrubEvent } from '../src/sentry.js';

test('redacts_url_query_strings_and_fragments', () => {
  assert.equal(
    redactUrlQueries('fetch failed: http://graph-api-academic/openalex/paper?ids[]=W1&q=cancer then https://api.openalex.org/works#x'),
    'fetch failed: http://graph-api-academic/openalex/paper?[redacted] then https://api.openalex.org/works?[redacted]',
  );
  assert.equal(redactUrlQueries('no urls, just text?'), 'no urls, just text?');
  assert.equal(redactUrlQueries('https://example.org/path'), 'https://example.org/path');
});

test('scrub_drops_request_context_and_redacts_messages', () => {
  const event = {
    message: 'see https://x.org/a?secret=1',
    request: { url: 'https://incitefulmed.com/academic/mcp?q=1', headers: { 'cf-connecting-ip': '203.0.113.9' }, data: '{"query":"x"}' },
    user: { ip_address: '203.0.113.9' },
    breadcrumbs: [{ message: 'GET https://api.openalex.org/works?search=x' }],
    extra: { args: { query: 'x' } },
    exception: { values: [{ type: 'TypeError', value: 'bad http://g/openalex?ids[]=W1' }, { type: 'Error' }] },
    tags: { where: 'get_papers' },
  } as unknown as ErrorEvent;
  const out = scrubEvent(event);
  assert.equal(out.request, undefined);
  assert.equal(out.user, undefined);
  assert.equal(out.breadcrumbs, undefined);
  assert.equal(out.extra, undefined);
  assert.equal(out.message, 'see https://x.org/a?[redacted]');
  assert.deepEqual(out.exception?.values?.map(v => v.value), ['bad http://g/openalex?[redacted]', undefined]);
  assert.deepEqual(out.tags, { where: 'get_papers' });
});

test('report_sends_a_scrubbed_event_with_release_and_where', async () => {
  const sent: unknown[] = [];
  const transport = () => ({
    send: async (envelope: unknown) => { sent.push(envelope); return {}; },
    flush: async () => true,
  });
  const errors = initErrorReporting('https://publickey@o1.ingest.sentry.invalid/42', 'abc1234', { transport });
  // Built at runtime: context lines carry this file's source, so a literal id would appear there.
  const id = ['W', '9', '1', '7'].join('');
  errors.report(new TypeError(`fetch failed: http://graph-api-academic/openalex?ids[]=${id}`), 'find_similar_papers');
  await errors.close();
  const events = sent.flatMap(e => (e as [unknown, Array<[{ type: string }, unknown]>])[1])
    .filter(([h]) => h.type === 'event').map(([, payload]) => payload as ErrorEvent);
  assert.equal(events.length, 1);
  const [ev] = events;
  assert.equal(ev.release, 'abc1234');
  assert.deepEqual(ev.tags, { where: 'find_similar_papers' });
  assert.equal(ev.exception?.values?.[0]?.type, 'TypeError');
  assert.equal(ev.exception?.values?.[0]?.value, 'fetch failed: http://graph-api-academic/openalex?[redacted]');
  assert.equal(ev.request, undefined);
  assert.equal(ev.user, undefined);
  assert.equal(ev.breadcrumbs, undefined);
  // Nothing anywhere in the payload carries the paper id from the query string.
  assert.doesNotMatch(JSON.stringify(ev), /W917/);
});
