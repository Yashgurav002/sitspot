#!/usr/bin/env node
// Download the official BirdNET V2.4 TF.js models into apps/web/public/birdnet/ (skips files already there),
// plus the tfjs-backend-wasm binaries from node_modules. No deps; runs as apps/web `prebuild` (also on Vercel).
// Source: birdnet-team/BirdNET-Analyzer @ v1.5.1 (last tag that ships the TFJS export).
// Models are CC BY-NC-SA 4.0 (non-commercial). Usage: node ml/birdnet-web/fetch_model.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = "3f726d606d68ff0c99a7ddc9b0903fe19ad4f7aa"; // tag v1.5.1
const BASE = `https://raw.githubusercontent.com/birdnet-team/BirdNET-Analyzer/${COMMIT}`
  + "/birdnet_analyzer/checkpoints/V2.4/BirdNET_GLOBAL_6K_V2.4_Model_TFJS/static/model/";
const WEB = join(dirname(fileURLToPath(import.meta.url)), "../../apps/web");
const OUT = join(WEB, "public/birdnet");
const FILES = ["model.json", "labels.json", "mdata/model.json",
  ...Array.from({ length: 13 }, (_, i) => `group1-shard${i + 1}of13.bin`),
  ...Array.from({ length: 8 }, (_, i) => `mdata/group1-shard${i + 1}of8.bin`)];

const have = (p) => existsSync(p) && statSync(p).size > 0;

async function fetchOne(name) {
  const dest = join(OUT, name);
  if (have(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(BASE + name);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(dest + ".part", Buffer.from(await r.arrayBuffer()));
      renameSync(dest + ".part", dest);
      console.log("fetched", name);
      return;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${name}: ${e.message}`);
    }
  }
}

const queue = [...FILES];
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) await fetchOne(queue.shift()); }));

// tfjs-backend-wasm binaries (MIT/Apache) so the worker's WASM fallback can load them.
const WASM_SRC = join(WEB, "node_modules/@tensorflow/tfjs-backend-wasm/dist");
if (existsSync(WASM_SRC)) {
  mkdirSync(join(OUT, "wasm"), { recursive: true });
  for (const f of readdirSync(WASM_SRC)) if (f.endsWith(".wasm")) copyFileSync(join(WASM_SRC, f), join(OUT, "wasm", f));
} else console.warn("warn: run `pnpm install` first to get tfjs-backend-wasm binaries");

const size = FILES.reduce((s, f) => s + statSync(join(OUT, f)).size, 0);
console.log(`birdnet models ready: ${OUT} (${(size / 1e6).toFixed(1)} MB)`);
