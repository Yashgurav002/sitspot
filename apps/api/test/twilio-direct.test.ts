import { describe, expect, it } from "vitest";
import { createDb, migrate } from "@sitspot/db";
import { createApp } from "../src/app";
import { callToken, placeCall } from "../src/delivery";

const ENV = {
  ADMIN_PASSCODE: "x",
  VOICE_SHARED_SECRET: "voice-secret",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_ID: "agent_1",
  MY_PHONE_E164: "+919999999999",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_FROM_NUMBER: "+17372508034",
  PUBLIC_API_URL: "https://example.ngrok-free.dev/",
};

describe("Twilio-direct calls", () => {
  it("dials via Twilio REST with a Url pointing at our TwiML route", async () => {
    const calls: { url: string; body: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ sid: "CA1" }), { status: 201 });
    }) as typeof fetch;
    const r = await placeCall(ENV, { to: ENV.MY_PHONE_E164, invitationId: "inv1", script: "hi", fetch: f }, "TOKEN");
    expect(r.call_id).toBe("CA1");
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    const p = new URLSearchParams(calls[0]!.body);
    expect(p.get("From")).toBe("+17372508034");
    expect(p.get("Url")).toBe("https://example.ngrok-free.dev/v1/voice/twiml/TOKEN");
    expect(p.has("Twiml")).toBe(false); // trial accounts reject inline Twiml
  });

  it("TwiML route: 403 on a bad token, ElevenLabs TwiML on a valid one", async () => {
    const db = await createDb({ memory: true });
    await migrate(db);
    let registered: Record<string, unknown> | undefined;
    const f = (async (_url: string, init: RequestInit) => {
      registered = JSON.parse(String(init.body));
      return new Response('<?xml version="1.0"?><Response><Connect><Stream url="wss://x"/></Connect></Response>');
    }) as typeof fetch;
    const app = createApp({ db, env: ENV, fetch: f });
    expect((await app.request("/v1/voice/twiml/nope", { method: "POST" })).status).toBe(403);
    const ok = await app.request(`/v1/voice/twiml/${callToken("test", ENV.VOICE_SHARED_SECRET)}`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("xml");
    expect(await ok.text()).toContain("<Stream");
    expect(registered).toMatchObject({ agent_id: "agent_1", from_number: "+17372508034", direction: "outbound" });
    await db.close();
  });
});
