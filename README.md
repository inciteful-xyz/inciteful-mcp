# Inciteful MCP

A TypeScript MCP server that combines OpenAlex paper search and metadata with Inciteful citation graphs. Runs locally over stdio using the official MCP TypeScript SDK v2. Requires Node.js 22 or newer.

## Setup

```sh
npm install
npm run build
```

Add this entry to your MCP client's configuration, replacing the absolute path:

```json
{
  "mcpServers": {
    "inciteful": {
      "command": "node",
      "args": ["/absolute/path/to/inciteful-mcp/dist/index.js"],
      "env": {
        "OPENALEX_API_KEY": "your-optional-key",
        "OPENALEX_EMAIL": "you@example.com"
      }
    }
  }
}
```

Omit the `env` entries you do not use. OpenAlex currently permits basic requests without a key; a key increases the available budget. See [OpenAlex authentication](https://help.openalex.org/api/). API access and quotas remain subject to upstream policies.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENALEX_API_KEY` | unset | OpenAlex API key |
| `OPENALEX_EMAIL` | unset | OpenAlex `mailto` contact |
| `INCITEFUL_BASE_URL` | `https://graph.incitefulmed.com` | Inciteful server |
| `REQUEST_TIMEOUT_MS` | `45000` | Per-request timeout, maximum 300000 |

`.env` is not loaded automatically. To use it, copy `.env.example` to `.env`, edit it, then run `node --env-file=.env dist/index.js` (or include `--env-file=/absolute/path/.env` before the script in your client's arguments). The server uses stdout exclusively for MCP messages.

## Tools

| Tool | Purpose | Main inputs |
| --- | --- | --- |
| `search_papers` | OpenAlex topic/title search with cursor pagination | `query`, `limit`, `cursor`, optional `filter` |
| `get_paper` | Full OpenAlex record or compact Inciteful record | `id`, `source` (`openalex` or `inciteful`) |
| `similar_papers` | Inciteful similarity with optional OpenAlex enrichment | `id`, `limit`, `enrich` (default true) |
| `connect_papers` | Citation paths and directed edges between two papers | `from`, `to`, `max_paths` |
| `discover_papers` | Rank a seed's graph by similarity, influence, or recency | `id`, `ranking`, `limit` |
| `literature_review` | Build a graph from 1–500 seeds and query literature-review sections | `ids`, `sections`, `limit`, optional `year_from`, `year_to`, `title_contains` |
| `get_abstract` | Readable OpenAlex abstract, with PubMed/PMC fallback | `id` |
| `get_full_text_links` | Potential PDF/article URLs with access and version metadata | `id` |
| `get_full_text` | Readable PMC or OpenAlex archive text, returned in chunks | `id`, `source`, `offset`, `max_chars` |

Limits default to 10 and cannot exceed 50. Search exposes OpenAlex's `meta.next_cursor`; pass it back as `cursor` for the next page. `get_paper` with OpenAlex returns the upstream record, including the inverted abstract index and reference IDs when available.

Example requests to an assistant using this server:

- “Search for papers on deep learning in drug discovery, published since 2020.”
- “Find 10 papers similar to DOI 10.1038/nature14539 and include OpenAlex metadata.”
- “Connect PMID 26017442 to PMID 25462637.”
- “Find influential papers in the citation graph around PMID 26017442.”

OpenAlex work IDs (`W2919115771` or their URLs) are preserved as canonical graph identifiers. DOI and PMID aliases are accepted by the OpenAlex graph namespace and are batch-resolved to W IDs for literature reviews when OpenAlex metadata is available. Numeric OpenAlex IDs are never treated as legacy Inciteful numeric IDs. Similar-paper enrichment batches exact DOI matches in one OpenAlex request; unmatched records have `openalex: null`. An enrichment failure preserves the graph results and adds a warning. Records from each provider remain separate to preserve provenance.

## Literature reviews with multiple papers

Call `literature_review` with the complete seed list:

```json
{
  "ids": ["pmid:26017442", "pmid:25462637"],
  "sections": ["similar_papers", "important_papers", "review_papers", "important_recent_papers"],
  "limit": 10,
  "year_from": 2020
}
```

Those four sections are the default when `sections` is omitted. To expand the review, take the returned `seed_ids`, append interesting `paper_id` values from the results, and call the tool again. Every call specifies the complete seed set; the MCP server does not store a review session. The MCP accepts up to 500 input seeds (a local bound, not a claim about the upstream maximum). DOI, PMID, and OpenAlex aliases resolve to canonical Inciteful IDs before deduplication. An unresolved seed fails the call rather than silently changing the graph.

“Adding papers” means choosing the seed set for a graph, not executing SQL `INSERT` or creating new scholarly records. For multiple seeds, the live request is:

```http
POST /openalex/query?ids%5B%5D=W2919115771&ids%5B%5D=W123456789&prune=10000
Content-Type: application/x-www-form-urlencoded

SELECT paper_id, distance FROM papers WHERE distance = 2
```

The current graph namespace is **`/openalex`** and the parameter name is **`ids[]`**, not the `id[]` shown in the OpenAPI spec. This was verified from [Inciteful's academic frontend](https://incitefulmed.com/academic/) and successful live requests. A single canonical seed uses `/openalex/query/{id}?prune=10000`. Similarity, paper metadata, and connector calls use the same namespace.

| Graph | Distance 0 | Distance 1 | Distance 2 |
| --- | --- | --- | --- |
| Single paper | Seed | Direct citation neighbors | Neighbors of neighbors |
| Multiple papers | Virtual paper | Selected seeds | Neighbors of the selected seeds |

These are undirected citation distances, as described in [Inciteful's graph documentation](https://incitefulmed.com/academic/help/power-users). The virtual paper is omitted from results. All ranking sections exclude seeds; multi-paper similarity and review candidates specifically require distance 2.

Available sections, adapted from the supplied single- and multi-paper dashboard queries:

| Section | Ranking or behavior |
| --- | --- |
| `similar_paper_graph` | Seed nodes plus top similar candidate nodes; no edges |
| `similar_papers` | Adamic–Adar plus co-citation, then PageRank; requires a positive similarity component |
| `important_papers` | PageRank, then Adamic–Adar |
| `review_papers` | Outgoing citation counts, retaining the supplied repeated journal/year/count exclusion heuristic |
| `recent_top_authors` | Recent graph papers by the top 100 authors ranked by summed partial PageRank |
| `important_recent_papers` | PageRank among papers newer than current year minus three |
| `top_authors` | Summed partial PageRank per author |
| `upcoming_authors` | Author ranking with earliest filtered graph publication newer than current year minus ten |
| `institutions` | Summed PageRank after deduplicating paper/institution affiliations |
| `top_journals` | Summed PageRank per journal |
| `similar_journals` | Summed similarity per journal, then summed PageRank |

`year_from` and `year_to` are inclusive. `title_contains` is a literal substring (SQL quotes and wildcard characters are escaped). Filters apply to ranking candidates; the graph-node section always retains seeds. `limit` applies per section, with up to 500 extra seed nodes for `similar_paper_graph`.

The templates use `COALESCE` on both similarity components so co-citation-only matches are not lost. Authors are grouped by stable ID and name, avoiding name collisions. Recent top-author queries use the verified `authors.partial_page_rank` field in both graph modes. Journal similarity uses an aggregated PageRank tie-breaker instead of an arbitrary ungrouped row. “Review papers” are candidates, not confirmed review article types; “upcoming” reflects only the filtered graph, not an author's full career. The graph-node section includes all seeds explicitly, extending the supplied multi-paper node query for consistent iteration.

Seed metadata and aliases are resolved in batches of up to 50, reduced further for long identifiers. Every input is checked against returned IDs/DOIs; unresolved aliases are sent directly to the graph namespace, which can resolve DOI/PMID aliases itself. All canonical W IDs are then submitted together for each graph query. Thus 500 W-ID seeds normally need ten graph metadata requests plus one query per section; 500 DOI/PMID seeds may add up to ten optional OpenAlex alias-batch requests. Only concise seed metadata is returned. Results are Inciteful records; use `get_paper` with a result DOI for OpenAlex metadata. A failed section is reported under its `error` field with `partial: true`; successful sections remain available. If every section fails, the tool returns an MCP error.

## Abstracts and full text

The agent can read content directly through this MCP or retrieve publisher/repository copies using the URLs it returns:

1. `get_abstract({"id":"10.1371/journal.pone.0000217"})` reconstructs readable text from OpenAlex's abstract index. If unavailable, a known PMID enables a PubMed BioC fallback. A PMCID can retrieve the abstract from PMC BioC directly.
2. `get_full_text_links({"id":"10.1371/journal.pone.0000217"})` returns candidate URLs from `best_oa_location`, `locations`, `primary_location`, `open_access.oa_url`, and the OpenAlex content archive. Each link includes format, source, open-access flag, license, version, and whether an OpenAlex key is needed. Best-OA links come first; duplicates are removed. See [OpenAlex locations](https://help.openalex.org/data/locations/).
3. `get_full_text({"id":"PMC1790863","max_chars":15000})` fetches extracted article text. `source` defaults to `auto`: PMC BioC first, then OpenAlex Grobid XML if advertised and an API key is configured. Choose `pmc` or `openalex` to restrict the source.

The abstract/full-text tools accept a DOI, OpenAlex ID, PMID, Inciteful ID, PMCID (`PMC1790863` or `pmcid:PMC1790863`), or a canonical PMC article URL. DOI/OpenAlex lookups need a PMID to use the PMC route. `get_full_text_links` uses OpenAlex-compatible IDs or an Inciteful ID resolvable to DOI/PMID.

Responses include the source URL and extracted text. Continue with the same `id` and `source`, setting `offset` to `next_offset`, until it is null. `max_chars` defaults to 15000 and is capped at 50000; offsets count JavaScript UTF-16 code units. The `content_sha256` identifies the complete extracted text, so the agent can detect changes between pages. The process caches up to eight articles for 15 minutes to avoid downloading each chunk separately; cache contents are not written to disk. Each download is capped at 12 MiB.

PMC's [BioC service](https://www.ncbi.nlm.nih.gov/research/bionlp/APIs/BioC-PMC/) supplies machine-readable article passages. [OpenAlex's archive](https://help.openalex.org/access/fulltext/) supplies PDFs and Grobid TEI XML; its downloads require `OPENALEX_API_KEY` and currently cost $0.01 per file. The MCP uses XML for text extraction. Ordinary publisher/repository URLs do not require an OpenAlex API key, though the destination may impose its own access requirements.

`status: "not_retrieved"` means none of the attempted sources supplied readable text; it does not establish that full text is unavailable everywhere. The response includes attempt details and candidate links when available. The agent can use its own browser/PDF tools on these URLs. The MCP does not currently scrape arbitrary publisher pages, extract PDFs, perform OCR, or authenticate with institutions. Extracted text may lose figure, equation, or table layout. Abstract-only BioC responses are not labeled as full text.

### Research Gateway integration decision

[Claude Research Gateway](https://github.com/CoderrOne/claude-research-gateway) is a separate Python MCP server using Playwright for institutional login and HTML/PDF extraction. It could run alongside this server: use Inciteful/OpenAlex for discovery, then hand a DOI or candidate URL to its `fetch_paper` tool. We have not installed it or copied its implementation.

The current choice is to implement abstract retrieval, content links, and structured full-text retrieval directly here. Institutional login remains an optional next layer requiring the institution/proxy details and an interactive login. Before adopting the gateway's session handling, address its [HTTP-200-only session validation and loss of cookie Secure/expiry attributes during HTTP-client injection](https://github.com/CoderrOne/claude-research-gateway/blob/master/session_manager.py). Its [authentication detection](https://github.com/CoderrOne/claude-research-gateway/blob/master/browser_auth.py) also relies on page/domain heuristics, so actual article access needs verification after login.

## API behavior and limitations

Implemented against [Inciteful's API documentation](https://graph.incitefulmed.com/help), its [OpenAPI specification](https://graph.incitefulmed.com/openapi.yaml), [graph schema documentation](https://incitefulmed.com/academic/help/power-users), and [OpenAlex's API reference](https://help.openalex.org/api/). Live checks on September 16, 2026 found:

- The Inciteful spec advertises a different server URL; this project uses the requested `graph.incitefulmed.com` host.
- Paper/path IDs can be strings such as `pmid:26017442`, despite numeric IDs in the schema.
- Similar-paper count uses the query parameter `n`, despite the spec marking it as a path parameter.
- `condensed=true` can still return citation arrays. The server removes them from compact paper results.
- The current frontend graph routes are under `/openalex`: paper metadata, similarity, connector, and raw SQL query. The MCP now sends the same `prune=10000` query parameter and raw SQL form body.
- `POST /openalex/query/{OpenAlexWorkID}` and multi-seed `POST /openalex/query?ids[]=...` can return more rows than the SQL `LIMIT`; the MCP applies its requested limit locally.
- An earlier MCP 404/500 for `W7154975096` was caused by using the legacy root routes and converting the W ID to a DOI before graph lookup. The corrected adapter preserves `W7154975096`; live MCP calls for lookup, similarity, and discovery now pass.
- `/bib` returned an empty body for the tested paper and remains unexposed. The frontend uses a separate `/export/bib` route, which has not been implemented here.
- OpenAlex singleton DOI lookup requires the DOI URL form; a bare DOI returned 404. The server normalizes it automatically.

Citation paths are capped locally; `truncated` indicates omitted paths and `num_paths` retains the upstream total. Only papers and edges among the returned paths are included. Graph coverage can differ from OpenAlex; missing records are reported as errors rather than silently substituted. Results reflect upstream data and graph scores, which do not establish research quality or clinical validity.

Requests have timeouts, schema checks, bounded result counts, and sanitized errors. There are no automatic retries, crawling, persistent caching, or bulk harvesting. Each similar-paper request makes one graph call plus at most one OpenAlex enrichment call; resolving an OpenAlex seed adds a lookup. Avoid high-volume graph use; Inciteful asks users planning thousands of papers or hundreds of graphs to contact them first.

## Development

```sh
npm run dev
npm run check
npm test
npm run build
```

Tests use mocked API responses, local SQLite query execution, and a real stdio MCP client/server exchange; they do not call live services. SQLite tests require Node.js 22.13 or newer. Live API checks are separate from the repeatable test suite.

After building, `npm run smoke` tests the original five tools through MCP against the live APIs, including DOI enrichment. `npm run smoke:review` tests all 11 review sections in both single- and multi-seed modes (22 graph queries plus seed lookups). Both require network access. All 22 review queries passed live verification on September 16, 2026.

To check a larger seed set explicitly, place an array of known paper IDs in a JSON file and run `npm run smoke:review -- /absolute/path/seeds.json`. This runs similarity and influence queries for that seed set. A live 200-seed review passed both queries on September 16, 2026; the 500-seed batching and request shape are covered by mocked tests. Large reviews may need a longer MCP client call timeout; `REQUEST_TIMEOUT_MS` controls each individual upstream request.

`npm run smoke:content` checks OpenAlex abstract retrieval, candidate URLs, and paginated PMC full text through MCP. These passed live verification on September 16, 2026. OpenAlex authenticated archive downloads are covered by mocked tests and have not been verified with a live key. Content downloads reject redirects; sources requiring redirects remain available as candidate links for agent retrieval.
