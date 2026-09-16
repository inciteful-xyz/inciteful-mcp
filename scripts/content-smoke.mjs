import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'content-smoke', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  for (const [name, args] of [
    ['get_abstract', { id: '10.1371/journal.pone.0000217' }],
    ['get_full_text_links', { id: '10.1371/journal.pone.0000217' }],
    ['get_full_text', { id: 'PMC1790863', source: 'pmc', max_chars: 1000 }],
    ['get_full_text', { id: 'PMC1790863', source: 'pmc', offset: 1000, max_chars: 1000 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result.content));
    const data = JSON.parse(result.content[0].text);
    if (name === 'get_full_text_links') assert.ok(data.links.some(link => link.is_oa && !link.requires_api_key));
    else { assert.equal(data.status, 'available'); assert.ok(data.text.length > 100); }
    console.log(`${name}: passed${data.source ? ` (${data.source})` : ''}`);
  }
} finally { await client.close(); }
