import { z } from 'zod';
import { MAX_REVIEW_SEEDS, reviewOptionsSchema, reviewQuery, type ReviewOptions, type ReviewSection } from './review.js';

const record = z.record(z.string(), z.unknown());
export const workSchema = z.object({
  id: z.string(), doi: z.string().nullable().optional(),
  title: z.string().nullable().optional(), publication_year: z.number().nullable().optional(),
  ids: z.object({ pmid: z.string().nullable().optional() }).passthrough().optional(),
}).passthrough();
export const paperSchema = z.object({
  id: z.union([z.string(), z.number()]), title: z.string(), doi: z.string().nullable().optional(),
}).passthrough();
export type Work = z.infer<typeof workSchema>;
export type Paper = z.infer<typeof paperSchema>;
export type Fetch = typeof fetch;

export class ApiError extends Error {}

function batches(ids: string[]): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let size = 0;
  for (const id of ids) {
    const bytes = encodeURIComponent(id).length + 16;
    if (group.length && (group.length >= 50 || size + bytes > 6000)) {
      groups.push(group); group = []; size = 0;
    }
    group.push(id); size += bytes;
  }
  if (group.length) groups.push(group);
  return groups;
}

const idKey = (id: string) => normalizeId(id).toLowerCase();

export function normalizeId(input: string): string {
  const value = input.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '').replace(/^https?:\/\/openalex\.org\//i, '');
  if (/^w\d+$/i.test(value)) return value.toUpperCase();
  const pmid = value.match(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?$/i);
  return pmid ? `pmid:${pmid[1]}` : value;
}

export function compactPaper(paper: Paper) {
  const { citing, cited_by, ...rest } = paper;
  return rest;
}

export function compactWork(work: Work) {
  return {
    id: work.id, doi: work.doi, title: work.title, publication_year: work.publication_year,
    ids: work.ids, cited_by_count: work.cited_by_count, type: work.type,
    authorships: work.authorships, primary_location: work.primary_location,
    open_access: work.open_access, primary_topic: work.primary_topic,
    best_oa_location: work.best_oa_location, has_content: work.has_content,
  };
}

export class ResearchApi {
  readonly graphBase: string;
  // The caller supplies the graph URL and timeout; there are no defaults.
  constructor(graphBase: URL, readonly timeout: number, private readonly env: NodeJS.ProcessEnv, private readonly fetcher: Fetch = fetch) {
    this.graphBase = graphBase.href;
  }

