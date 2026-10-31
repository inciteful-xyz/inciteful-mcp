import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseExample } from '../src/pages/landing.js';
import { pages } from '../src/pages/index.js';
import type { PageCtx } from '../src/types.js';

const BASE = new URL('https://incitefulmed.com/academic/mcp');
const ctx = (snapshot: string | null, recentTier: string | null): PageCtx => ({ publicBaseUrl: BASE, snapshot, recentTier });
const CTX = ctx('2026-10-15', null);

const ALL = () => ({
  landing: pages.landing(CTX),
  privacy: pages.privacy(CTX),
  terms: pages.terms(CTX),
  notFound: pages.notFound(CTX),
});

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The text a reader sees: no scripts, styles, tags or attributes; entities decoded; spaces collapsed. */
function visibleText(html: string): string {
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decode(stripped).replace(/\s+/g, ' ').trim();
}

function scripts(html: string): Array<{ attrs: string; body: string }> {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map(m => ({ attrs: m[1], body: m[2] }));
}

function jsonLd(html: string): Array<Record<string, unknown>> {
  const blocks = scripts(html).filter(s => /type="application\/ld\+json"/.test(s.attrs));
  assert.equal(blocks.length, 1);
  const doc = JSON.parse(blocks[0].body) as { '@context': string; '@graph': Array<Record<string, unknown>> };
  assert.equal(doc['@context'], 'https://schema.org');
  return doc['@graph'];
}

test('landing_meta_and_canonical', () => {
  const html = pages.landing(CTX);
  assert.match(html, /<title>Inciteful MCP Server: Citation Graph for AI Assistants<\/title>/);
  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(m => visibleText(m[1]));
  assert.deepEqual(h1s, ['Inciteful MCP: the citation graph inside your AI assistant']);
  assert.match(html, /<link rel="canonical" href="https:\/\/incitefulmed\.com\/academic\/mcp">/);
  const desc = decode(/<meta name="description" content="([^"]*)">/.exec(html)![1]);
  assert.ok(desc.length >= 140 && desc.length <= 160, `description is ${desc.length} characters`);
  for (const word of ['Claude', 'ChatGPT', 'Cursor', 'free', 'no login']) assert.ok(desc.toLowerCase().includes(word.toLowerCase()), word);
  // Canonical follows the configured base, e.g. on another host.
  const other = pages.landing({ publicBaseUrl: new URL('https://example.org/academic/mcp'), snapshot: null, recentTier: null });
  assert.match(other, /<link rel="canonical" href="https:\/\/example\.org\/academic\/mcp">/);
  assert.match(pages.privacy(CTX), /<link rel="canonical" href="https:\/\/incitefulmed\.com\/academic\/mcp\/privacy">/);
  assert.match(pages.terms(CTX), /<link rel="canonical" href="https:\/\/incitefulmed\.com\/academic\/mcp\/terms">/);
});

