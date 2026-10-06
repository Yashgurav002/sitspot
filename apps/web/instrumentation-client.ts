// Browser Sentry. No-op (no init, no network) unless NEXT_PUBLIC_SENTRY_DSN is set. No Session Replay:
// the visit page has a live mic and bird names on screen.
import * as Sentry from "@sentry/nextjs";
import { apiOrigin, SENTRY_DSN, sentryOptions } from "@/lib/sentry";

if (SENTRY_DSN) {
  Sentry.init({
    ...sentryOptions(),
    // web → API spans share a trace; the API must allow the sentry-trace and baggage headers in CORS.
    tracePropagationTargets: [apiOrigin()],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
