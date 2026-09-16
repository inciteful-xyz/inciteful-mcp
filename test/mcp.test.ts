import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('stdio server initializes, lists tools, and rejects invalid inputs', async () => {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['connect_papers', 'discover_papers', 'get_abstract', 'get_full_text', 'get_full_text_links', 'get_paper', 'literature_review', 'search_papers', 'similar_papers']);
    const result = await client.callTool({ name: 'similar_papers', arguments: { id: 'W1', limit: 1000 } });
    assert.equal(result.isError, true);
    const badId = await client.callTool({ name: 'get_paper', arguments: { id: 'invalid' } });
    assert.equal(badId.isError, true);
    const badOffset = await client.callTool({ name: 'get_full_text', arguments: { id: 'PMC1', offset: -1 } });
    assert.equal(badOffset.isError, true);
    for (const args of [{ ids: [] }, { ids: ['pmid:1'], year_from: 2025, year_to: 2020 }, { ids: ['pmid:1'], sections: ['bad'] }]) {
      const invalid = await client.callTool({ name: 'literature_review', arguments: args });
      assert.equal(invalid.isError, true);
    }
  } finally { await client.close(); }
});
