// Upstream failures with fixed messages. No message carries a URL, a key or upstream response text,
// so a message or `err.name` is always safe to return to a client or write to a log.

export class GraphUnavailableError extends Error {
  override readonly name = 'GraphUnavailableError';
  constructor(readonly retryAfterSecs: number | null) { super('The citation graph service is temporarily unavailable.'); }
}

/**
 * `detail` is graph-api's body text for a 400: the SQL error the client needs to fix its query.
 * It is upstream text, so it is never written to a log; it holds no URL or key.
 */
export class GraphError extends Error {
  override readonly name = 'GraphError';
  constructor(readonly status: number, readonly detail: string | null = null) { super('The citation graph service returned an error.'); }
}

export class QueryTimeoutError extends Error {
  override readonly name = 'QueryTimeoutError';
  constructor() { super('The citation graph query took too long.'); }
}

export class OpenAlexBudgetExhausted extends Error {
  override readonly name = 'OpenAlexBudgetExhausted';
  constructor(readonly retryAfterSecs: number) { super('The OpenAlex request budget is used up for now.'); }
}

export class OpenAlexError extends Error {
  override readonly name = 'OpenAlexError';
  constructor(readonly status: number) { super('OpenAlex returned an error.'); }
}

export class BuildDeadlineError extends Error {
  override readonly name = 'BuildDeadlineError';
  constructor() { super('The citation graph is still building.'); }
}

/** Invalid title filter. The message is written by our own validator and is shown to the client. */
export class TitleFilterError extends Error {
  override readonly name = 'TitleFilterError';
  constructor(message: string) { super(message); }
}
