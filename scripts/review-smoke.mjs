// Opt-in live check of all dashboard queries for a multi-seed graph and a single-seed graph.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { reviewSections } from '../dist/review.js';
import { readFileSync } from 'node:fs';

// Optional JSON file of known seed IDs checks one larger graph using two sections.
const seedSets = process.argv[2] ? [JSON.parse(readFileSync(process.argv[2], 'utf8'))]
  : [['pmid:26017442', 'pmid:25462637'], ['pmid:26017442']];
const sections = process.argv[2] ? ['similar_papers', 'important_papers'] : reviewSections;

const client = new Client({ name: 'review-smoke', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) }));
  for (const ids of seedSets) {
    const result = await client.callTool({ name: 'literature_review', arguments: { ids, sections, limit: 2 } }, undefined, { timeout: 180000 });
    assert.ok(!result.isError, JSON.stringify(result.content));
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.partial, false, JSON.stringify(data.sections));
    assert.equal(data.seed_ids.length, ids.length);
    for (const [name, section] of Object.entries(data.sections)) {
      assert.ok(section.results.length <= (name === 'similar_paper_graph' ? 2 + ids.length : 2));
      if (name === 'similar_papers' || name === 'review_papers') {
        assert.ok(section.results.every(r => ids.length > 1 ? r.distance === 2 : r.distance > 0));
      }
      console.log(`${data.graph_mode}/${name}: passed (${data.seed_ids.length} seeds, ${section.results.length} rows)`);
    }
  }
} finally { await client.close(); }
