// Server/edge Sentry. No-op unless NEXT_PUBLIC_SENTRY_DSN is set.
import * as Sentry from "@sentry/nextjs";
import { SENTRY_DSN, sentryOptions } from "@/lib/sentry";

export function register() {
  if (SENTRY_DSN) Sentry.init(sentryOptions());
}

export const onRequestError = Sentry.captureRequestError;