test('badges_exact', () => {
  const html = pages.landing(CTX);
  const list = /<ul class="badges"[^>]*>([\s\S]*?)<\/ul>/.exec(html);
  assert.ok(list, 'badge list');
  const badges = [...list[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => visibleText(m[1]));
  assert.equal(badges.join(' · '), 'Free · No account · OpenAlex metadata (CC0) · Open-source server (MIT)');
});

/** Copy a reader or a search engine sees: visible text, meta and alt text, and JSON-LD strings. */
function allCopy(html: string): string {
  const attrs = [...html.matchAll(/\b(?:content|alt)="([^"]*)"/g)].map(m => decode(m[1]));
  const ld: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') ld.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const s of scripts(html).filter(s => /type="application\/ld\+json"/.test(s.attrs))) walk(JSON.parse(s.body));
  return [visibleText(html), ...attrs, ...ld].join(' \n ');
}

test('copy_rules_all_pages', () => {
  // Fixed spec phrases that legitimately contain "only", removed as whole phrases before the check.
  const ALLOWED = ['looked up live only when named', 'titles only'];
  const BANNED = /n[o'’]?t log|n.t logged|never log|no logging|without logging|unlogged|no logs?\b|nothing (?:is |gets |will be )?logged|first|only/i;
  const COMPLIANCE = /hipaa|gdpr|complian|certified/i;
  for (const [name, html] of Object.entries(ALL())) {
    assert.doesNotMatch(html, /href="[^"]*\/resources/i, `${name} links to /resources`);
    let text = allCopy(html);
    for (const phrase of ALLOWED) text = text.split(phrase).join(' ');
    for (const re of [BANNED, COMPLIANCE]) {
      const hit = re.exec(text);
      assert.equal(hit, null, `${name}: "${hit ? text.slice(Math.max(0, hit.index - 40), hit.index + 40) : ''}"`);
    }
  }
  // The allowlist is used: the landing page carries both phrases.
  const landing = visibleText(pages.landing(CTX));
  for (const phrase of ALLOWED) assert.ok(landing.includes(phrase), phrase);
});

test('jsonld_valid_and_fields', () => {
  const graph = jsonLd(pages.landing(CTX));
  assert.deepEqual(graph.map(n => n['@type']), ['SoftwareApplication', 'BreadcrumbList']);
  const app = graph[0];
  assert.equal(app.url, 'https://incitefulmed.com/academic/mcp');
  assert.equal(app.installUrl, 'https://incitefulmed.com/academic/mcp');
  assert.equal(app.applicationCategory, 'ReferenceApplication');
  assert.equal(app.operatingSystem, 'Any');
  assert.equal((app.offers as Record<string, unknown>).price, '0');
  assert.equal(app.isAccessibleForFree, true);
  assert.deepEqual(app.publisher, { '@id': 'https://incitefulmed.com/#organization' });
  assert.deepEqual(app.isPartOf, { '@id': 'https://incitefulmed.com/#website' });
  assert.deepEqual(app.sameAs, ['https://github.com/inciteful-xyz/inciteful-mcp']);
  assert.equal('aggregateRating' in app, false);
  const crumbs = graph[1].itemListElement as Array<Record<string, unknown>>;
  assert.deepEqual(crumbs.map(c => c.position), [1, 2, 3]);
  assert.equal(crumbs[2].item, 'https://incitefulmed.com/academic/mcp');
  const html = pages.landing(CTX);
  for (const banned of ['aggregateRating', 'FAQPage', 'MedicalWebPage']) assert.equal(html.includes(banned), false, banned);
});

test('client_panels_static', () => {
  const html = pages.landing(CTX);
  const panels = [...html.matchAll(/<section class="panel"[^>]*>([\s\S]*?)<\/section>/g)].map(m => visibleText(m[1]));
  assert.equal(panels.length, 6);
  const expected: Array<[string, string]> = [
    ['Claude', 'Add custom connector'],
    ['ChatGPT', 'Add custom MCP server'],
    ['Cursor', '~/.cursor/mcp.json'],
    ['Claude Code', 'claude mcp add --transport http inciteful https://incitefulmed.com/academic/mcp'],
    ['VS Code', 'MCP: Add Server'],
    ['Other clients', 'Streamable HTTP'],
  ];
  expected.forEach(([client, step], i) => {
    assert.ok(panels[i].startsWith(client), `panel ${i} is ${client}`);
    assert.ok(panels[i].includes(step), `${client} has "${step}"`);
    assert.match(panels[i], /Steps checked on 2026-10-30/);
  });
  // Every panel's text is in the HTML; the toggle is CSS only.
  assert.equal(scripts(html).some(s => /panel/.test(s.body)), false);
});

test('coverage_text_both_states_and_distinct_dates', () => {
  const live = visibleText(pages.landing(ctx('2026-10-15', '2026-11-02')));
  assert.ok(live.includes('Snapshot 2026-10-15, updated nightly through 2026-11-02 with new papers that have a Crossref DOI. Other new papers are looked up live only when named.'));
  assert.ok(live.includes('Graph snapshot: 2026-10-15'));
  const notLive = visibleText(pages.landing(ctx('2026-10-15', null)));
  assert.ok(notLive.includes("The graph is built from the snapshot. Papers newer than the snapshot are looked up live only when named explicitly; they don't appear as neighbours."));
  assert.equal(notLive.includes('updated nightly'), false);
  assert.equal(notLive.includes('2026-11-02'), false);
});

test('snapshot_unavailable_and_escaped', () => {
  const missing = visibleText(pages.landing(ctx(null, null)));
  assert.ok(missing.includes('Graph snapshot date unavailable'));
  assert.equal(missing.includes('Graph snapshot: snapshot date unavailable'), false);
  const hostile = pages.landing(ctx('<b>2026</b>', '"><script>x</script>'));
  assert.equal(hostile.includes('<b>2026</b>'), false);
  assert.ok(hostile.includes('&lt;b&gt;2026&lt;/b&gt;'));
  assert.equal(hostile.includes('<script>x</script>'), false);
  const hostileBase = pages.landing({ publicBaseUrl: new URL('https://example.org/a"b<c>/mcp'), snapshot: null, recentTier: null });
  assert.equal(/href="[^"]*"b/.test(hostileBase), false);
  assert.equal(hostileBase.includes('<c>'), false);
});

test('scripts_limited', () => {
  for (const [name, html] of Object.entries(ALL())) {
    const all = scripts(html);
    assert.equal(all.some(s => /\bsrc=/.test(s.attrs)), false, `${name} loads an external script`);
    const inline = all.filter(s => !/type="application\/ld\+json"/.test(s.attrs));
    assert.ok(inline.length <= 1, `${name} has ${inline.length} inline scripts`);
    if (inline.length === 1) assert.match(inline[0].body, /clipboard/);
    // No external styles or fonts either.
    assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/, name);
    assert.doesNotMatch(html, /url\((?!\/)/, name);
  }
  const landing = scripts(pages.landing(CTX));
  assert.equal(landing.filter(s => /type="application\/ld\+json"/.test(s.attrs)).length, 1);
  assert.equal(landing.length, 2);
});

test('example_marked_placeholder', () => {
  const html = pages.landing(CTX);
  const example = /<div class="chat"([^>]*)>([\s\S]*?)<\/div>\s*<!-- \/chat -->/.exec(html);
  assert.ok(example, 'example conversation');
  assert.match(example[1], /\bdata-placeholder\b/);
  assert.ok(visibleText(example[2]).includes('explore_citation_network'));
  // The committed file passes the shape check the server runs at startup; a bad shape throws.
  const committed = JSON.parse(readFileSync(new URL('../assets/example.json', import.meta.url), 'utf8'));
  assert.equal(parseExample(committed).placeholder, true);
  assert.throws(() => parseExample({ ...committed, turns: [{ role: 'narrator', text: 'x' }] }), /assets\/example\.json: invalid shape/);
});

test('privacy_lists_recipients_and_placeholder_contact', () => {
  const html = pages.privacy(CTX);
  const text = visibleText(html);
  for (const recipient of ['Cloudflare', 'OpenAlex', 'NCBI', 'your assistant’s vendor']) assert.ok(text.toLowerCase().includes(recipient.toLowerCase()), recipient);
  for (const fact of ['90 days', '15 days', 'changes every day', 'Effective date', 'Version']) assert.ok(text.includes(fact), fact);
  assert.ok(text.includes('{{SUPPORT_EMAIL}}'));
  const h2 = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map(m => visibleText(m[1]));
  assert.deepEqual(h2, [
    'Summary', 'What we collect', 'What we never collect', 'Who receives data', 'Cookies and analytics',
    'Retention and deletion', 'Your choices', 'How this relates to the site-wide policy', 'Effective date and version', 'Contact',
  ]);
});
