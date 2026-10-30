// Shared shapes passed between modules.

export type SeedResolution = { input: string; id: string | null; reason: 'not_found' | 'unavailable' | null };

/** Graph provenance from the `X-Graph-Snapshot` and `X-Graph-Recent-Tier` response headers. */
export type GraphMeta = { snapshot: string | null; recentTier: string | null };

export interface BuildCapLike {
  run<T>(key: string, fn: () => Promise<T>, deadlineMs: number): Promise<T>;
}

export type UsageRow = {
  tool: string | null;
  clientName: string | null;
  clientVersion: string | null;
  callerKey: string;
  durationMs: number;
  outcome: 'ok' | 'tool_error' | 'rate_limited' | 'upstream_unavailable' | 'timeout';
  graphPapers: number | null;
  graphDepth: number | null;
  openalexCalls: number | null;
  count?: number;
};

export interface UsageSink {
  record(row: UsageRow): void;
}

export type PageCtx = { publicBaseUrl: URL } & GraphMeta;

export interface Pages {
  landing(ctx: PageCtx): string;
  privacy(ctx: PageCtx): string;
  terms(ctx: PageCtx): string;
  notFound(ctx: PageCtx): string;
}
