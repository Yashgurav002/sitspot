import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCache } from "@sitspot/data";
import { createDb, createInvitation, ensureUser, migrate, type Db } from "@sitspot/db";
import { createApp, DEMO_EMAIL } from "../src/app";

const fx = (n: string) => readFileSync(new URL(`../../../packages/data/test/fixtures/${n}.json`, import.meta.url), "utf8");
const ROUTES: [string, string][] = [
  ["//api.open-meteo.com", fx("weather")],
  ["air-quality-api", fx("air")],
  ["marine-api", fx("marine_creek")],
  ["api.ebird.org", fx("ebird_recent")],
];
const fakeFetch = (async (url: string) => {
  const hit = ROUTES.find(([k]) => String(url).includes(k));
  return hit ? new Response(hit[1], { status: 200 }) : new Response("nope", { status: 500 });
}) as typeof fetch;

const NOW = new Date("2026-10-06T06:00:00Z"); // 11:30 IST, inside the fixtures' 48 h
const ENV = { ADMIN_PASSCODE: "letmein", CRON_SECRET: "cron-s3cret", EBIRD_API_KEY: "test-key" };
const CREEK = { name: "Vasai creek", kind: "coastal", lat: 19.37, lon: 72.81, travel_min: 15 };
const PARK = { name: "Terrace", kind: "home", lat: 19.38, lon: 72.82 };

let db: Db;
let app: ReturnType<typeof createApp>;
const signals: string[] = [];

beforeEach(async () => {
  clearCache();
  signals.length = 0;
  db = await createDb({ memory: true });
  await migrate(db);
  app = createApp({
    db, env: ENV, now: () => NOW, fetch: fakeFetch,
    signals: {
      responded: (i, a) => void signals.push(`responded:${a}`),
      arrived: () => void signals.push("arrived"),
      visitEnded: (_i, _v, r) => void signals.push(`ended:${r}`),
    },
  });
});

