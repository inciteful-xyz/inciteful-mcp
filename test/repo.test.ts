import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };

test('readme_opens_with_url_and_follows_copy_rules', () => {
  const readme = read('README.md');
  assert.equal(readme.split('\n')[2], '**https://incitefulmed.com/academic/mcp**');
  assert.ok(readme.includes('Free · No account · OpenAlex metadata (CC0) · Open-source server (MIT)'));
  assert.doesNotMatch(readme, /\/resources/i);
  // The same rules as the pages (test/pages.test.ts), with its one fixed "only" phrase removed first.
  const text = readme.split('titles only').join(' ');
  const BANNED = /n[o'’]?t log|n.t logged|never log|no logging|without logging|unlogged|no logs?\b|nothing (?:is |gets |will be )?logged|first|only|hipaa|gdpr|complian|certified/i;
  const hit = BANNED.exec(text);
  assert.equal(hit, null, hit ? text.slice(Math.max(0, hit.index - 40), hit.index + 40) : '');
  for (const tool of ['search_literature', 'get_papers', 'find_similar_papers', 'explore_citation_network', 'connect_papers', 'query_citation_graph', 'read_paper', 'export_citations']) {
    assert.ok(readme.includes(`| \`${tool}\` |`), tool);
  }
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
