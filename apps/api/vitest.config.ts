import { defineConfig } from "vitest/config";

// PGlite boot in beforeAll can exceed vitest's 10 s default on a busy laptop.
// One file at a time: parallel PGlite boots starve each other while the live server + Ollama run.
export default defineConfig({ test: { hookTimeout: 30_000, testTimeout: 30_000, fileParallelism: false } });
