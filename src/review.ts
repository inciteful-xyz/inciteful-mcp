import { z } from 'zod';

export const MAX_REVIEW_SEEDS = 500;

export const reviewSections = [
  'similar_paper_graph', 'similar_papers', 'important_papers', 'review_papers',
  'recent_top_authors', 'important_recent_papers', 'top_authors', 'upcoming_authors',
  'institutions', 'top_journals', 'similar_journals',
] as const;
export type ReviewSection = typeof reviewSections[number];
export const reviewOptionsSchema = z.object({
  sections: z.array(z.enum(reviewSections)).min(1).max(reviewSections.length)
    .default(['similar_papers', 'important_papers', 'review_papers', 'important_recent_papers']),
  limit: z.number().int().min(1).max(50).default(10),
  year_from: z.number().int().min(1).max(9999).optional(),
  year_to: z.number().int().min(1).max(9999).optional(),
  title_contains: z.string().trim().min(1).max(200).optional(),
}).refine(o => o.year_from === undefined || o.year_to === undefined || o.year_from <= o.year_to,
  { message: 'year_from must be less than or equal to year_to' });
export type ReviewOptions = z.infer<typeof reviewOptionsSchema>;

/** Fixed SQL templates based on Inciteful's single- and multi-seed dashboards. */
export function reviewQuery(section: ReviewSection, multiple: boolean, options: ReviewOptions): string {
  const filters = [`p.distance > ${multiple ? 1 : 0}`];
  if (options.year_from !== undefined) filters.push(`p.published_year >= ${options.year_from}`);
  if (options.year_to !== undefined) filters.push(`p.published_year <= ${options.year_to}`);
  if (options.title_contains) {
    // Literal substring: quote SQL and escape LIKE wildcard characters independently.
    const literal = options.title_contains.replace(/'/g, "''").replace(/[\\%_]/g, '\\$&');
    filters.push(`p.title LIKE '%${literal}%' ESCAPE '\\'`);
  }
  const where = filters.join(' AND ');
  const neighbors = multiple ? ' AND p.distance = 2' : '';
  const positive = '(p.adamic_adar > 0 OR p.cocite > 0)';
  const similarity = 'COALESCE(p.adamic_adar, 0) + COALESCE(p.cocite, 0)';
  const columns = 'p.paper_id, p.doi, p.authors, p.title, p.journal, p.published_year, p.num_cited_by, p.distance';
  const recent = "p.published_year > (CAST(strftime('%Y', 'now') AS INTEGER) - 3)";
  const limit = ` LIMIT ${options.limit}`;
  switch (section) {
    case 'similar_paper_graph':
      // Source/seed nodes always remain visible, even when filters exclude them.
      return `WITH candidates AS (SELECT p.paper_id, p.distance, ${similarity} AS similarity FROM papers p WHERE ${where} ORDER BY similarity DESC, p.page_rank DESC${limit})
        SELECT paper_id, distance FROM papers WHERE distance = ${multiple ? 1 : 0}
        UNION ALL SELECT paper_id, distance FROM candidates`;
    case 'similar_papers':
      return `SELECT ${columns}, ${similarity} AS similarity FROM papers p WHERE ${where}${neighbors} AND ${positive} ORDER BY similarity DESC, p.page_rank DESC${limit}`;
    case 'important_papers':
      return `SELECT ${columns}, p.page_rank FROM papers p WHERE ${where} ORDER BY p.page_rank DESC, p.adamic_adar DESC${limit}`;
    case 'review_papers':
      return `SELECT ${columns}, p.num_citing FROM papers p LEFT JOIN (
        SELECT num_citing, published_year, journal, COUNT(*) AS num_papers FROM papers
        WHERE num_citing > 10 GROUP BY num_citing, published_year, journal
        HAVING COUNT(*) > 8 ORDER BY num_papers DESC LIMIT 10
      ) b ON b.num_citing = p.num_citing AND b.published_year = p.published_year AND b.journal = p.journal
      WHERE b.num_citing IS NULL AND ${where}${neighbors}
      ORDER BY p.num_citing DESC, p.adamic_adar DESC, p.num_cited_by DESC${limit}`;
    case 'recent_top_authors':
      // Stable IDs avoid combining different authors who share a name.
      return `WITH top_authors AS (
        SELECT a.author_id FROM authors a JOIN papers p ON p.paper_id = a.paper_id
        GROUP BY a.author_id ORDER BY SUM(a.partial_page_rank) DESC LIMIT 100
      ) SELECT ${columns}, p.adamic_adar FROM papers p
      WHERE ${where} AND ${recent} AND EXISTS (
        SELECT 1 FROM authors a JOIN top_authors t ON t.author_id = a.author_id WHERE a.paper_id = p.paper_id
      ) ORDER BY p.adamic_adar DESC, p.page_rank DESC${limit}`;
    case 'important_recent_papers':
      return `SELECT ${columns}, p.page_rank FROM papers p WHERE ${where} AND ${recent} ORDER BY p.page_rank DESC, p.adamic_adar DESC${limit}`;
    case 'top_authors':
    case 'upcoming_authors':
      return `SELECT a.author_id, a.name AS author_name, SUM(a.partial_page_rank) AS total_page_rank, COUNT(DISTINCT p.paper_id) AS num_papers
        FROM papers p JOIN authors a ON p.paper_id = a.paper_id WHERE ${where}
        GROUP BY a.author_id, a.name${section === 'upcoming_authors' ? " HAVING MIN(p.published_year) > (CAST(strftime('%Y', 'now') AS INTEGER) - 10)" : ''}
        ORDER BY total_page_rank DESC${limit}`;
    case 'institutions':
      return `SELECT a.affiliation_id, a.affiliation, SUM(p.page_rank) AS total_page_rank, COUNT(*) AS num_papers
        FROM papers p JOIN (SELECT DISTINCT paper_id, affiliation, affiliation_id FROM authors) a ON p.paper_id = a.paper_id
        WHERE ${where} AND a.affiliation <> '' GROUP BY a.affiliation_id, a.affiliation ORDER BY total_page_rank DESC${limit}`;
    case 'top_journals':
      return `SELECT p.journal, SUM(p.page_rank) AS total_page_rank, COUNT(*) AS num_papers FROM papers p
        WHERE ${where} AND p.journal <> '' AND p.journal NOT LIKE '%ebook%'
        GROUP BY p.journal ORDER BY total_page_rank DESC${limit}`;
    case 'similar_journals':
      return `SELECT p.journal, SUM(${similarity}) AS similarity, COUNT(*) AS num_papers FROM papers p
        WHERE ${where} AND ${positive} AND p.journal <> '' AND p.journal NOT LIKE '%ebook%'
        GROUP BY p.journal ORDER BY similarity DESC, SUM(p.page_rank) DESC${limit}`;
  }
}
