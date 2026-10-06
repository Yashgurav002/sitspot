import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@sitspot/db";
import { createApp } from "../src/app";

const NOW = new Date("2026-10-06T06:00:00Z");
const ENV = { ADMIN_PASSCODE: "letmein", CRON_SECRET: "cron-s3cret", MCP_TOKEN: "mcp-t0ken" };
let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  app = createApp({ db, env: ENV, now: () => NOW });
});

let nextId = 1;
async function rpc(method: string, params: unknown, auth: Record<string, string>) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { res, json: (await res.json()) as any };
}

const bearer = { authorization: "Bearer mcp-t0ken" };

describe("/mcp", () => {
  it("401 without session or valid token; token ignored when MCP_TOKEN unset", async () => {
    expect((await rpc("tools/list", {}, {})).res.status).toBe(401);
    expect((await rpc("tools/list", {}, { authorization: "Bearer nope" })).res.status).toBe(401);
    app = createApp({ db, env: { ...ENV, MCP_TOKEN: undefined }, now: () => NOW });
    expect((await rpc("tools/list", {}, bearer)).res.status).toBe(401);
  });

  it("initialize, tools/list, list_spots via bearer (admin) and session cookie", async () => {
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "letmein" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const made = await app.request("/v1/spots", { method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Terrace", kind: "home", lat: 19.38, lon: 72.82 }) });
    expect(made.status).toBe(201);

    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, bearer);
    expect(init.res.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("sitspot");

    const list = await rpc("tools/list", {}, bearer);
    expect(list.json.result.tools.map((t: any) => t.name).sort()).toEqual(
      ["get_candidates", "get_conditions", "list_invitations", "list_spots", "search_notes"]);

    for (const auth of [bearer, { cookie }]) {
      const call = await rpc("tools/call", { name: "list_spots", arguments: {} }, auth);
      expect(JSON.parse(call.json.result.content[0].text).map((s: any) => s.name)).toEqual(["Terrace"]);
    }

    const bad = await rpc("tools/call", { name: "get_conditions", arguments: { spot_id: "not-a-uuid" } }, bearer);
    expect(bad.json.result?.isError ?? !!bad.json.error).toBe(true);
    const cands = await rpc("tools/call", { name: "get_candidates", arguments: {} }, bearer);
    expect(JSON.parse(cands.json.result.content[0].text)).toHaveProperty("candidates");
  });
});
