import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { copyRuleHit } from './copyrules.js';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };
const README = read('README.md');

test('readme_opens_with_url_and_follows_copy_rules', () => {
  assert.equal(README.split('\n')[2], '**https://incitefulmed.com/academic/mcp**');
  assert.ok(README.includes('Free · No account · OpenAlex metadata (CC0) · Open-source server (MIT)'));
  assert.doesNotMatch(README, /\/resources/i);
  // Privacy lives on one page; the README links to it rather than restating it.
  assert.ok(README.includes('https://incitefulmed.com/academic/mcp/privacy'));
  const hit = copyRuleHit(README);
  assert.equal(hit, null, `README: "${hit}"`);
  for (const tool of ['search_literature', 'get_papers', 'find_similar_papers', 'explore_citation_network', 'connect_papers', 'query_citation_graph', 'read_paper', 'export_citations']) {
    assert.ok(README.includes(`| \`${tool}\` |`), tool);
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
