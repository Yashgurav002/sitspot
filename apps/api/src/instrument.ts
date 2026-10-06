// Loaded with `tsx --import ./src/instrument.ts` so Sentry is initialised before anything else
// (required for auto-instrumentation in ESM). No-op unless SENTRY_DSN_API is set.
import { execSync } from "node:child_process";
import * as Sentry from "@sentry/node";
import { setLlmTracer } from "@sitspot/llm";
import { llmTracer, sentryOptions } from "./observability";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  /* no .env */
}

const env = process.env;
if (env.SENTRY_DSN_API) {
  let release = env.SENTRY_RELEASE || env.RENDER_GIT_COMMIT || env.VERCEL_GIT_COMMIT_SHA;
  try {
    release ||= execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  Sentry.init(sentryOptions(env, release));
  setLlmTracer(llmTracer);
  console.log(`[sentry] on (env ${env.SENTRY_ENVIRONMENT || env.NODE_ENV || "development"}, release ${release ?? "none"})`);
}
