import { defineConfig } from "vitest/config";

// Temporal test server download + workflow bundling are slow on first run.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 300_000, fileParallelism: false } });
