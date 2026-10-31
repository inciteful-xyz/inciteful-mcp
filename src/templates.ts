// Fixed SQL templates for `explore_citation_network`, from Inciteful's single- and multi-seed dashboards.
// Single-seed graphs put the seed at distance 0. Multi-seed graphs put the synthetic W0 at 0 and the seeds at 1.

export const analyses = ['similar', 'important', 'reviews', 'recent', 'authors', 'journals', 'institutions'] as const;
export type Analysis = typeof analyses[number];

export type AnalysisOptions = { titleMatch: string | null; yearFrom?: number; yearTo?: number; limit: number };

/** Numbers are interpolated into SQL, so anything but an integer is refused. */
function int(name: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be an integer`);
  return value;
}

export function analysisSql(a: Analysis, multiple: boolean, o: AnalysisOptions): string {
  // Excludes the seed (single) or W0 and the seeds (multiple) from every ranking.
  const filters = [`p.distance > ${multiple ? 1 : 0}`];
  if (o.yearFrom !== undefined) filters.push(`p.published_year >= ${int('yearFrom', o.yearFrom)}`);
  if (o.yearTo !== undefined) filters.push(`p.published_year <= ${int('yearTo', o.yearTo)}`);
  // The table-function form graph-api's SQL validator already accepts from the web app.
  if (o.titleMatch !== null) filters.push(`p.paper_id IN (SELECT paper_id FROM title_search('${o.titleMatch.replace(/'/g, "''")}'))`);
  const where = filters.join(' AND ');
  // Multi-seed similarity is measured against W0, so only the seeds' direct neighbours are comparable.
  const neighbors = multiple ? ' AND p.distance = 2' : '';
  const positive = '(p.adamic_adar > 0 OR p.cocite > 0)';
  const similarity = 'COALESCE(p.adamic_adar, 0) + COALESCE(p.cocite, 0)';
  const columns = 'p.paper_id, p.doi, p.authors, p.title, p.journal, p.published_year, p.num_cited_by, p.distance';
  const recent = "p.published_year > (CAST(strftime('%Y', 'now') AS INTEGER) - 3)";
  const limit = ` LIMIT ${int('limit', o.limit)}`;
  switch (a) {
    case 'similar':
      return `SELECT ${columns}, ${similarity} AS similarity FROM papers p WHERE ${where}${neighbors} AND ${positive} ORDER BY similarity DESC, p.page_rank DESC${limit}`;
    case 'important':
      return `SELECT ${columns}, p.page_rank FROM papers p WHERE ${where} ORDER BY p.page_rank DESC, p.adamic_adar DESC${limit}`;
    case 'reviews':
      // Leaves out clusters of same-count papers in one year and journal (bulk records, not reviews).
      return `SELECT ${columns}, p.num_citing FROM papers p LEFT JOIN (
        SELECT num_citing, published_year, journal, COUNT(*) AS num_papers FROM papers
        WHERE num_citing > 10 GROUP BY num_citing, published_year, journal
        HAVING COUNT(*) > 8 ORDER BY num_papers DESC LIMIT 10
      ) b ON b.num_citing = p.num_citing AND b.published_year = p.published_year AND b.journal = p.journal
      WHERE b.num_citing IS NULL AND ${where}${neighbors}
      ORDER BY p.num_citing DESC, p.adamic_adar DESC, p.num_cited_by DESC${limit}`;
    case 'recent':
      return `SELECT ${columns}, p.page_rank FROM papers p WHERE ${where} AND ${recent} ORDER BY p.page_rank DESC, p.adamic_adar DESC${limit}`;
    case 'authors':
      // Grouped by stable ID, so different authors who share a name stay separate.
      return `SELECT a.author_id, a.name AS author_name, SUM(a.partial_page_rank) AS total_page_rank, COUNT(DISTINCT p.paper_id) AS num_papers
        FROM papers p JOIN authors a ON p.paper_id = a.paper_id WHERE ${where}
        GROUP BY a.author_id, a.name ORDER BY total_page_rank DESC${limit}`;
    case 'journals':
      return `SELECT p.journal, SUM(p.page_rank) AS total_page_rank, COUNT(*) AS num_papers FROM papers p
        WHERE ${where} AND p.journal <> '' AND p.journal NOT LIKE '%ebook%'
        GROUP BY p.journal ORDER BY total_page_rank DESC${limit}`;
    case 'institutions':
      return `SELECT a.affiliation_id, a.affiliation, SUM(p.page_rank) AS total_page_rank, COUNT(*) AS num_papers
        FROM papers p JOIN (SELECT DISTINCT paper_id, affiliation, affiliation_id FROM authors) a ON p.paper_id = a.paper_id
        WHERE ${where} AND a.affiliation <> '' GROUP BY a.affiliation_id, a.affiliation ORDER BY total_page_rank DESC${limit}`;
  }
}

const OPENALEX_LINKED = 'OpenAlex cited_by:/cites: filter, sorted by global cited_by_count';

/** The provenance `method` for each analysis. `fast_similar` is `find_similar_papers`' graph-api fast path. */
export function methodFor(a: Analysis | 'references' | 'citations' | 'fast_similar', multiple: boolean): string {
  const graph = multiple ? 'local; multi-seed graph rooted at a synthetic paper citing all seeds' : 'local; single-seed graph';
  switch (a) {
    case 'references':
    case 'citations':
      return OPENALEX_LINKED;
    case 'fast_similar':
      // Nothing cites W0, so the Salton part is always 0 with several seeds.
      return multiple ? 'fast similarity: Adamic/Adar, depth 1 (multi-seed)' : 'fast similarity: Adamic/Adar + Salton, depth 1';
    case 'similar':
      return multiple
        ? `adamic_adar (Adamic/Adar against the synthetic paper; seeds' direct neighbours only; ${graph})`
        : `adamic_adar + cocite (Adamic/Adar + Salton; ${graph})`;
    case 'important':
      return `page_rank (${graph})`;
    case 'reviews':
      return `num_citing, in-graph references (${graph}${multiple ? "; seeds' direct neighbours only" : ''})`;
    case 'recent':
      return `page_rank, papers from the last 3 years (${graph})`;
    case 'authors':
      return `sum of partial_page_rank per author (${graph})`;
    case 'journals':
      return `sum of page_rank per journal (${graph})`;
    case 'institutions':
      return `sum of page_rank per institution (${graph})`;
  }
}
