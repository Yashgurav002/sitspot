#!/usr/bin/env node
// Local replacement for the GitHub cron (.github/workflows/cron.yml): the laptop doesn't depend on GitHub reaching it.
//   :05 every hour  POST /cron/pull
//   :15 every hour  ml/tabpfn forecast_job.py --api (skipped if ml/tabpfn/.venv is missing)
// Also pulls once at startup. `--once`: pull + forecast now, then exit.
// Env: SITSPOT_API_URL (default http://localhost:$API_PORT), CRON_SECRET (else read from the root .env).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dotenv = existsSync(join(ROOT, ".env")) ? parseEnv(readFileSync(join(ROOT, ".env"), "utf8")) : {};
const API = (process.env.SITSPOT_API_URL || `http://localhost:${process.env.API_PORT || dotenv.API_PORT || 8787}`).replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET || dotenv.CRON_SECRET;
const TABPFN = join(ROOT, "ml", "tabpfn");
const PY = join(TABPFN, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
const log = (m) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

if (!SECRET) {
  console.error("CRON_SECRET not set (env or root .env); hourly cron disabled.");
  process.exit(0);
}

async function pull() {
  try {
    const r = await fetch(`${API}/cron/pull`, { method: "POST", headers: { "x-cron-secret": SECRET } });
    log(`pull ${r.status} ${(await r.text()).slice(0, 300)}`);
  } catch (e) {
    log(`pull failed: ${e.message}`);
  }
}

let forecasting = null;
function forecast() {
  if (!existsSync(PY)) return log(`forecast skipped: no ${PY} (see docs/setup.md step 8)`), Promise.resolve();
  if (forecasting) return log("forecast still running; skipped"), forecasting;
  log("forecast start");
  const child = spawn(PY, ["forecast_job.py", "--api", API], { cwd: TABPFN, stdio: "inherit", env: { ...process.env, CRON_SECRET: SECRET } });
  forecasting = new Promise((r) => {
    child.on("error", (e) => (log(`forecast failed: ${e.message}`), r()));
    child.on("exit", (code) => (log(`forecast exit ${code}`), r()));
  }).finally(() => (forecasting = null));
  return forecasting;
}

if (process.argv.includes("--once")) {
  await pull();
  await forecast();
  process.exit(0);
}

log(`hourly cron against ${API}: pull at :05, forecast at :15`);
await pull();
let last = -1;
setInterval(() => {
  const d = new Date();
  const m = d.getMinutes();
  if (m === last) return;
  last = m;
  if (m === 5) pull();
  if (m === 15) forecast();
}, 20_000);
