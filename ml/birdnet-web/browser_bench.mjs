// Run the real Web Worker (apps/web/lib/birdnet/worker.ts) in headless Chromium on a clip, per backend.
// Usage: node ml/birdnet-web/browser_bench.mjs <audio file> [backend ...]   (default: webgl wasm)
// Needs ffmpeg, the models from fetch_model.mjs, and Playwright's Chromium (pnpm exec playwright install chromium).
import { execFileSync, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const web = path.join(root, "apps/web");
const require = createRequire(path.join(web, "package.json"));
const { chromium } = require("@playwright/test");

const [clip, ...backends] = process.argv.slice(2);
if (!clip) throw new Error("usage: browser_bench.mjs <audio> [backend ...]");
const tmp = mkdtempSync(path.join(tmpdir(), "birdnet-"));
execSync(`npx esbuild lib/birdnet/worker.ts --bundle --format=iife --minify "--outfile=${path.join(tmp, "worker.js")}" --log-level=warning`, { cwd: web, stdio: "inherit" });
const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", clip, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });

const page = `<!doctype html><script>
window.run = async (backend) => {
  const pcm = new Float32Array(await (await fetch('/clip.f32')).arrayBuffer());
  const w = new Worker('/worker.js');
  const msg = () => new Promise((res) => (w.onmessage = (e) => res(e.data)));
  let t = performance.now();
  w.postMessage({ type: 'init', baseUrl: '/birdnet/', backends: [backend] });
  const ready = await msg();
  if (ready.type !== 'ready') return { error: ready.message };
  const load = performance.now() - t, out = [];
  for (let i = 0; (i + 1) * 144000 <= pcm.length; i++) {
    const s = pcm.slice(i * 144000, (i + 1) * 144000);
    t = performance.now();
    w.postMessage({ type: 'analyze', id: i, samples: s, topK: 3 }, [s.buffer]);
    const r = await msg();
    out.push({ ms: Math.round(performance.now() - t), top: r.preds?.map((p) => p.common_name + ' ' + p.confidence.toFixed(3)).join(' | ') ?? r.message });
  }
  w.terminate();
  return { backend: ready.backend, loadMs: Math.round(load), out };
};
</script>`;

const types = { ".json": "application/json", ".bin": "application/octet-stream", ".wasm": "application/wasm", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/") return res.end(page);
  if (u === "/clip.f32") return res.end(pcm);
  const f = u.startsWith("/birdnet/") ? path.join(web, "public", u) : path.join(tmp, u);
  if (!existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const b of backends.length ? backends : ["webgl", "wasm"]) {
  const p = await browser.newPage();
  p.on("console", (m) => m.type() === "error" && console.log("  console:", m.text()));
  await p.goto(url);
  const r = await p.evaluate((b) => window.run(b), b);
  console.log(`\n== requested ${b}:`, r.error ?? `backend=${r.backend} load+warmup ${r.loadMs} ms`);
  for (const [i, o] of (r.out ?? []).entries()) console.log(`  [${i * 3}-${i * 3 + 3}s] ${o.ms} ms  ${o.top}`);
  await p.close();
}
await browser.close();
server.close();
