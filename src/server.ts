import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ResearchApi, safeError } from './api.js';
import { MAX_REVIEW_SEEDS, reviewOptionsSchema } from './review.js';
import { PaperContent } from './content.js';

export function createServer(api = new ResearchApi()) {
  const content = new PaperContent(api);
  const server = new McpServer({ name: 'inciteful-mcp', version: '0.1.0' });
  const id = z.string().trim().min(1).max(500).describe('DOI, OpenAlex W ID/URL, PMID, or an Inciteful-supported identifier.');
  const limit = z.number().int().min(1).max(50).default(10);
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const run = async (fn: () => Promise<unknown>) => {
    try {
      const data = await fn();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: safeError(error) }] };
    }
  };
  server.registerTool('search_papers', {
    description: 'Search OpenAlex for papers by topic or title. Returns metadata and next_cursor for pagination. Use selected IDs with get_paper or similar_papers.',
    inputSchema: { query: z.string().trim().min(1).max(1000), limit, cursor: z.string().max(4000).default('*'), filter: z.string().max(2000).optional().describe('Optional OpenAlex filter, e.g. publication_year:2020-2026,is_oa:true') }, annotations,
  }, ({ query, limit, cursor, filter }) => run(() => api.search(query, limit, cursor, filter)));
  server.registerTool('get_paper', {
    description: 'Retrieve a paper from OpenAlex (full metadata, DOI/OpenAlex ID/PMID) or Inciteful (compact graph metadata and citation counts).',
    inputSchema: { id, source: z.enum(['openalex', 'inciteful']).default('openalex') }, annotations,
  }, ({ id, source }) => run(async () => ({ source, paper: source === 'openalex' ? await api.work(id) : await api.paper(id) })));
  server.registerTool('similar_papers', {
    description: 'Find related literature using Inciteful citation graph similarity, optionally enriched with OpenAlex metadata via exact DOI matches. OpenAlex IDs are resolved to DOI/PMID first. Graph coverage may be narrower than OpenAlex.',
    inputSchema: { id, limit, enrich: z.boolean().default(true) }, annotations,
  }, ({ id, limit, enrich }) => run(() => api.similar(id, limit, enrich)));
  server.registerTool('connect_papers', {
    description: 'Find citation paths between two papers using Inciteful. Returns paths, edge directions, and the papers on the returned paths.',
    inputSchema: { from: id, to: id, max_paths: z.number().int().min(1).max(50).default(10) }, annotations,
  }, ({ from, to, max_paths }) => run(() => api.connector(from, to, max_paths)));
  server.registerTool('discover_papers', {
    description: 'Rank papers in an Inciteful graph around one seed paper by similarity, PageRank influence, or publication year. Excludes the seed. Similarity is a graph metric, not a quality assessment.',
    inputSchema: { id, ranking: z.enum(['similarity', 'influence', 'recent']).default('similarity'), limit }, annotations,
  }, ({ id, ranking, limit }) => run(() => api.discover(id, ranking, limit)));
  server.registerTool('literature_review', {
    description: `Build and query a literature-review graph from 1–${MAX_REVIEW_SEEDS} seed papers. Returns selected paper, author, institution, and journal rankings based on Inciteful dashboard queries. To add papers, call again with the returned seed_ids plus selected result paper_id values. Batches OpenAlex/Inciteful identifier resolution and deduplicates canonical seeds. Multi-seed similarity and review candidates use distance 2; seeds are excluded from rankings. Review-paper and upcoming-author labels are graph heuristics. No persistent review state is stored.`,
    inputSchema: z.object({
      ids: z.array(id).min(1).max(MAX_REVIEW_SEEDS),
      ...reviewOptionsSchema.shape,
    }).refine(o => o.year_from === undefined || o.year_to === undefined || o.year_from <= o.year_to,
      { message: 'year_from must be less than or equal to year_to' }),
    annotations,
  }, ({ ids, ...options }) => run(() => api.literatureReview(ids, options)));
  const contentId = z.string().trim().min(1).max(500).describe('DOI, OpenAlex work ID, PMID, or Inciteful ID. Abstract/full-text tools also accept PMC12345 or a PMC article URL.');
  server.registerTool('get_abstract', {
    description: 'Retrieve a readable abstract from OpenAlex, falling back to PubMed/PMC BioC. Returns source attribution and candidate full-text links.',
    inputSchema: { id: contentId }, annotations,
  }, ({ id }) => run(() => content.abstract(id)));
  server.registerTool('get_full_text_links', {
    description: 'Return potential full-text PDF and article URLs from OpenAlex, ordered with its best open-access copy first. Includes license/version/access metadata and archive URLs. Use your web tools to fetch publisher or repository links; availability is not guaranteed.',
    inputSchema: { id }, annotations,
  }, ({ id }) => run(() => content.links(id)));
  server.registerTool('get_full_text', {
    description: 'Fetch readable article text from PMC BioC, or OpenAlex structured XML when an API key is configured (archive download charges may apply). Returns chunks with next_offset and content hash. If retrieval fails, returns candidate URLs for the agent to fetch with web/PDF tools. Does not scrape arbitrary publisher sites.',
    inputSchema: { id: contentId, source: z.enum(['auto', 'pmc', 'openalex']).default('auto'),
      offset: z.number().int().min(0).default(0), max_chars: z.number().int().min(1).max(50000).default(15000) }, annotations,
  }, ({ id, source, offset, max_chars }) => run(() => content.fullText(id, source, offset, max_chars)));
  return server;
}