async function req(path: string, opts: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await app.request(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { res, json: (text ? JSON.parse(text) : null) as any };
}

async function login(): Promise<string> {
  const { res } = await req("/auth/login", { body: { passcode: "letmein" } });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const cron = { "x-cron-secret": "cron-s3cret" };

describe("health + auth", () => {
  it("health reports db up", async () => {
    const { json } = await req("/health");
    expect(json).toEqual({ ok: true, db: "up", llm: "missing", temporal: "disabled" });
  });

  it("bad passcode 401, good passcode sets httpOnly cookie, /v1/me works, logout clears", async () => {
    const wrong = await req("/auth/login", { body: { passcode: "nope" } });
    expect(wrong.res.status).toBe(401);
    expect(wrong.json).toEqual({ error: "Wrong passcode" });
    expect((await req("/auth/login", { body: {} })).res.status).toBe(400);
    expect((await req("/v1/me")).res.status).toBe(401);
    const { res } = await req("/auth/login", { body: { passcode: "letmein" } });
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toMatch(/sitspot_session=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const cookie = sc.split(";")[0]!;
    const me = await req("/v1/me", { cookie });
    expect(me.json.user.email).toBe("me@sitspot.local");
    expect(me.json.demo).toBe(false);
    expect((await req("/v1/me", { cookie: cookie.slice(0, -2) + "xx" })).res.status).toBe(401);
    const patched = await req("/v1/me", { method: "PATCH", cookie, body: { quiet_start: "21:30", threshold: 0.4 } });
    expect(patched.json.user.quiet_start).toBe("21:30:00");
    expect(patched.json.user.threshold).toBeCloseTo(0.4);
    expect((await req("/v1/me", { method: "PATCH", cookie, body: { quiet_end: "25:00" } })).res.status).toBe(400);
    const out = await req("/auth/logout", { method: "POST" });
    expect(out.res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("CORS echoes web origin with credentials; COOKIE_CROSS_SITE=1 gives SameSite=None; Secure", async () => {
    const pre = await app.request("/v1/spots", { method: "OPTIONS", headers: {
      origin: "http://localhost:3000", "access-control-request-method": "PATCH", "access-control-request-headers": "content-type" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    expect(pre.headers.get("access-control-allow-methods")).toMatch(/PATCH/);
    const x = createApp({ db, env: { ...ENV, COOKIE_CROSS_SITE: "1" } });
    const r = await x.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "letmein" }) });
    expect(r.headers.get("set-cookie")).toMatch(/SameSite=None/i);
    expect(r.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("demo session is read-only", async () => {
    const { res, json } = await req("/auth/demo", { method: "POST" });
    expect(json.demo).toBe(true);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await req("/v1/me", { cookie })).json).toMatchObject({ demo: true, user: { email: DEMO_EMAIL } });
    expect((await req("/v1/spots", { cookie })).res.status).toBe(200);
    const w = await req("/v1/spots", { cookie, body: PARK });
    expect(w.res.status).toBe(403);
    expect(w.json).toEqual({ error: "This is a read-only demo." });
    expect((await req("/v1/me", { method: "PATCH", cookie, body: { threshold: 0.1 } })).res.status).toBe(403);
  });
});

describe("spots", () => {
  it("CRUD, validation, 5-spot limit, cross-user 404", async () => {
    const cookie = await login();
    expect((await req("/v1/spots", { cookie, body: { ...PARK, kind: "beach" } })).res.status).toBe(400);
    expect((await req("/v1/spots", { cookie, body: "{not json" })).res.status).toBe(400);
    const created = await req("/v1/spots", { cookie, body: PARK });
    expect(created.res.status).toBe(201);
    const sid = created.json.id;
    expect(created.json.travel_min).toBe(10);
    const p = await req(`/v1/spots/${sid}`, { method: "PATCH", cookie, body: { name: "Roof" } });
    expect(p.json).toMatchObject({ name: "Roof", travel_min: 10, kind: "home" });
    for (let i = 0; i < 4; i++) expect((await req("/v1/spots", { cookie, body: PARK })).res.status).toBe(201);
    const sixth = await req("/v1/spots", { cookie, body: PARK });
    expect(sixth.res.status).toBe(400);
    expect(sixth.json.error).toMatch(/5/);
    expect((await req("/v1/spots", { cookie })).json).toHaveLength(5);

    // another user's spot is invisible
    const other = await ensureUser(db, "other@x");
    const theirs = (await db.query<{ id: string }>(
      `insert into spots (user_id, name, kind, lat, lon) values ($1,'x','park',1,1) returning id`, [other.id]))[0]!.id;
    expect((await req(`/v1/spots/${theirs}`, { method: "PATCH", cookie, body: { name: "mine" } })).res.status).toBe(404);
    expect((await req(`/v1/spots/${theirs}`, { method: "DELETE", cookie })).res.status).toBe(404);
    expect((await req(`/v1/spots/${theirs}/conditions`, { cookie })).res.status).toBe(404);
    expect((await req(`/v1/spots/not-a-uuid`, { method: "DELETE", cookie })).res.status).toBe(404);

    expect((await req(`/v1/spots/${sid}`, { method: "DELETE", cookie })).res.status).toBe(204);
    expect((await req("/v1/spots", { cookie })).json).toHaveLength(4);
  });
});

describe("cron + conditions + candidates", () => {
  it("/cron/pull needs the secret, fills conditions (tide for coastal), eBird at most daily", async () => {
    const cookie = await login();
    const creek = (await req("/v1/spots", { cookie, body: CREEK })).json;
    const park = (await req("/v1/spots", { cookie, body: PARK })).json;

    expect((await req("/cron/pull", { method: "POST" })).res.status).toBe(401);
    expect((await req("/cron/pull", { method: "POST", headers: { "x-cron-secret": "wrong" } })).res.status).toBe(401);
    const { json } = await req("/cron/pull", { method: "POST", headers: cron });
    expect(json).toMatchObject({ spots: 2, conditionRows: 96, errors: [] });
    expect(json.sightingRows).toBeGreaterThan(0);

    const creekRows = await db.query<{ tide_m: number | null }>(`select tide_m from conditions where spot_id = $1`, [creek.id]);
    expect(creekRows).toHaveLength(48);
    expect(creekRows.every((r) => typeof r.tide_m === "number")).toBe(true);
    const parkRows = await db.query<{ tide_m: number | null }>(`select tide_m from conditions where spot_id = $1`, [park.id]);
    expect(parkRows.every((r) => r.tide_m === null)).toBe(true);

    const again = await req("/cron/pull", { method: "POST", headers: cron });
    expect(again.json.sightingRows).toBe(0); // eBird skipped within 24 h
    expect(again.json.conditionRows).toBe(96);
  });

  it("/cron/* is 503 without CRON_SECRET", async () => {
    const a = createApp({ db, env: { ADMIN_PASSCODE: "x" } });
    expect((await a.request("/cron/pull", { method: "POST", headers: cron })).status).toBe(503);
  });

  it("conditions + candidates shape", async () => {
    const cookie = await login();
    const creek = (await req("/v1/spots", { cookie, body: CREEK })).json;
    await req("/v1/spots", { cookie, body: PARK });
    await req("/cron/pull", { method: "POST", headers: cron });

    const c = await req(`/v1/spots/${creek.id}/conditions?hours=6`, { cookie });
    expect(c.res.status).toBe(200);
    expect(c.json.conditions).toHaveLength(6);
    expect(c.json.conditions[0]).toMatchObject({ spot_id: creek.id, is_forecast: expect.any(Boolean) });
    expect(c.json.forecasts).toEqual([]);
    expect(Object.keys(c.json.sun).sort()).toEqual(["goldenHourEnd", "goldenHourStart", "sunrise", "sunset"]);
    expect(c.json.tide.trend).toMatch(/rising|falling/);
    expect(c.json.tide.next_low.time).toBeTruthy();
    expect(c.json.tide.next_high.time).toBeTruthy();

    const s = await req(`/v1/spots/${creek.id}/sightings?days=7`, { cookie });
    expect(Array.isArray(s.json.sightings)).toBe(true); // fixture is the eBird doc example (USA), so 0 nearby

    const k = await req("/v1/candidates", { cookie });
    expect(k.json.candidates).toHaveLength(12);
    for (const cand of k.json.candidates) {
      expect(Object.keys(cand.factors).sort()).toEqual(
        ["availability", "comfort", "light_bonus", "novelty", "p_rich", "p_rich_model", "tide_fit"]);
      expect(typeof cand.reason).toBe("string");
      expect(cand.spot_name).toBeTruthy();
    }
    const creekC = k.json.candidates.filter((x: any) => x.spot_id === creek.id);
    expect(creekC).toHaveLength(6);
    expect(creekC[0].reason).toMatch(/tide/);
    expect("pick" in k.json).toBe(true);
  });

  it("forecast-ingest stores forecasts and skips unknown spots", async () => {
    const cookie = await login();
    const park = (await req("/v1/spots", { cookie, body: PARK })).json;
    const rows = [
      { time: "2026-10-06T07:00:00Z", spot_id: park.id, p_rich: 0.9, model_version: "tabpfn-v1" },
      { time: "2026-10-06T07:00:00Z", spot_id: "00000000-0000-4000-8000-000000000000", p_rich: 0.5, model_version: "x" },
    ];
    expect((await req("/cron/forecast-ingest", { body: rows })).res.status).toBe(401);
    expect((await req("/cron/forecast-ingest", { body: [{ p_rich: 3 }], headers: cron })).res.status).toBe(400);
    const r = await req("/cron/forecast-ingest", { body: rows, headers: cron });
    expect(r.json).toEqual({ inserted: 1, skipped_unknown_spot: 1 });
    const c = await req(`/v1/spots/${park.id}/conditions`, { cookie });
    expect(c.json.forecasts).toEqual([expect.objectContaining({ p_rich: expect.closeTo(0.9, 5), model_version: "tabpfn-v1" })]);
  });
});

describe("invitation -> visit flow", () => {
  it("respond, arrive, detections (idempotent, bearer), observations, end", async () => {
    const cookie = await login();
    const park = (await req("/v1/spots", { cookie, body: PARK })).json;
    const me = (await req("/v1/me", { cookie })).json.user;
    const mk = () => createInvitation(db, {
      user_id: me.id, spot_id: park.id, window_start: NOW, window_end: new Date(NOW.getTime() + 3_600_000),
      score: 0.5, factors: { p_rich: 0.5, p_rich_model: "prior", comfort: 1, tide_fit: 1, light_bonus: 1, novelty: 1, availability: 1 },
      reason: "Nice.", status: "sent",
    });
    const inv = await mk();
    const other = await mk();

    const got = await req(`/v1/invitations/${inv.id}`, { cookie });
    expect(got.json).toMatchObject({ id: inv.id, spot_name: "Terrace", status: "sent" });
    expect((await req("/v1/invitations?status=sent", { cookie })).json).toHaveLength(2);
    expect((await req("/v1/invitations?status=bogus", { cookie })).res.status).toBe(400);

    expect((await req(`/v1/invitations/${inv.id}/respond`, { cookie, body: { accepted: "yes" } })).res.status).toBe(400);
    const r = await req(`/v1/invitations/${inv.id}/respond`, { cookie, body: { accepted: true } });
    expect(r.json.invitation.status).toBe("accepted");
    expect(r.json.invitation.responded_at).toBeTruthy();

    const a = await req(`/v1/visits/${inv.id}/arrive`, { cookie, method: "POST" });
    expect(a.res.status).toBe(201);
    const { visit, visit_token } = a.json;
    expect((await req(`/v1/invitations/${inv.id}`, { cookie })).json.status).toBe("arrived");
    const otherVisit = (await req(`/v1/visits/${other.id}/arrive`, { cookie, method: "POST" })).json;

    const dets = [
      { time: "2026-10-06T06:05:00Z", species_code: "comkin1", common_name: "Common Kingfisher", confidence: 0.81, model_version: "birdnet-2.4" },
      { time: "2026-10-06T06:06:00Z", species_code: "houcro1", common_name: "House Crow", confidence: 0.9, model_version: "birdnet-2.4" },
    ];
    const bearer = { authorization: `Bearer ${visit_token}` };
    expect((await req(`/v1/visits/${visit.id}/detections`, { body: dets })).res.status).toBe(401);
    const d1 = await req(`/v1/visits/${visit.id}/detections`, { body: dets, headers: bearer });
    expect(d1.json).toEqual({ inserted: 2, received: 2 });
    const d2 = await req(`/v1/visits/${visit.id}/detections`, { body: dets, headers: bearer });
    expect(d2.json).toEqual({ inserted: 0, received: 2 }); // idempotent
    expect((await req(`/v1/visits/${otherVisit.visit.id}/detections`, { body: dets, headers: bearer })).res.status).toBe(403);
    expect((await req(`/v1/visits/${visit.id}/detections`, { body: dets, headers: { authorization: "Bearer junk.junk" } })).res.status).toBe(401);
    expect((await req(`/v1/visits/${visit.id}/detections`, { body: [{ ...dets[0], audio: "AAAA" }], headers: bearer })).res.status).toBe(400);
    expect((await req(`/v1/visits/${visit.id}/detections`, { body: Array(201).fill(dets[0]), headers: bearer })).res.status).toBe(400);
    expect((await req(`/v1/visits/${visit.id}/detections`, { body: "x".repeat(70_000), headers: bearer })).res.status).toBe(413);
    // session works too
    expect((await req(`/v1/visits/${visit.id}/detections`, { body: dets, cookie })).json.inserted).toBe(0);

    expect((await req(`/v1/visits/${visit.id}/observations`, { cookie, body: { text: "  " } })).res.status).toBe(400);
    expect((await req(`/v1/visits/${visit.id}/observations`, { cookie, body: { text: "Egrets on the mudflat" } })).res.status).toBe(201);

    const e = await req(`/v1/visits/${visit.id}/end`, { cookie, body: { rating: 4 } });
    expect(e.json.visit).toMatchObject({ rating: 4 });
    expect(e.json.visit.ended_at).toBeTruthy();
    expect((await req(`/v1/invitations/${inv.id}`, { cookie })).json.status).toBe("completed");

    const v = await req(`/v1/visits/${visit.id}`, { cookie });
    expect(v.json.detections).toHaveLength(2);
    expect(v.json.observations[0].text).toBe("Egrets on the mudflat");
    expect(signals).toEqual(["responded:true", "arrived", "arrived", "ended:4"]); // second arrive = the other invitation

    // demo user cannot see it
    const demo = (await req("/auth/demo", { method: "POST" })).res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await req(`/v1/visits/${visit.id}`, { cookie: demo })).res.status).toBe(404);
    expect((await req(`/v1/visits/${visit.id}/detections`, { body: dets, cookie: demo })).res.status).toBe(403);
  });
});

describe("preferences, notes, push", () => {
  it("preferences require source_utterance; loves feed novelty", async () => {
    const cookie = await login();
    expect((await req("/v1/memory/preferences", { cookie, body: { key: "loves", value: "kingfisher" } })).res.status).toBe(400);
    expect((await req("/v1/memory/preferences", { cookie, body: { key: "loves", value: "kingfisher", source_utterance: " " } })).res.status).toBe(400);
    const p = await req("/v1/memory/preferences", { cookie, body: { key: "loves", value: ["Kingfisher"], source_utterance: "I love kingfishers" } });
    expect(p.res.status).toBe(201);
    expect((await req("/v1/memory/preferences", { cookie })).json).toHaveLength(1);

    const park = (await req("/v1/spots", { cookie, body: PARK })).json;
    await db.query(
      `insert into sightings (time, loc_id, lat, lon, species_code, common_name) values ($1,'L1',19.38,72.82,'comkin1','Common Kingfisher')`,
      [new Date(NOW.getTime() - 3_600_000)]);
    const k = await req("/v1/candidates", { cookie });
    const cand = k.json.candidates.find((x: any) => x.spot_id === park.id);
    expect(cand.factors.novelty).toBeCloseTo(1.15);

    expect((await req(`/v1/memory/preferences/${p.json.preference.id}`, { method: "DELETE", cookie })).res.status).toBe(204);
    expect((await req("/v1/memory/preferences", { cookie })).json).toHaveLength(0);
  });

  it("notes: by date, keyword search, failing embed falls back", async () => {
    const cookie = await login();
    const me = (await req("/v1/me", { cookie })).json.user;
    await db.query(`insert into field_notes (user_id, date, body, facts, model) values ($1,'2026-10-05','Egrets at the creek on a falling tide','{}','test')`, [me.id]);
    expect((await req("/v1/notes?date=2026-10-05", { cookie })).json).toHaveLength(1);
    expect((await req("/v1/notes?date=yesterday", { cookie })).res.status).toBe(400);
    const s = await req("/v1/notes/search?q=egrets", { cookie });
    expect(s.res.headers.get("x-search-mode")).toBe("keyword");
    expect(s.json[0]).toMatchObject({ date: "2026-10-05", body: expect.stringContaining("Egrets") });
    const a2 = createApp({ db, env: ENV, now: () => NOW, embed: async () => { throw new Error("down"); } });
    const r = await a2.request("/v1/notes/search?q=egrets", { headers: { cookie } });
    expect((await r.json()) as any).toHaveLength(1);
  });

  it("push subscribe + vapid key", async () => {
    const cookie = await login();
    expect((await req("/v1/push/vapid-public-key", { cookie })).json).toEqual({ key: null });
    expect((await req("/v1/push/subscribe", { cookie, body: { endpoint: "nope" } })).res.status).toBe(400);
    const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } };
    expect((await req("/v1/push/subscribe", { cookie, body: sub })).res.status).toBe(200);
  });
});
