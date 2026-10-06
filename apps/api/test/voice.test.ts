import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, createInvitation, createSpot, ensureUser, getInvitation, listPreferences, migrate, type Db } from "@sitspot/db";
import type { Llm } from "@sitspot/llm";
import type { Invitation } from "@sitspot/shared";
import { createApp } from "../src/app";
import { buildInvitationFacts } from "../src/voice/facts";

const NOW = new Date("2026-10-06T11:00:00Z"); // 16:30 IST
const ENV = { ADMIN_PASSCODE: "letmein", CRON_SECRET: "c", VOICE_SHARED_SECRET: "voice-s3cret", ELEVENLABS_WEBHOOK_SECRET: "wh-s3cret" };
const REPLY = "It stays good for a while. Bring water.";

let jsonValue: unknown = {};
const fakeLlm: Llm = {
  model: "fake-chat",
  chat: async () => ({ text: REPLY, usage: { tokens_in: 10, tokens_out: 8 }, latency_ms: 5, model: "fake-chat" }),
  chatStream: async function* () { yield REPLY; },
  json: async (_m, schema) => {
    const v = schema.safeParse(jsonValue);
    return v.success ? { ok: true, value: v.data, raw: JSON.stringify(jsonValue), usage: null, latency_ms: 1 } : { ok: false, error: "bad", raw: "" };
  },
  embed: async () => [],
};

let db: Db;
let app: ReturnType<typeof createApp>;
let inv: Invitation;
const signals: string[] = [];

beforeEach(async () => {
  signals.length = 0;
  jsonValue = {};
  db = await createDb({ memory: true });
  await migrate(db);
  const me = await ensureUser(db, "me@sitspot.local");
  const spot = await createSpot(db, me.id, { name: "Terrace", kind: "home", lat: 19.38, lon: 72.82, travel_min: 0 });
  inv = await createInvitation(db, {
    user_id: me.id, spot_id: spot.id, window_start: new Date(NOW.getTime() + 15 * 60_000), window_end: new Date(NOW.getTime() + 75 * 60_000),
    score: 0.5, factors: { p_rich: 0.5, p_rich_model: "prior", comfort: 1, tide_fit: 1, light_bonus: 1, novelty: 1, availability: 1 },
    reason: "Nice.", status: "sent", script: "Terrace looks good right now. Want to go?",
  });
  app = createApp({ db, env: ENV, now: () => NOW, llm: fakeLlm, signals: { responded: (_i, a) => void signals.push(`responded:${a}`) } });
});

const llmReq = (body: unknown, secret = "voice-s3cret") =>
  app.request("/v1/voice/llm/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-voice-secret": secret }, body: JSON.stringify(body) });

/** Parse an SSE body into its data payloads. */
const sse = (text: string) => text.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));

describe("custom LLM endpoint", () => {
  it("rejects a bad secret with 401", async () => {
    expect((await llmReq({ messages: [] }, "nope")).status).toBe(401);
    const noHeader = await app.request("/v1/voice/llm/chat/completions", { method: "POST", body: "{}" });
    expect(noHeader.status).toBe(401);
  });

  it("streams valid OpenAI chunks ending in [DONE]", async () => {
    const res = await llmReq({
      stream: true,
      elevenlabs_extra_body: { invitation_id: inv.id },
      messages: [{ role: "system", content: "x" }, { role: "assistant", content: inv.script }, { role: "user", content: "How long will it be good?" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = sse(await res.text());
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    for (const c of chunks) {
      expect(c).toMatchObject({ object: "chat.completion.chunk", id: chunks[0].id, choices: [{ index: 0 }] });
      expect(c.choices[0].delta).toBeTypeOf("object");
    }
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe(REPLY);
    expect(signals).toEqual([]);
    const runs = await db.query<{ kind: string }>("select kind from agent_runs where invitation_id = $1 order by kind", [inv.id]);
    expect(runs.map((r) => r.kind)).toEqual(["chat", "intent"]);
  });

  it("'yes let's go' accepts the invitation and fires responded", async () => {
    const res = await llmReq({
      stream: true,
      elevenlabs_extra_body: { invitation_id: inv.id },
      messages: [{ role: "assistant", content: inv.script }, { role: "user", content: "yes let's go" }],
    });
    await res.text();
    expect((await getInvitation(db, inv.id))!.status).toBe("accepted");
    expect(signals).toEqual(["responded:true"]);
  });

  it("finds the invitation from the system prompt or falls back to the open one; saves preferences with the quote", async () => {
    jsonValue = { save_preference: { key: "avoid_hours", value: "morning", quote: "don't call me in the morning" } };
    const res = await llmReq({
      messages: [{ role: "system", content: `invitation_id: ${inv.id}` }, { role: "user", content: "please don't call me in the morning, I sleep late" }],
    });
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ object: "chat.completion", choices: [{ message: { role: "assistant", content: REPLY }, finish_reason: "stop" }] });
    const prefs = await listPreferences(db, inv.user_id);
    expect(prefs).toMatchObject([{ key: "avoid_hours", value: "morning", source_utterance: "don't call me in the morning" }]);

    // No user message yet (agent's opener) and no id at all → stored script of the open invitation.
    const opener = (await (await llmReq({ messages: [{ role: "system", content: "hi" }] })).json()) as any;
    expect(opener.choices[0].message.content).toBe(inv.script);
  });

  it("builds facts for the context block", async () => {
    const f = await buildInvitationFacts(db, inv.id, NOW);
    expect(f).toMatchObject({ spot: { name: "Terrace", kind: "home" }, window_end: new Date(inv.window_end) });
    expect(await buildInvitationFacts(db, "00000000-0000-0000-0000-000000000000", NOW)).toBeNull();
  });
});

describe("post-call webhook", () => {
  const sign = (raw: string, t = Math.floor(NOW.getTime() / 1000), secret = "wh-s3cret") =>
    `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
  const hook = (raw: string, sig: string) =>
    app.request("/v1/voice/webhooks/post-call", { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": sig }, body: raw });
  const payload = (transcript: unknown[]) => JSON.stringify({
    type: "post_call_transcription", event_timestamp: 1,
    data: { conversation_id: "conv_1", status: "done", transcript, metadata: { call_duration_secs: 30 },
      conversation_initiation_client_data: { dynamic_variables: { invitation_id: inv.id } } },
  });

  it("rejects a bad or stale signature with 401", async () => {
    const raw = payload([]);
    expect((await hook(raw, sign(raw, undefined, "wrong"))).status).toBe(401);
    expect((await hook(raw, sign(raw, Math.floor(NOW.getTime() / 1000) - 31 * 60))).status).toBe(401);
    expect((await hook(raw, "garbage")).status).toBe(401);
    expect((await hook(`${raw} `, sign(raw))).status).toBe(401); // body tampered
  });

  it("accepts a good signature, logs the call and records a missed yes from the transcript", async () => {
    const raw = payload([{ role: "agent", message: inv.script }, { role: "user", message: "Yeah, sounds good." }]);
    const res = await hook(raw, sign(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handled: true });
    expect((await getInvitation(db, inv.id))!.status).toBe("accepted");
    expect(signals).toEqual(["responded:true"]);
    const runs = await db.query<{ trace_id: string }>("select trace_id from agent_runs where kind = 'call'");
    expect(runs).toEqual([{ trace_id: "conv_1" }]);
  });
});
