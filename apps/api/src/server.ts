import { serve } from "@hono/node-server";
import { createDb, ensureUser, migrate } from "@sitspot/db";
import { llmFromEnv } from "@sitspot/llm";
import { adminEmail, createApp, DEMO_EMAIL } from "./app";
import { createDeliver } from "./delivery";
import { startTemporal } from "./temporal";

// Load the repo-root .env if present (does not override vars already set).
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  /* no .env */
}

const env = process.env;
const db = await createDb();
await migrate(db);
await ensureUser(db, adminEmail(env));
await ensureUser(db, DEMO_EMAIL);

// Worker runs in-process (free hosting has no background workers). Null when Temporal is unreachable.
const temporal = await startTemporal({ db, env, deliver: createDeliver({ db, env }) });

const embedder = llmFromEnv("embed", env);
const app = createApp({
  db,
  env,
  signals: temporal?.signals,
  temporalHealth: temporal ? () => temporal.health() : undefined,
  embed: async (text) => (await embedder.embed([text]))[0]!,
});

const port = Number(env.PORT ?? env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`sitspot api on http://localhost:${port} (db: ${db.kind}, temporal: ${temporal ? "on" : "off"})`);

const stop = async () => {
  await temporal?.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// scripts/start.mjs closes our stdin to ask for a clean stop (on Windows a parent can't send SIGINT), so PGlite closes cleanly.
if (env.SITSPOT_STOP_ON_STDIN_END === "1") process.stdin.on("end", stop).resume();
