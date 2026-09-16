// Opt-in live integration check: makes a small number of upstream API requests.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'live-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: ['dist/index.js'],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
});
try {
  await client.connect(transport);
  for (const [name, args] of [
    ['search_papers', { query: 'deep learning', limit: 1 }],
    ['get_paper', { id: '10.1038/nature14539' }],
    ['similar_papers', { id: 'W2919115771', limit: 2 }],
    ['discover_papers', { id: 'pmid:26017442', ranking: 'influence', limit: 2 }],
    ['connect_papers', { from: 'pmid:26017442', to: 'pmid:25462637', max_paths: 1 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    const data = JSON.parse(result.content[0].text);
    if (name === 'similar_papers') {
      assert.equal(data.papers.length, 2);
      assert.equal(data.warnings.length, 0);
      assert.ok(data.papers.some(p => p.openalex), 'Expected at least one DOI enrichment match');
    }
    if (name === 'discover_papers') assert.equal(data.results.length, 2);
    if (name === 'connect_papers') assert.equal(data.paths.length, 1);
    console.log(`${name}: passed`);
  }
} finally { await client.close(); }