  async request(service: 'OpenAlex' | 'Inciteful', path: string, params: URLSearchParams = new URLSearchParams(), body?: string, asText = false): Promise<unknown> {
    const url = new URL(`${service === 'OpenAlex' ? 'https://api.openalex.org' : this.graphBase.replace(/\/$/, '')}/${path}`);
    url.search = params.toString();
    if (service === 'OpenAlex') {
      if (this.env.OPENALEX_API_KEY) url.searchParams.set('api_key', this.env.OPENALEX_API_KEY);
      if (this.env.OPENALEX_EMAIL) url.searchParams.set('mailto', this.env.OPENALEX_EMAIL);
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { Accept: asText ? 'text/plain' : 'application/json' } : {
          Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
        },
        body, signal: AbortSignal.timeout(this.timeout), redirect: 'error',
      });
    } catch {
      throw new ApiError(`${service} request failed or timed out.`);
    }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const hint = response.status === 429 ? ' Rate limit reached; retry later.' :
        response.status === 401 || response.status === 403 ? ' Check API access and credentials.' :
        response.status === 404 ? ' Paper or endpoint not found; graph coverage may differ from OpenAlex.' : '';
      throw new ApiError(`${service} returned HTTP ${response.status}.${hint}${retry && /^\d+$/.test(retry) ? ` Retry after ${retry} seconds.` : ''}`);
    }
    try { return asText ? await response.text() : await response.json(); }
    catch { throw new ApiError(`${service} returned an unreadable response.`); }
  }

  async search(query: string, limit: number, cursor: string, filter?: string) {
    const params = new URLSearchParams({ search: query, per_page: String(limit), cursor });
    if (filter) params.set('filter', filter);
    const data = z.object({ meta: record, results: z.array(workSchema) }).parse(await this.request('OpenAlex', 'works', params));
    return { source: 'OpenAlex', meta: data.meta, results: data.results.map(compactWork) };
  }

  async work(id: string): Promise<Work> {
    const normalized = normalizeId(id);
    if (!/^(W\d+|10\.\d{4,9}\/.+|pmid:\d+)$/i.test(normalized)) {
      throw new ApiError('OpenAlex lookup requires an OpenAlex work ID, DOI, or PMID.');
    }
    const lookup = normalized.startsWith('10.') ? `https://doi.org/${normalized}` : normalized;
    return workSchema.parse(await this.request('OpenAlex', `works/${encodeURIComponent(lookup)}`));
  }

  async graphId(id: string): Promise<string> {
    const normalized = normalizeId(id);
    if (!/^W\d+$/.test(normalized)) return normalized;
    const work = await this.work(normalized);
    if (work.doi) return normalizeId(work.doi);
    if (work.ids?.pmid) return normalizeId(work.ids.pmid);
    throw new ApiError('This OpenAlex work has no DOI or PMID for Inciteful lookup. Supply an Inciteful-supported identifier.');
  }

  /** Identifier accepted by the current IncitefulMed OpenAlex graph namespace. */
  async graphWorkId(id: string): Promise<string> {
    const normalized = normalizeId(id);
    if (/^W\d+$/.test(normalized)) return normalized;
    // The OpenAlex graph service accepts DOI and PMID aliases directly.
    if (/^(10\.\d{4,9}\/.+|pmid:\d+)$/i.test(normalized)) return normalized;
    throw new ApiError('Inciteful graph lookup requires an OpenAlex work ID, DOI, or PMID.');
  }

  async paper(id: string) {
    const resolved = await this.graphWorkId(id);
    return compactPaper(paperSchema.parse(await this.request('Inciteful', `openalex/paper/${encodeURIComponent(resolved)}`, new URLSearchParams({ condensed: 'true' }))));
  }

  async enrich(papers: Paper[]) {
    // Join only exact DOIs, never inferred equivalence of numeric IDs or titles.
    const dois = [...new Set(papers.flatMap(p => p.doi ? [normalizeId(p.doi).toLowerCase()] : []))];
    if (!dois.length) return { papers: papers.map(p => ({ inciteful: compactPaper(p), openalex: null })), warnings: ['No DOIs available for OpenAlex enrichment.'] };
    try {
      const data = z.object({ results: z.array(workSchema) }).parse(await this.request('OpenAlex', 'works',
        new URLSearchParams({ filter: `doi:${dois.join('|')}`, per_page: '100' })));
      const byDoi = new Map(data.results.filter(w => w.doi).map(w => [normalizeId(w.doi!).toLowerCase(), compactWork(w)]));
      return { papers: papers.map(p => ({ inciteful: compactPaper(p), openalex: p.doi ? byDoi.get(normalizeId(p.doi).toLowerCase()) ?? null : null })), warnings: [] };
    } catch (error) {
      return { papers: papers.map(p => ({ inciteful: compactPaper(p), openalex: null })), warnings: [`OpenAlex enrichment failed: ${safeError(error)}`] };
    }
  }

  async similar(id: string, limit: number, enrich: boolean) {
    const resolved = await this.graphWorkId(id);
    const papers = z.array(paperSchema).parse(await this.request('Inciteful', `openalex/paper/similar/${encodeURIComponent(resolved)}`, new URLSearchParams({ n: String(limit) }))).slice(0, limit);
    return { seed: resolved, source: 'Inciteful', ...(enrich ? await this.enrich(papers) : { papers: papers.map(compactPaper) }) };
  }

  async connector(from: string, to: string, maxPaths: number) {
    const fromId = await this.graphWorkId(from);
    const toId = await this.graphWorkId(to);
    const data = z.object({ paths: z.array(z.array(z.union([z.string(), z.number()]))), papers: z.array(paperSchema),
      connections: z.array(record), num_paths: z.number(), max_hops: z.number(), papers_searched: z.number(),
    }).parse(await this.request('Inciteful', 'openalex/connector', new URLSearchParams({ from: fromId, to: toId, extend: '0' })));
    const paths = data.paths.slice(0, maxPaths);
    const included = new Set(paths.flat().map(String));
    return { ...data, from: fromId, to: toId, paths, truncated: data.paths.length > paths.length,
      papers: data.papers.filter(p => included.has(String(p.id))).map(compactPaper),
      connections: data.connections.filter(c => included.has(String(c.citing)) && included.has(String(c.cited))),
    };
  }

  async discover(id: string, ranking: 'similarity' | 'influence' | 'recent', limit: number) {
    const resolved = await this.graphWorkId(id);
    const ordering = { similarity: 'COALESCE(adamic_adar, 0) + COALESCE(cocite, 0) DESC, page_rank DESC', influence: 'page_rank DESC', recent: 'published_year DESC, page_rank DESC' }[ranking];
    const sql = `SELECT paper_id, doi, title, published_year, journal, distance, page_rank, adamic_adar, cocite FROM papers WHERE distance > 0 ORDER BY ${ordering} LIMIT ${limit}`;
    const rows = z.array(record).parse(await this.request('Inciteful', `openalex/query/${encodeURIComponent(resolved)}`, new URLSearchParams({ prune: '10000' }), sql));
    return { source: 'Inciteful', seed: resolved, ranking, results: rows.slice(0, limit) };
  }

  async reviewSeeds(ids: string[]) {
    const unique = [...new Map(ids.map(id => [idKey(id), normalizeId(id)])).values()];
    const resolved = await this.resolveReviewAliases(unique);
    const canonical = [...new Map(resolved.map(id => [idKey(id), id])).values()];
    const seeds = new Map<string, ReturnType<typeof compactPaper>>();
    for (const group of batches(canonical)) {
      const params = new URLSearchParams({ condensed: 'true' });
      for (const id of group) params.append('ids[]', id);
      const papers = group.length === 1
        ? [await this.paper(group[0])]
        : z.array(paperSchema).parse(await this.request('Inciteful', 'openalex/paper', params)).map(compactPaper);
      const matched = new Map<string, ReturnType<typeof compactPaper>>();
      for (const paper of papers) {
        matched.set(idKey(String(paper.id)), paper);
        if (paper.doi) matched.set(idKey(paper.doi), paper);
      }
      for (const id of group) {
        // Batch responses can omit missing IDs and collapse aliases. Check every input.
        // Less common aliases absent from returned metadata get a singleton lookup.
        const paper = (group.length === 1 && papers.length === 1)
          ? papers[0]
          : matched.get(idKey(id)) ?? await this.paper(id);
        seeds.set(String(paper.id), paper);
      }
    }
    return seeds;
  }

  private async resolveReviewAliases(ids: string[]): Promise<string[]> {
    const mapped = new Map<string, string>();
    const groups = [
      { prefix: 'doi', ids: ids.filter(id => /^10\.\d{4,9}\/.+/i.test(id)) },
      { prefix: 'pmid', ids: ids.filter(id => /^pmid:\d+$/i.test(id)) },
    ];
    for (const { prefix, ids: aliasIds } of groups) {
      for (const group of batches(aliasIds)) {
        try {
          const data = z.object({ results: z.array(workSchema) }).parse(await this.request('OpenAlex', 'works',
            new URLSearchParams({ filter: `${prefix}:${group.map(id => prefix === 'pmid' ? id.slice(5) : id).join('|')}`, per_page: '100' })));
          for (const work of data.results) {
            const workId = normalizeId(work.id);
            if (/^W\d+$/.test(workId)) {
              if (work.doi) mapped.set(idKey(work.doi), workId);
              if (work.ids?.pmid) mapped.set(idKey(work.ids.pmid), workId);
            }
          }
        } catch {
          // The graph itself can resolve aliases, so an optional OpenAlex batch
          // lookup must never prevent a review from proceeding.
        }
      }
    }
    return [...new Map(ids.map(id => {
      const resolved = mapped.get(idKey(id)) ?? id;
      return [idKey(resolved), resolved];
    })).values()];
  }

  async literatureReview(ids: string[], input: Partial<ReviewOptions> = {}) {
    const options = reviewOptionsSchema.parse(input);
    const requested = z.array(z.string().trim().min(1).max(500)).min(1).max(MAX_REVIEW_SEEDS).parse(ids);
    // Any unresolved seed fails the call; silently dropping it would change the research topic.
    const seeds = await this.reviewSeeds(requested);
    const seedIds = [...seeds.keys()];
    const multiple = seedIds.length > 1;
    const params = new URLSearchParams();
    if (multiple) for (const id of seedIds) params.append('ids[]', id);
    const path = multiple ? 'openalex/query' : `openalex/query/${encodeURIComponent(seedIds[0])}`;
    if (multiple) params.set('prune', '10000');
    else params.set('prune', '10000');
    const sections: Partial<Record<ReviewSection, { results?: Record<string, unknown>[]; error?: string }>> = {};
    for (const section of new Set(options.sections)) {
      try {
        const rows = z.array(record).parse(await this.request('Inciteful', path, params, reviewQuery(section, multiple, options)));
        // The service may override SQL LIMIT. For graph nodes, keep seeds independently.
        const results = section === 'similar_paper_graph'
          ? [
            ...seedIds.map(paper_id => ({ paper_id, distance: multiple ? 1 : 0 })),
            ...rows.filter(r => Number(r.distance) > (multiple ? 1 : 0) && !seeds.has(String(r.paper_id))).slice(0, options.limit),
          ] : rows.slice(0, options.limit);
        sections[section] = { results };
      } catch (error) {
        sections[section] = { error: safeError(error) };
      }
    }
    const successful = Object.values(sections).filter(s => s.results !== undefined).length;
    if (!successful) throw new ApiError(`All literature-review queries failed. ${Object.values(sections)[0]?.error}`);
    return {
      source: 'Inciteful', seed_ids: seedIds,
      seeds: [...seeds.values()].map(p => ({ id: p.id, title: p.title, doi: p.doi, published_year: p.published_year })),
      graph_mode: multiple ? 'multiple' : 'single', seed_distance: multiple ? 1 : 0,
      options, sections, partial: successful < Object.keys(sections).length,
      notes: [
        'To expand this review, pass seed_ids plus selected result paper_id values in the next literature_review call. No review state is stored by the MCP server.',
        'Review papers are citation-count candidates, not verified article types. Upcoming authors are based on publication years within the filtered graph, not full career histories.',
        'similar_paper_graph returns nodes and distances only; it does not return citation edges.',
      ],
    };
  }
}

export function safeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof z.ZodError) return 'The API response did not match the expected format.';
  return 'An unexpected error occurred while processing the request.';
}
