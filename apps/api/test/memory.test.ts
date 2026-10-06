import { beforeEach, describe, expect, it } from "vitest";
import * as q from "@sitspot/db";
import { createDb, migrate, type Db } from "@sitspot/db";
import { createApp } from "../src/app";
import { createActivities } from "../src/activities";
import { buildRules, matchSpots, parsePreferenceValue, reflectForUser, reflectMath, type ReflectRow } from "../src/services/memory";

const ENV = { ADMIN_PASSCODE: "letmein", CRON_SECRET: "c" };
const WED = new Date("2026-10-07T06:00:00Z"); // Wed 11:30 IST
const SAT = new Date("2026-10-10T06:00:00Z"); // Sat 11:30 IST
const H = 3_600_000;
const QUOTE = "the creek is too far on weekdays";
const SPOTS = [{ id: "c", name: "Creek edge" }, { id: "p", name: "Terrace garden" }, { id: "m", name: "Mangrove creek" }];
const pref = (key: string, value: unknown, at: number, source_utterance = "said so") =>
  ({ key, value, source_utterance, created_at: new Date(at) });

let db: Db;
beforeEach(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
});

describe("preference values", () => {
  it("validates the keys policy reads, passes unknown keys through", () => {
    expect(parsePreferenceValue("spot_weekends_only", "Creek")).toEqual({ ok: true, value: { spot: "Creek" } });
    expect(parsePreferenceValue("spot_avoid", { spot: "park", enabled: false })).toEqual({ ok: true, value: { spot: "park", enabled: false } });
    expect(parsePreferenceValue("avoid_hours", { start: "06:00", end: "09:30" }).ok).toBe(true);
    for (const [k, v] of [
      ["spot_weekends_only", { spot: "" }], ["spot_weekends_only", 3], ["spot_avoid", { name: "park" }],
      ["avoid_hours", "morning"], ["avoid_hours", { start: "25:00", end: "09:00" }], ["avoid_hours", { start: "06:00" }],
      ["loves", ""], ["loves", 5],
    ] as const) expect(parsePreferenceValue(k, v).ok, `${k} ${JSON.stringify(v)}`).toBe(false);
    expect(parsePreferenceValue("avoid_rain", true)).toEqual({ ok: true, value: true });
  });

  it("matches spot names case-insensitively and fuzzily", () => {
    expect(matchSpots("the creek", SPOTS.slice(0, 2)).map((s) => s.id)).toEqual(["c"]);
    expect(matchSpots("CREEK EDGE", SPOTS).map((s) => s.id)).toEqual(["c"]);
    expect(matchSpots("creek", SPOTS).map((s) => s.id)).toEqual(["c", "m"]);
    expect(matchSpots("my terrace", SPOTS).map((s) => s.id)).toEqual(["p"]);
    expect(matchSpots("beach", SPOTS)).toEqual([]);
  });
});

describe("buildRules", () => {
  it("builds rules + quotes; latest per key+target wins; enabled:false removes; unknown keys ignored", () => {
    const r = buildRules([
      pref("spot_weekends_only", { spot: "creek edge" }, 1, QUOTE),
      pref("spot_avoid", { spot: "terrace" }, 2, "skip the terrace"),
      pref("avoid_hours", { start: "13:00", end: "15:00" }, 3, "lunch is busy"),
      pref("avoid_rain", true, 4),
      pref("loves", "kingfisher", 5),
      pref("spot_avoid", { spot: "Terrace", enabled: false }, 6, "terrace is fine again"),
      pref("avoid_hours", "garbage", 7),
    ], SPOTS);
    expect(r).toEqual({
      weekendsOnlySpotIds: ["c"], avoidSpotIds: [], avoidHours: [{ start: "13:00", end: "15:00" }],
      rule_notes: { "weekends_only:c": QUOTE, "avoid_hours:13:00-15:00": "lunch is busy" },
    });
    // Order is by created_at, not array order: the older "enabled:false" doesn't undo a newer rule.
    const r2 = buildRules([pref("spot_avoid", { spot: "terrace" }, 9), pref("spot_avoid", { spot: "terrace", enabled: false }, 1)], SPOTS);
    expect(r2.avoidSpotIds).toEqual(["p"]);
  });
});

