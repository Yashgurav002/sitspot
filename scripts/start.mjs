#!/usr/bin/env node
// One-command local runner (laptop + tunnel hosting). No deps.
//   pnpm start                 Temporal -> API (:8787) -> web (next start :3000) -> hourly cron
//   pnpm start --build         rebuild the web app first (otherwise only when apps/web/.next is missing)
//   pnpm start --no-cron       skip scripts/hourly.mjs
//   pnpm start --no-web        API only (web hosted on Vercel)
//   pnpm start --tunnel        also run `ngrok http --url=$NGROK_DOMAIN <API_PORT>` (skipped if ngrok is not on PATH)
// Stop: Ctrl-C, or type q + Enter (reliable in Git Bash/mintty, where Ctrl-C may hard-kill children).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const WIN = process.platform === "win32";
// Read (not load) the root .env: loading it would leak e.g. NEXT_PUBLIC_API_URL into the web build. The API loads it itself.
const dotenv = existsSync(join(ROOT, ".env")) ? parseEnv(readFileSync(join(ROOT, ".env"), "utf8")) : {};
const API_PORT = process.env.PORT || process.env.API_PORT || dotenv.API_PORT || "8787";
const WEB_PORT = "3000";
// Target of the web app's /api proxy (read at runtime by app/api/[...path]/route.ts).
const API_INTERNAL_URL = process.env.API_INTERNAL_URL || `http://localhost:${API_PORT}`;
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || dotenv.NGROK_DOMAIN;
const TEMPORAL_DB = process.env.TEMPORAL_DB || ".temporal/temporal.db";
const TEMPORAL_BIN = process.env.TEMPORAL_BIN || join(process.env.LOCALAPPDATA ?? "", "Temp", "temporal-sdk-typescript-1.24.0.exe");

const children = new Map(); // name -> ChildProcess
let stopping = false;
const log = (msg) => console.log(`[start] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(name, cmd, argv, { stdin = "ignore", env = {}, shell = WIN } = {}) {
  const child = spawn(cmd, argv, { cwd: ROOT, shell, stdio: [stdin, "pipe", "pipe"], env: { ...process.env, ...env } });
  for (const s of [child.stdout, child.stderr]) createInterface({ input: s }).on("line", (l) => console.log(`[${name}] ${l}`));
  children.set(name, child);
  child.on("error", (e) => console.log(`[${name}] failed to start: ${e.message}`));
  child.on("exit", (code) => {
    children.delete(name);
    if (stopping) return;
    if (["temporal", "api", "web"].includes(name)) {
      log(`${name} exited (${code}); stopping everything`);
      stop(1);
    } else if (name !== "build") log(`${name} exited (${code}); continuing without it`);
  });
  return child;
}

const exited = (child) => new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once("exit", r)));

function portOpen(port) {
  return new Promise((r) => {
    const s = connect(Number(port), "127.0.0.1", () => (s.destroy(), r(true)));
    s.on("error", () => r(false));
  });
}

async function waitFor(what, check, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (stopping) throw new Error("stopping");
    if (await check().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const httpOk = (url) => async () => (await fetch(url)).ok;

function killTree(child) {
  if (child.exitCode !== null) return;
  if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  log("stopping...");
  for (const n of ["ngrok", "cron", "web", "build"]) if (children.has(n)) killTree(children.get(n));
  const api = children.get("api");
  if (api) {
    api.stdin?.end(); // server.ts closes Temporal + PGlite cleanly on stdin end
    await Promise.race([exited(api), sleep(15_000)]);
    if (children.has("api")) killTree(api);
  }
  if (children.has("temporal")) killTree(children.get("temporal"));
  await Promise.all([...children.values()].map((c) => Promise.race([exited(c), sleep(5000)])));
  log("stopped");
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
if (process.stdin.readable) createInterface({ input: process.stdin }).on("line", (l) => l.trim().toLowerCase() === "q" && stop(0));

try {
  // 1. Temporal dev server
  if (await portOpen(7233)) log("Temporal already listening on :7233, reusing it");
  else {
    if (!process.env.TEMPORAL_BIN && !existsSync(TEMPORAL_BIN)) {
      console.error(`[start] Temporal dev server not found at ${TEMPORAL_BIN}.
  Install the Temporal CLI (https://docs.temporal.io/cli#install, e.g. winget install Temporal.TemporalCLI)
  and run: TEMPORAL_BIN=temporal pnpm start   (or start "temporal server start-dev" yourself; :7233 is reused)`);
      process.exit(1);
    }
    mkdirSync(dirname(resolve(ROOT, TEMPORAL_DB)), { recursive: true });
    run("temporal", TEMPORAL_BIN, ["server", "start-dev", "--db-filename", TEMPORAL_DB], { shell: false });
    await waitFor("Temporal :7233", () => portOpen(7233), 60_000);
    log("Temporal up (UI http://localhost:8233)");
  }

  // 2. API (Temporal worker runs in-process)
  run("api", "pnpm", ["--filter", "@sitspot/api", "start"], { stdin: "pipe", env: { SITSPOT_STOP_ON_STDIN_END: "1" } });
  await waitFor("API /health", httpOk(`http://localhost:${API_PORT}/health`), 120_000);
  log(`API up on :${API_PORT}`);

  // 3. Web (production build)
  if (args.has("--no-web")) log("--no-web: not starting the web app");
  else if (args.has("--build") || !existsSync(join(ROOT, "apps/web/.next/BUILD_ID"))) {
    log("building web (pnpm --filter @sitspot/web build)...");
    const b = run("build", "pnpm", ["--filter", "@sitspot/web", "build"]);
    await exited(b);
    if (b.exitCode !== 0) throw new Error("web build failed");
  }
  if (!args.has("--no-web")) {
    run("web", "pnpm", ["--filter", "@sitspot/web", "exec", "next", "start", "-p", WEB_PORT], { env: { API_INTERNAL_URL } });
    await waitFor("web :3000", httpOk(`http://localhost:${WEB_PORT}/api/health`), 120_000);
  }

  // 4. Hourly cron (pull at :05, forecast at :15)
  if (!args.has("--no-cron")) run("cron", process.execPath, ["scripts/hourly.mjs"], { shell: false, env: { API_PORT } });

  // 5. Optional ngrok tunnel to the API (Vercel web + ElevenLabs reach the laptop through it)
  if (args.has("--tunnel")) {
    if (!NGROK_DOMAIN) log("--tunnel: NGROK_DOMAIN not set (env or root .env); skipping");
    else if (spawnSync("ngrok", ["version"], { shell: WIN, stdio: "ignore" }).status !== 0) log("--tunnel: ngrok not on PATH (https://ngrok.com/download); skipping");
    else {
      run("ngrok", "ngrok", ["http", `--url=${NGROK_DOMAIN}`, API_PORT, "--log=stdout"]);
      log(`tunnel: https://${NGROK_DOMAIN} -> API :${API_PORT}`);
    }
  }

  log(`ready: API http://localhost:${API_PORT}` + (args.has("--no-web") ? "" : `, web http://localhost:${WEB_PORT} (API at /api)`) + ". q + Enter or Ctrl-C to stop.");
} catch (e) {
  if (!stopping) {
    console.error(`[start] ${e.message}`);
    await stop(1);
  }
}
