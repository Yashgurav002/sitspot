import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

// /api/* -> the Hono API is a Route Handler (app/api/[...path]/route.ts), not a rewrite: it must add headers
// (ngrok-skip-browser-warning, x-forwarded-*) and read API_INTERNAL_URL at runtime (Vercel or laptop).
const nextConfig: NextConfig = {
  transpilePackages: ["@sitspot/shared"],
};

// Sentry's build plugin only when a DSN is set; source maps upload only when SENTRY_AUTH_TOKEN is also set.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
      widenClientFileUpload: true,
      telemetry: false,
      silent: !process.env.CI,
    })
  : nextConfig;