describe("reflectMath", () => {
  const row = (status: string, istHour: number, rating: number | null = null): ReflectRow =>
    ({ status, window_start: new Date(Date.UTC(2026, 9, 5, istHour) - 5.5 * H), rating });
  it("invites more after a good fortnight, less after a bad one, nothing without signal", () => {
    const good = [row("completed", 7, 5), row("completed", 7, 4), row("accepted", 17), row("declined", 17)];
    expect(reflectMath(good, 0.35).threshold).toBe(0.3); // 75% accepted, mean rating 4.5
    expect(reflectMath([row("completed", 7), row("completed", 7)], 0.35).threshold).toBe(0.35); // no ratings: no -0.05
    expect(reflectMath([row("declined", 7), row("no_answer", 8), row("declined", 9), row("accepted", 9)], 0.35).threshold).toBe(0.4); // 25%
    expect(reflectMath([row("completed", 7, 2), row("completed", 7, 1)], 0.35).threshold).toBe(0.4); // poor ratings
    expect(reflectMath([row("pending", 7), row("cancelled", 8)], 0.35)).toMatchObject({ threshold: 0.35, rate: null, factors: {} });
  });
  it("clamps to 0.2..0.6", () => {
    expect(reflectMath([row("completed", 7, 5)], 0.2).threshold).toBe(0.2);
    expect(reflectMath([row("completed", 7, 5)], 0.22).threshold).toBe(0.2);
    expect(reflectMath([row("declined", 7)], 0.6).threshold).toBe(0.6);
    expect(reflectMath([row("declined", 7)], 0.58).threshold).toBe(0.6);
  });
  it("per-IST-hour accept factor with Laplace smoothing on 0.5..1.5", () => {
    const f = reflectMath([
      row("accepted", 7), row("completed", 7), row("missed", 7), // 3/3 -> (4/5) -> 1.3
      row("declined", 17), row("no_answer", 17), // 0/2 -> 1/4 -> 0.75
      row("accepted", 18), row("declined", 18), // 1/2 -> 2/4 -> 1.0
      row("pending", 20), // no signal
    ], 0.35).factors;
    expect(f).toEqual({ 7: 1.3, 17: 0.75, 18: 1 });
    // 23:30 IST is still hour 23 in IST even though it's 18:00 UTC.
    expect(Object.keys(reflectMath([row("accepted", 23)], 0.35).factors)).toEqual(["23"]);
  });
});

describe("reflect activity (PGlite)", () => {
  it("nudges threshold, stores accept factors that evaluate uses, logs agent_runs, idempotent per day", async () => {
    const me = await q.ensureUser(db, "me@sitspot.local"); // the passcode-login user
    const spot = await q.createSpot(db, me.id, { name: "Terrace", kind: "home", lat: 19.38, lon: 72.82, travel_min: 0 });
    const NIGHT = new Date("2026-10-06T18:31:00Z"); // 00:01 IST Wed
    const seed = async (status: string, daysAgo: number, istHour: number, rating?: number) => {
      const ws = new Date(Date.UTC(2026, 9, 6 - daysAgo, istHour) - 5.5 * H);
      const inv = await q.createInvitation(db, {
        user_id: me.id, spot_id: spot.id, window_start: ws, window_end: new Date(ws.getTime() + H), score: 0.5,
        factors: { p_rich: 0.5, p_rich_model: "prior", comfort: 1, tide_fit: 1, light_bonus: 1, novelty: 1, availability: 1 },
        reason: "x", status: status as never,
      });
      await db.query(`update invitations set created_at = $2 where id = $1`, [inv.id, new Date(ws.getTime() - H)]);
      if (rating) {
        const v = await q.createVisit(db, inv.id);
        await q.endVisit(db, v.id, rating);
      }
    };
    await seed("completed", 1, 13, 5);
    await seed("completed", 2, 13, 4);
    await seed("completed", 3, 13, 5);
    await seed("declined", 4, 17);
    await seed("declined", 20, 17); // outside the 14-day window
    const acts = createActivities({ db, env: {}, now: () => NIGHT, deliver: async () => ({ channel: "none" }) });
    await acts.reflect(me.id);
    expect((await q.getUser(db, me.id))!.threshold).toBeCloseTo(0.3); // 3/4 accepted, mean 4.67
    expect(await q.getAcceptFactors(db, me.id)).toEqual({ 13: 1.3, 17: 0.83 });
    const runs = await db.query<{ summary: any; trace_id: string }>(`select summary, trace_id from agent_runs where kind = 'reflect'`);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trace_id).toBe(`reflect:${me.id}:2026-10-06`);
    expect(runs[0]!.summary).toMatchObject({ day: "2026-10-06", invitations: 4, responded: 4, accepted: 3, accept_rate: 0.75, threshold_before: 0.35, threshold_after: 0.3 });

    // Retry / second run the same night: no second nudge, same summary.
    await acts.reflect(me.id);
    expect(await reflectForUser(db, me.id, new Date(NIGHT.getTime() + H))).toMatchObject({ threshold_after: 0.3 });
    expect((await q.getUser(db, me.id))!.threshold).toBeCloseTo(0.3);
    expect(await db.query(`select id from agent_runs where kind = 'reflect'`)).toHaveLength(1);

    // The learned 13:00 factor feeds availability in evaluate (13:00 IST window, Wed 11:30 IST now).
    const app = createApp({ db, env: ENV, now: () => WED });
    const { candidates } = await (await app.request("/v1/candidates", { headers: await cookieFor(app) })).json() as any;
    const at13 = candidates.find((c: any) => new Date(c.window_start).getTime() === Date.UTC(2026, 9, 7, 13) - 5.5 * H);
    expect(at13.factors.availability).toBeCloseTo(1.3);
  });
});

