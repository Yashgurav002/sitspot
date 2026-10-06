import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

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
