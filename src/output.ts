import { OUTPUT_CAP_BYTES } from './limits.js';

export const MAX_OUTPUT_BYTES = OUTPUT_CAP_BYTES;
export const TRUNCATED_ADVISORY = 'Output truncated; narrow the request (lower limit, fewer seeds, a title filter).';

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/**
 * Keeps a tool result under `maxBytes` of serialized JSON by dropping rows from the end. Nothing else is
 * trimmed. A trimmed result gets `truncated: true` and the advisory in `diagnostics.advisories` (a
 * `diagnostics` block is added when the result has none). The input is not mutated.
 */
export function capResult<T extends { rows: unknown[] }>(value: T, maxBytes = MAX_OUTPUT_BYTES): T & { truncated: boolean } {
  const whole = { ...value, truncated: false };
  if (size(whole) <= maxBytes) return whole;

  const diagnostics = (value as { diagnostics?: { advisories?: string[] } }).diagnostics;
  const flagged = {
    ...value,
    truncated: true,
    diagnostics: { ...diagnostics, advisories: [...(diagnostics?.advisories ?? []), TRUNCATED_ADVISORY] },
  };
  const withRows = (n: number) => ({ ...flagged, rows: value.rows.slice(0, n) });
  // Largest row count that fits; zero rows when even that doesn't.
  let lo = 0;
  let hi = value.rows.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(withRows(mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return withRows(lo) as T & { truncated: boolean };
}
