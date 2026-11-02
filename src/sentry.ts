// Error reports to Sentry: unexpected tool and route failures, uncaught exceptions and unhandled
// rejections. Expected failures (bad input, rate limits, upstream outages) are never reported.
// Reports carry the error's type, message and stack trace, and nothing from the request: no tool
// arguments, headers, IPs or breadcrumbs (outbound OpenAlex and graph-api URLs hold search terms and
// paper IDs). URL query strings in messages are redacted. No tracing and no OpenTelemetry setup.

import * as Sentry from '@sentry/node';
import type { ErrorEvent, NodeOptions } from '@sentry/node';

/** Reports an unexpected error; `where` is a tool name or `route`. Callers guard it with try/catch. */
export type ReportError = (err: unknown, where: string) => void;

export type ErrorReporting = { report: ReportError; close: () => Promise<void> };

/** Waits this long for queued reports at shutdown, inside the pod's grace period. */
const CLOSE_TIMEOUT_MS = 2_000;

const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;

/** `https://host/path?x=1` -> `https://host/path?[redacted]`. */
export function redactUrlQueries(text: string): string {
  return text.replace(URL_QUERY, '$1?[redacted]');
}

/** The last word on what leaves the process: drops request context and redacts URL queries. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  if (event.message) event.message = redactUrlQueries(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactUrlQueries(ex.value);
  }
  return event;
}

/** `transport` is for tests only; production uses Sentry's HTTP transport. */
export function initErrorReporting(
  dsn: string, release: string, opts: { transport?: NodeOptions['transport'] } = {},
): ErrorReporting {
  Sentry.init({
    dsn,
    release,
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    maxBreadcrumbs: 0,
    beforeSend: scrubEvent,
    ...(opts.transport ? { transport: opts.transport } : {}),
  });
  return {
    report: (err, where) => { Sentry.captureException(err, { tags: { where } }); },
    close: async () => { await Sentry.close(CLOSE_TIMEOUT_MS).catch(() => false); },
  };
}
