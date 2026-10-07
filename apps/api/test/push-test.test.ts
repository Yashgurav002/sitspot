import { describe, expect, it } from "vitest";
import { createDb, ensureUser, migrate } from "@sitspot/db";
import { createApp } from "../src/app";

const ENV = {
  ADMIN_PASSCODE: "letmein",
  VAPID_PUBLIC_KEY: "BPub",
  VAPID_PRIVATE_KEY: "priv",
  VAPID_SUBJECT: "mailto:test@example.com",
};

describe("POST /v1/push/test", () => {
  it("409 without a subscription, then sends once subscribed", async () => {
    const db = await createDb({ memory: true });
    await migrate(db);
    await ensureUser(db, "me@sitspot.local");
    const sent: string[] = [];
    const app = createApp({ db, env: ENV, push: async (_sub, payload) => void sent.push(String(payload)) });

    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "letmein" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const post = (path: string, body?: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

    expect((await post("/v1/push/test")).status).toBe(409);

    await post("/v1/push/subscribe", { endpoint: "https://push.example/abc", expirationTime: null, keys: { p256dh: "k", auth: "a" } });
    const res = await post("/v1/push/test");
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ title: "Sitspot", url: "/" });
    await db.close();
  });
});
