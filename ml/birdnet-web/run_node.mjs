// Run the browser BirdNET model (same model.ts the Web Worker uses) on a real clip in Node, CPU backend.
// Usage: node ml/birdnet-web/run_node.mjs <audio file> [lat lon]
// Needs ffmpeg on PATH (decodes to 48 kHz mono f32) and models from fetch_model.py.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const M = await import(path.join(root, "apps/web/lib/birdnet/model.ts").replace(/\\/g, "/").replace(/^([A-Z]):/, "file:///$1:"));
const { parseLabels } = await import(path.join(root, "apps/web/lib/birdnet/labels.ts").replace(/\\/g, "/").replace(/^([A-Z]):/, "file:///$1:"));

const [clip, lat, lon] = process.argv.slice(2);
if (!clip) throw new Error("usage: run_node.mjs <audio> [lat lon]");

const pub = path.join(root, "apps/web/public/birdnet/");
const fetchFunc = async (url) => new Response(readFileSync(path.join(pub, url.replace("http://local/birdnet/", ""))));

const backend = await M.pickBackend([process.env.BACKEND ?? "wasm"]);
let t = performance.now();
const model = await M.loadAudioModel("http://local/birdnet/", { fetchFunc });
console.log(`backend=${backend} load+warmup ${((performance.now() - t) / 1000).toFixed(1)} s`);
const labels = parseLabels(JSON.parse(readFileSync(path.join(pub, "labels.json"), "utf8")));

let allowed = null;
if (lat) {
  const meta = await M.loadMetaModel("http://local/birdnet/", { fetchFunc });
  const week = M.birdnetWeek(new Date());
  const s = await M.metaScores(meta, +lat, +lon, week);
  allowed = new Set(labels.filter((_, i) => s[i] >= 0.03).map((l) => l.scientific_name));
  console.log(`location filter @${lat},${lon} week ${week}: ${allowed.size} species`);
}

const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", clip, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
const audio = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
const n = Math.floor(audio.length / M.WINDOW_SAMPLES);
console.log(`${path.basename(clip)}: ${(audio.length / 48000).toFixed(1)} s -> ${n} windows`);

const times = [];
const best = new Map(); // species -> max confidence over windows
for (let w = 0; w < n; w++) {
  const win = audio.slice(w * M.WINDOW_SAMPLES, (w + 1) * M.WINDOW_SAMPLES);
  t = performance.now();
  const probs = await M.predictWindow(model, win);
  times.push(performance.now() - t);
  const top = [...probs].map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).slice(0, 5);
  console.log(`  [${w * 3}-${w * 3 + 3}s] ` + top.map(([p, i]) => `${labels[i].common_name} ${p.toFixed(3)}`).join(" | "));
  probs.forEach((p, i) => { if (p > (best.get(i) ?? 0)) best.set(i, p); });
}
const top5 = [...best].filter(([i]) => !allowed || allowed.has(labels[i].scientific_name)).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`top-5 over clip${allowed ? " (location-filtered)" : ""}:`);
for (const [i, p] of top5) console.log(`  ${p.toFixed(3)}  ${labels[i].common_name} (${labels[i].scientific_name})`);
times.sort((a, b) => a - b);
console.log(`inference per 3-s window: median ${times[times.length >> 1].toFixed(0)} ms, max ${times.at(-1).toFixed(0)} ms (n=${n})`);
