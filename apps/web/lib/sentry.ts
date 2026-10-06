// Sentry options shared by the browser (instrumentation-client.ts) and the Next server (instrumentation.ts).
// Only used when NEXT_PUBLIC_SENTRY_DSN is set. Same stance as apps/api/src/observability.ts: no PII, no query
// strings (note searches, coordinates), no bodies/headers/cookies, no console lines, no typed text, no replay.
import type * as Sentry from "@sentry/nextjs";

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

const noQuery = (u: unknown) => (typeof u === "string" ? u.split("?")[0] : u);
const URL_ATTRS = ["url.full", "http.url", "http.target", "url.path", "url"];

/** Origin of the API, for trace propagation (sentry-trace/baggage go to it and nowhere else).
 *  Same origin by default (/api proxy). */
export function apiOrigin(): string {
  const self = typeof location === "undefined" ? "http://localhost:3000" : location.origin;
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || self, self).origin;
  } catch {
    return self;
  }
}

export function sentryOptions(): Sentry.BrowserOptions & Sentry.NodeOptions {
  return {
    dsn: SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: 1.0, // hackathon: keep every trace
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      genAI: { inputs: false, outputs: false }, databaseQueryData: false, stackFrameVariables: false,
    },
    beforeSendSpan(span) {
      span.name = noQuery(span.name) as string;
      for (const k of URL_ATTRS) if (typeof span.attributes?.[k] === "string") span.attributes[k] = noQuery(span.attributes[k]);
      for (const k of ["url.query", "http.query"]) delete span.attributes?.[k];
      return span;
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.query_string;
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        event.request.url = noQuery(event.request.url) as string | undefined;
      }
      return event;
    },
    beforeBreadcrumb(b) {
      if (b.category === "console") return null; // log lines can carry species, notes or provider errors
      if (b.data?.url) b.data.url = noQuery(b.data.url);
      if (b.data?.from) b.data.from = noQuery(b.data.from);
      if (b.data?.to) b.data.to = noQuery(b.data.to);
      return b;
    },
  };
}
