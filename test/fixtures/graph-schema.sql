-- Graph database schema, copied verbatim from inciteful-med origin/main @ 65d318f85:
--   graph-api/shared/src/paper_graph_database/sql/{init,finalize_base,partial_page_rank,finalize_analysis}.sql
-- Sections run in loader.rs order. Between them the test inserts what Rust writes as values:
--   after init: papers (base columns), authors and the metadata rows;
--   after finalize_base: the analysis columns (num_citing, num_cited_by, distance, page_rank, adamic_adar, cocite).
-- Each '-- @section <name>' line starts the next file's statements.

-- @section init
CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);

CREATE TABLE papers (
  paper_id TEXT PRIMARY KEY,
  doi TEXT,
  authors TEXT,
  num_authors INTEGER,
  title TEXT,
  published_year INTEGER,
  journal TEXT,
  num_citing INTEGER,
  num_cited_by INTEGER,
  distance INTEGER,
  page_rank REAL,
  adamic_adar REAL,
  cocite REAL
) WITHOUT ROWID;

CREATE TABLE authors (
  author_id TEXT,
  paper_id TEXT,
  name TEXT,
  sequence INTEGER,
  affiliation TEXT,
  affiliation_id TEXT,
  ror TEXT,
  published_year INTEGER,
  partial_page_rank REAL,
  PRIMARY KEY(paper_id, author_id)
) WITHOUT ROWID;


-- @section finalize_base
CREATE VIRTUAL TABLE title_search USING FTS5(paper_id, search_text, tokenize = 'porter unicode61');

INSERT INTO title_search (paper_id, search_text) SELECT paper_id, title from papers;
CREATE VIRTUAL TABLE all_title_terms USING fts5vocab(title_search, row);

CREATE VIEW title_terms AS
SELECT term, doc as doc_count
FROM all_title_terms
WHERE term NOT IN (
    'and',
    'of',
    'the',
    'in',
    'a',
    'on',
    'to',
    'for',
    'an',
    'from',
    's',
    'with',
    'among'
);


-- @section partial_page_rank
UPDATE authors SET partial_page_rank = (
    SELECT COALESCE(p.page_rank, 0.0) / (
        CASE
            WHEN p.num_authors <= 0 THEN 1
            WHEN p.num_authors < 4 THEN p.num_authors
            WHEN authors.sequence = 0
              OR authors.sequence = p.num_authors - 1 THEN 3.0
            ELSE p.num_authors * 3.0
        END
    )
    FROM papers p WHERE p.paper_id = authors.paper_id
)


-- @section finalize_analysis
CREATE INDEX idx_distance ON papers(distance);
CREATE INDEX idx_year_pagerank ON papers(published_year, page_rank);
CREATE INDEX idx_numciting ON papers(num_citing);
CREATE INDEX idx_authors_name ON authors(name, partial_page_rank, published_year);
CREATE INDEX idx_authors_inst ON authors(affiliation_id, affiliation, paper_id)
  WHERE affiliation <> '';
ANALYZE;

