import { serve } from "@hono/node-server";
import { createDb, ensureUser, migrate } from "@sitspot/db";
import { adminEmail, createApp, DEMO_EMAIL } from "./app";

// Load the repo-root .env if present (does not override vars already set).
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  /* no .env */
}

const db = await createDb();
await migrate(db);
await ensureUser(db, adminEmail(process.env));
await ensureUser(db, DEMO_EMAIL);

const app = createApp({ db, env: process.env });
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`sitspot api on http://localhost:${port} (db: ${db.kind})`);
