import { describe, expect, it } from "vitest";
import { createDb, ensureUser, getInvitation, migrate } from "@sitspot/db";
import { createApp } from "../src/app";

const NOW = new Date("2026-10-09T06:30:00Z"); // 12:00 IST — outside default quiet hours

async function setup(startTestInvitation?: (id: string, end: Date) => Promise<string>) {
  const db = await createDb({ memory: true });
  await migrate(db);
  await ensureUser(db, "me@sitspot.local");
  const app = createApp({ db, env: { ADMIN_PASSCODE: "letmein" }, now: () => NOW, startTestInvitation });
  const login = await app.request("/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "letmein" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const post = (path: string, body?: unknown) =>
    app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { db, post };
}

describe("POST /v1/invitations/test", () => {
  it("503 when workflows aren't running", async () => {
    const { db, post } = await setup();
    expect((await post("/v1/invitations/test")).status).toBe(503);
    await db.close();
  });

  it("starts a TEST invitation for the best safe window", async () => {
    const started: string[] = [];
    const { db, post } = await setup(async (id) => (started.push(id), `test-${id}`));
    await post("/v1/spots", { name: "Ambadi Park", kind: "park", lat: 19.385, lon: 72.827, travel_min: 10 });
    const res = await post("/v1/invitations/test");
    expect(res.status).toBe(201);
    const { invitation_id } = (await res.json()) as { invitation_id: string };
    expect(started).toEqual([invitation_id]);
    const inv = (await getInvitation(db, invitation_id))!;
    expect(inv.reason.startsWith("TEST · ")).toBe(true);
    expect(inv.workflow_id).toBe(`test-${invitation_id}`);
    await db.close();
  });
});
