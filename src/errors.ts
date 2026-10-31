// Upstream failures with fixed messages. No message carries a URL, a key or upstream response text,
// so a message or `err.name` is always safe to return to a client or write to a log.

export class GraphUnavailableError extends Error {
  override readonly name = 'GraphUnavailableError';
  constructor(readonly retryAfterSecs: number | null) { super('The citation graph service is temporarily unavailable.'); }
}

/**
 * `detail` is graph-api's body text for a 400: the SQL error the client needs to fix its query.
 * It echoes the user's SQL, so it is never logged. It sits behind a getter over a private field,
 * so `util.inspect`, `JSON.stringify` and spreads of the error don't show it.
 */
export class GraphError extends Error {
  override readonly name = 'GraphError';
  readonly #detail: string | null;
  constructor(readonly status: number, detail: string | null = null) {
    super('The citation graph service returned an error.');
    this.#detail = detail;
  }
  get detail(): string | null { return this.#detail; }
}

export class QueryTimeoutError extends Error {
  override readonly name = 'QueryTimeoutError';
  constructor() { super('The citation graph query took too long.'); }
}

export class OpenAlexBudgetExhausted extends Error {
  override readonly name = 'OpenAlexBudgetExhausted';
  constructor(readonly retryAfterSecs: number) { super('The OpenAlex request budget is used up for now.'); }
}

/** A 429 with budget left (or no budget header): OpenAlex's short per-second limit. */
export class OpenAlexRateLimited extends Error {
  override readonly name = 'OpenAlexRateLimited';
  constructor(readonly retryAfterSecs: number) { super('OpenAlex is rate limiting requests.'); }
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
