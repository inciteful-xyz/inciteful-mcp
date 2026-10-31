// Limits and constants for the hosted server (plan Global Constraints). Task 6 adds the rate limiter
// and the build cap classes to this file.

/** The eight tool names. `tools.ts` registers exactly these; the usage log stores any other name as NULL. */
export const TOOL_NAMES = [
  'search_literature', 'get_papers', 'find_similar_papers', 'explore_citation_network',
  'connect_papers', 'query_citation_graph', 'read_paper', 'export_citations',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Ceiling on one tool call. The graph call behind a timed-out tool call keeps running upstream. */
export const TOOL_CEILING_MS = 90_000;
/**
 * Added to the ceiling before a tool call's non-build work is aborted, so a build that reaches the
 * deadline reports "still building" (the build cap's error) rather than the generic timeout.
 */
export const GRACE_MS = 1_000;
/** Longest wait for a graph's `metadata` after its query; the stats are dropped when it runs out. */
export const METADATA_WAIT_MS = 5_000;
/** Graph builds in flight at once. A build is any call to `/query`, `/paper/similar` or `/connector`. */
export const BUILD_CAP = 4;

/** `get_papers` and `export_citations`. */
export const MAX_PAPER_IDS = 100;
/** Seeds per graph tool. */
export const MAX_SEEDS = 500;
/** `limit` caps: `search_literature`; `find_similar_papers` and `explore_citation_network`; `query_citation_graph`. */
export const MAX_SEARCH_LIMIT = 50;
export const MAX_ANALYSIS_LIMIT = 100;
export const MAX_SQL_LIMIT = 500;
/** Characters in `query_citation_graph`'s `sql` and `search_literature`'s `query`. */
export const MAX_SQL_CHARS = 10_000;
export const MAX_QUERY_CHARS = 1_000;
/** Characters in one paper id or seed (a DOI, OpenAlex ID, PMID or PMCID). */
export const MAX_ID_CHARS = 300;
/** `read_paper`'s `max_chars`. */
export const MAX_READ_CHARS = 50_000;
/** Serialized result size (`Buffer.byteLength` of the JSON) above which rows are trimmed. */
export const OUTPUT_CAP_BYTES = 60_000;
/** Seed-set links to the web app carry at most this many ids, to fit URL limits. */
export const URL_SEED_CAP = 50;

/** Requests per minute per caller key, and per vendor range for keys inside one. */
export const RATE_LIMIT_PER_MINUTE = 60;
export const VENDOR_RATE_LIMIT_PER_MINUTE = 600;

/** Anthropic's published egress range. */
export const ANTHROPIC_RANGES: readonly string[] = ['160.79.104.0/21'];

/**
 * OpenAI's published ChatGPT actions egress ranges, from https://openai.com/chatgpt-actions.json
 * (fetched 2026-10-30; the file's creationTime is 2026-10-27T18:08:43). Refresh from that URL.
 */
export const OPENAI_RANGES: readonly string[] = [
  '104.208.184.192/28', '104.210.139.192/28', '104.210.139.224/28', '13.237.176.161/32', '13.238.110.96/32',
  '13.65.138.112/28', '13.67.72.16/28', '13.71.2.208/28', '13.76.116.80/28', '13.76.32.208/28', '13.83.237.176/28',
  '132.196.82.48/28', '134.138.52.16/28', '134.138.52.64/28', '134.138.57.64/28', '134.138.57.80/28',
  '134.149.233.80/28', '134.33.102.192/28', '135.116.136.160/28', '135.13.64.240/28', '135.220.73.208/28',
  '135.222.99.32/28', '135.237.133.48/28', '137.135.191.176/28', '145.132.136.96/28', '15.168.252.168/32',
  '172.162.248.64/28', '172.170.1.80/28', '172.170.225.0/28', '172.170.241.80/28', '172.172.206.48/28',
  '172.175.152.224/28', '172.177.53.240/28', '172.183.143.224/28', '172.192.112.208/28', '172.198.58.176/28',
  '172.198.79.112/28', '172.199.137.80/28', '172.204.96.80/28', '172.206.38.240/28', '172.207.1.32/28',
  '172.215.215.32/28', '191.232.238.96/28', '191.234.167.144/28', '191.237.249.64/28', '20.102.212.144/28',
  '20.125.112.224/28', '20.168.7.192/28', '20.169.78.48/28', '20.169.78.64/28', '20.169.86.224/28',
  '20.170.184.16/28', '20.170.184.32/28', '20.170.184.48/28', '20.170.184.64/28', '20.170.184.80/28',
  '20.172.29.32/28', '20.206.101.192/28', '20.212.62.208/28', '20.215.187.208/28', '20.215.219.208/28',
  '20.219.161.192/28', '20.219.184.96/28', '20.227.140.32/28', '20.228.106.176/28', '20.235.87.224/28',
  '20.249.63.208/28', '20.250.136.64/28', '20.254.201.208/28', '20.44.100.224/28', '20.45.178.144/28',
  '20.55.229.144/28', '20.57.199.192/28', '20.63.221.64/28', '20.78.130.48/28', '20.98.18.80/28',
  '23.101.217.176/28', '23.102.141.32/28', '23.98.186.64/28', '23.98.186.96/28', '4.151.119.48/28',
  '4.151.71.176/28', '4.189.118.208/28', '4.197.115.112/28', '4.197.64.0/28', '4.197.64.48/28', '4.201.232.64/28',
  '4.205.128.176/28', '4.218.24.64/28', '4.226.200.16/28', '4.226.226.32/28', '40.119.36.240/28', '40.124.161.0/28',
  '43.202.230.227/32', '44.249.227.138/32', '48.221.184.80/28', '48.221.184.96/28', '48.221.40.176/28',
  '51.57.0.96/28', '51.59.24.64/28', '51.59.24.80/28', '51.59.48.80/28', '52.148.129.32/28', '52.165.212.48/28',
  '52.17.188.55/32', '52.172.129.160/28', '52.173.221.16/28', '52.173.234.16/28', '52.173.234.80/28',
  '52.190.137.144/28', '52.190.137.16/28', '52.190.139.48/28', '52.190.142.64/28', '52.190.251.112/28',
  '52.208.217.159/32', '52.231.30.48/28', '52.231.39.144/28', '52.242.132.224/28', '52.242.132.240/28',
  '52.255.109.144/28', '52.255.109.80/28', '52.255.109.96/28', '52.255.111.0/28', '52.43.161.225/32',
  '54.180.197.31/32', '56.155.71.179/32', '57.154.174.112/28', '57.154.187.32/28', '68.154.28.96/28',
  '68.220.57.64/28', '70.153.32.16/28', '70.153.32.32/28', '70.156.152.96/28', '74.161.200.96/28',
  '74.224.217.64/28', '74.226.253.160/28', '74.248.37.160/28', '74.7.35.112/28', '74.7.35.48/28', '74.7.36.64/28',
  '74.7.36.80/28', '74.7.36.96/28', '85.211.128.16/28', '85.211.128.32/28', '9.129.0.0/16', '9.160.128.16/28',
  '9.160.128.64/28', '9.160.96.16/28', '9.205.128.32/28', '9.205.128.48/28', '9.205.8.48/28', '9.205.8.64/28',
  '9.234.96.192/28', '9.234.97.96/28',
];

/** Every vendor range; each range gets its own shared bucket. */
export const VENDOR_RANGES: readonly string[] = [...ANTHROPIC_RANGES, ...OPENAI_RANGES];

/** Usage rows older than this are purged. */
export const USAGE_RETENTION_DAYS = 90;
/** Random bytes in the daily `ip_hash` salt. */
export const USAGE_SALT_BYTES = 32;
