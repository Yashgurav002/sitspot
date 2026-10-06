import { beforeEach, describe, expect, it } from "vitest";
import { createDb, ensureUser, getPushSubscription, migrate, setPushSubscription, type Db } from "@sitspot/db";
import { createDeliver, type PushSender } from "../src/delivery";

const CALL_ENV = { ELEVENLABS_API_KEY: "k", ELEVENLABS_AGENT_ID: "agent_1", ELEVENLABS_PHONE_NUMBER_ID: "phnum_1", MY_PHONE_E164: "+919999999999" };
const PUSH_ENV = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:a@b.c" };
const SUB = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
const SCRIPT = "Terrace looks good right now. Leave by 17:00. Want to go?";

let db: Db;
let uid: string;
const inv = () => ({ id: "11111111-1111-1111-1111-111111111111", user_id: uid });
let pushed: { sub: unknown; payload: unknown }[];
const okPush: PushSender = async (sub, payload) => void pushed.push({ sub, payload: JSON.parse(payload) });

beforeEach(async () => {
  pushed = [];
  db = await createDb({ memory: true });
  await migrate(db);
  uid = (await ensureUser(db, "me@sitspot.local")).id;
  await setPushSubscription(db, uid, SUB);
});

describe("deliver", () => {
  it("places the ElevenLabs call when configured", async () => {
    let sent: any;
    const fetch = (async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return Response.json({ success: true, message: "ok", conversation_id: "conv_9", callSid: "CA1" });
    }) as unknown as typeof globalThis.fetch;
    const r = await createDeliver({ db, env: { ...CALL_ENV, ...PUSH_ENV }, fetch, push: okPush })(inv(), SCRIPT);
    expect(r).toEqual({ channel: "call", call_id: "conv_9" });
    expect(sent.url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
    expect(sent.headers).toMatchObject({ "xi-api-key": "k" });
    expect(sent.body).toMatchObject({
      agent_id: "agent_1", agent_phone_number_id: "phnum_1", to_number: "+919999999999",
      conversation_initiation_client_data: { dynamic_variables: { invitation_id: inv().id, script: SCRIPT } },
    });
    expect(pushed).toEqual([]);
  });

  it("falls back to push when the call fails", async () => {
    const fetch = (async () => Response.json({ success: false, message: "trial number not verified" }, { status: 400 })) as unknown as typeof globalThis.fetch;
    const r = await createDeliver({ db, env: { ...CALL_ENV, ...PUSH_ENV }, fetch, push: okPush })(inv(), SCRIPT);
    expect(r).toMatchObject({ channel: "push", call_error: expect.stringContaining("trial number not verified") });
    expect(pushed).toEqual([{ sub: SUB, payload: { title: "Sitspot", body: "Terrace looks good right now.", url: `/call/${inv().id}` } }]);
  });

  it("uses push when no call config; clears a gone (410) subscription", async () => {
    expect(await createDeliver({ db, env: PUSH_ENV, push: okPush })(inv(), SCRIPT)).toEqual({ channel: "push" });
    const gone: PushSender = async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); };
    expect((await createDeliver({ db, env: PUSH_ENV, push: gone })(inv(), SCRIPT)).channel).toBe("none");
    expect(await getPushSubscription(db, uid)).toBeNull();
  });

  it("returns 'none' with no config, never throws", async () => {
    expect(await createDeliver({ db, env: {}, push: okPush })(inv(), SCRIPT)).toMatchObject({ channel: "none" });
    const boom: PushSender = async () => { throw new Error("network down"); };
    expect(await createDeliver({ db, env: PUSH_ENV, push: boom })(inv(), SCRIPT)).toMatchObject({ channel: "none", error: expect.stringContaining("network down") });
    expect(pushed).toEqual([]);
  });
});
