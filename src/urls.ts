import { URL_SEED_CAP } from './limits.js';

export type CappedUrl = { url: string; capped: boolean };

export type Urls = {
  paperUrl(id: string): string;
  /** At most `URL_SEED_CAP` ids, in the order given; `capped` says some were left out. */
  seedSetUrl(ids: string[]): CappedUrl;
  connectorUrl(from: string, to: string): string;
  /** The SQL view of a seed set, capped like `seedSetUrl`. */
  sqlUrl(ids: string[], sql: string): CappedUrl;
};

/** Links into the Inciteful web app on the public origin. `ids[]` is written as the web app reads it. */
export function createUrls(publicBaseUrl: URL): Urls {
  const base = publicBaseUrl.origin;
  const idParams = (ids: string[]) => {
    const kept = ids.slice(0, URL_SEED_CAP);
    return { query: kept.map(id => `ids[]=${encodeURIComponent(id)}`).join('&'), capped: ids.length > kept.length };
  };
  return {
    paperUrl: id => `${base}/academic/p/${encodeURIComponent(id)}`,
    seedSetUrl: ids => {
      const { query, capped } = idParams(ids);
      return { url: `${base}/academic/p?${query}`, capped };
    },
    connectorUrl: (from, to) => `${base}/academic/c?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    sqlUrl: (ids, sql) => {
      const { query, capped } = idParams(ids);
      return { url: `${base}/academic/p/q?${query}&sql=${encodeURIComponent(sql)}`, capped };
    },
  };
}