async function cookieFor(app: ReturnType<typeof createApp>) {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "letmein" }) });
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

describe("REST memory → /v1/candidates", () => {
  const call = async (app: ReturnType<typeof createApp>, path: string, body?: unknown, method?: string) => {
    const headers = { ...(await cookieFor(app)), "content-type": "application/json" };
    const res = await app.request(path, { method: method ?? (body ? "POST" : "GET"), headers, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text();
    return { status: res.status, json: (t ? JSON.parse(t) : null) as any };
  };

  it("rejects malformed values for known keys", async () => {
    const app = createApp({ db, env: ENV, now: () => WED });
    for (const [key, value] of [["spot_weekends_only", { spot: "" }], ["avoid_hours", "morning"], ["spot_avoid", 42]] as const) {
      const r = await call(app, "/v1/memory/preferences", { key, value, source_utterance: "something I said" });
      expect(r.status, key).toBe(400);
      expect(r.json.error ?? JSON.stringify(r.json)).toMatch(new RegExp(key));
    }
    expect((await call(app, "/v1/memory/preferences")).json).toEqual([]);
  });

  it("'the creek is too far on weekdays' → creek held on Wednesday with the quote, free on Saturday; DELETE undoes it", async () => {
    let now = WED;
    const app = createApp({ db, env: ENV, now: () => now });
    const creek = (await call(app, "/v1/spots", { name: "Creek edge", kind: "park", lat: 19.37, lon: 72.81, travel_min: 15 })).json;
    const terrace = (await call(app, "/v1/spots", { name: "Terrace", kind: "home", lat: 19.38, lon: 72.82 })).json;
    const p = await call(app, "/v1/memory/preferences", { key: "spot_weekends_only", value: { spot: "creek" }, source_utterance: QUOTE });
    expect(p.status).toBe(201);

    const wed = (await call(app, "/v1/candidates")).json;
    const wedCreek = wed.candidates.filter((c: any) => c.spot_id === creek.id);
    expect(wedCreek).toHaveLength(6);
    for (const c of wedCreek) {
      expect(c.factors.availability).toBe(0);
      expect(c.held).toBe(`weekends only (you said: "${QUOTE}")`);
      expect(c.reason).toContain(`you said: "${QUOTE}"`);
    }
    expect(wed.candidates.filter((c: any) => c.spot_id === terrace.id).every((c: any) => !c.held)).toBe(true);
    expect(wed.pick?.spot_id).not.toBe(creek.id);

    now = SAT;
    const sat = (await call(app, "/v1/candidates")).json;
    expect(sat.candidates.filter((c: any) => c.spot_id === creek.id).every((c: any) => !c.held && c.factors.availability > 0)).toBe(true);

    now = WED;
    expect((await call(app, `/v1/memory/preferences/${p.json.preference.id}`, undefined, "DELETE")).status).toBe(204);
    const after = (await call(app, "/v1/candidates")).json;
    expect(after.candidates.some((c: any) => c.held)).toBe(false);
  });
});
