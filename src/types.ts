// Shared shapes passed between modules.

export type SeedResolution = { input: string; id: string | null; reason: 'not_found' | 'unavailable' | null };

/** Graph provenance from the `X-Graph-Snapshot` and `X-Graph-Recent-Tier` response headers. */
export type GraphMeta = { snapshot: string | null; recentTier: string | null };

export interface BuildCapLike {
  /**
   * @param deadlineAt Absolute epoch-ms time on the injected clock (the same clock as `now()`).
   * Set once per tool call at its start, as `now() + TOOL_CEILING_MS`, so time spent before the
   * build (for example in `resolve`) counts against it.
   */
  run<T>(key: string, fn: () => Promise<T>, deadlineAt: number): Promise<T>;
}

/** graph-api's `CondensedPaperView`, with fields as serialized. */
export type CondensedPaper = {
  id: string;
  doi?: string | null;
  title: string;
  published_year?: number | null;
  journal?: string | null;
  author?: Array<{ name: string }> | null;
  num_cited_by: number;
  num_citing: number;
};

export type UsageRow = {
  tool: string | null;
  clientName: string | null;
  clientVersion: string | null;
  callerKey: string;
  durationMs: number;
  /** `rate_limited`: our own 429 (rejection rows). `upstream_rate_limited`: OpenAlex's short limit. */
  outcome: 'ok' | 'tool_error' | 'rate_limited' | 'upstream_unavailable' | 'upstream_rate_limited' | 'timeout';
  graphPapers: number | null;
  graphDepth: number | null;
  openalexCalls: number | null;
  count?: number;
};

export interface UsageSink {
  /** One row per `tools/call`. */
  record(row: UsageRow): void;
  /** One per 429; aggregated per (minute, caller). */
  recordRejection(callerKey: string): void;
  /** Writes pending rejections and closes the store (SIGTERM). */
  close(): void;
}

export type PageCtx = { publicBaseUrl: URL } & GraphMeta;

export interface Pages {
  landing(ctx: PageCtx): string;
  privacy(ctx: PageCtx): string;
  terms(ctx: PageCtx): string;
  notFound(ctx: PageCtx): string;
}
