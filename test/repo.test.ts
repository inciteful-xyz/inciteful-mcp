import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { pages } from '../src/pages/index.js';
import { copyRuleHit, visibleText } from './copyrules.js';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };
const README = read('README.md');

/** Curly quotes to straight, whitespace collapsed: the README and the pages differ only in these. */
const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
/** The README as plain text: code fences dropped, emphasis and backticks stripped. */
const README_TEXT = norm(README.replace(/^\s*```\w*\s*$/gm, ' ').replace(/\*\*|\*|`/g, ''));
/** Visible text of a fragment. Inline tags go first, so "<b>Add</b>." and URLs with <wbr> gain no spaces. */
const text = (html: string) => norm(visibleText(html.replace(/<\/?(?:b|i|code|wbr)>/g, '')));

test('readme_opens_with_url_and_follows_copy_rules', () => {
  assert.equal(README.split('\n')[2], '**https://incitefulmed.com/academic/mcp**');
  assert.ok(README.includes('Free · No account · OpenAlex metadata (CC0) · Open-source server (MIT)'));
  assert.doesNotMatch(README, /\/resources/i);
  const hit = copyRuleHit(README);
  assert.equal(hit, null, `README: "${hit}"`);
  for (const tool of ['search_literature', 'get_papers', 'find_similar_papers', 'explore_citation_network', 'connect_papers', 'query_citation_graph', 'read_paper', 'export_citations']) {
    assert.ok(README.includes(`| \`${tool}\` |`), tool);
  }
});

test('readme_matches_landing_steps_and_privacy', () => {
  const html = pages.landing({ publicBaseUrl: new URL('https://incitefulmed.com/academic/mcp'), snapshot: '2026-10-15', recentTier: null });
  const panels = [...html.matchAll(/<section class="panel"[^>]*>([\s\S]*?)<\/section>/g)].map(m => m[1]);
  assert.equal(panels.length, 6);
  for (const panel of panels) {
    // Every step and caveat in the panel appears in the README, word for word.
    const items = [...panel.matchAll(/<li>([\s\S]*?)<\/li>|<p class="muted">([\s\S]*?)<\/p>/g)].map(m => text(m[1] ?? m[2]));
    assert.ok(items.length >= 3);
    for (const item of items) assert.ok(README_TEXT.includes(item), `README lacks: ${item}`);
    // The same check date and source.
    const checked = /Steps checked on (\S+) against <a href="([^"]+)">/.exec(panel);
    assert.ok(checked, 'panel has a checked line');
    assert.ok(README.includes(`Steps checked on ${checked[1]} against ${checked[2]}`), `README lacks the checked line for ${checked[2]}`);
  }
  const privacy = /<h2>Privacy<\/h2>\s*<ul[^>]*>([\s\S]*?)<\/ul>/.exec(html);
  assert.ok(privacy, 'landing privacy list');
  const bullets = [...privacy[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => text(m[1]));
  assert.equal(bullets.length, 5);
  for (const bullet of bullets) assert.ok(README_TEXT.includes(bullet), `README lacks: ${bullet}`);
  // The hosting line the full policy carries, which the landing summary leaves out.
  assert.ok(README_TEXT.includes('Our servers run at Hetzner and Google Cloud.'));
});

test('server_json_matches_package', () => {
  const server = JSON.parse(read('server.json')) as Record<string, unknown>;
  assert.equal(server.name, 'com.incitefulmed/academic');
  assert.equal(server.version, pkg.version);
  assert.equal(server.websiteUrl, 'https://incitefulmed.com/academic/mcp');
  assert.deepEqual(server.remotes, [{ type: 'streamable-http', url: 'https://incitefulmed.com/academic/mcp' }]);
});

test('citation_cff_version_matches_package', () => {
  assert.match(read('CITATION.cff'), new RegExp(`^version: ${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
});
