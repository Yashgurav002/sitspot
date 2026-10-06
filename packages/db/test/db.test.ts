import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as q from "../src/index";
import type { Db } from "../src/index";

const factors = { p_rich: 0.6, p_rich_model: "tabpfn-v1", comfort: 0.8, tide_fit: 1, light_bonus: 0.1, novelty: 0.5, availability: 1 };
const emb = (hot: number) => Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0.01));

let db: Db;
let userId: string;
let spotId: string;

beforeAll(async () => {
  db = await q.createDb({ memory: true });
  await q.migrate(db);
  await q.migrate(db); // idempotent
  userId = (await q.ensureUser(db, "a@b.c")).id;
  spotId = (await q.createSpot(db, userId, { name: "Terrace", kind: "home", lat: 19.39, lon: 72.83, travel_min: 0 })).id;
}, 60_000);

afterAll(() => db.close());

describe("db", () => {
  it("uses pglite in memory", () => expect(db.kind).toBe("pglite"));

  it("users", async () => {
    const again = await q.ensureUser(db, "a@b.c");
    expect(again.id).toBe(userId);
    expect(again).toMatchObject({ quiet_start: "22:00:00", quiet_end: "07:00:00", threshold: 0.35, timezone: "Asia/Kolkata" });
    const u = await q.updateUserSettings(db, userId, { quiet_start: "23:00", threshold: 0.4 });
    expect(u).toMatchObject({ quiet_start: "23:00:00", quiet_end: "07:00:00", threshold: 0.4 });
    expect(await q.getUser(db, userId)).toEqual(u);
    expect(await q.getPushSubscription(db, userId)).toBeNull();
    const sub = { endpoint: "https://x", keys: { p256dh: "k", auth: "a" } };
    await q.setPushSubscription(db, userId, sub);
    expect(await q.getPushSubscription(db, userId)).toEqual(sub);
  });

  it("spots", async () => {
    const s = await q.getSpot(db, spotId);
    expect(s).toMatchObject({ name: "Terrace", kind: "home", lat: 19.39, lon: 72.83, travel_min: 0 });
    expect(s!.created_at).toBeInstanceOf(Date);
    const tmp = await q.createSpot(db, userId, { name: "Fort", kind: "heritage", lat: 19.33, lon: 72.81, travel_min: 20 });
    expect((await q.updateSpot(db, tmp.id, { name: "Vasai Fort" }))!).toMatchObject({ name: "Vasai Fort", travel_min: 20 });
    expect((await q.listSpots(db, userId)).map((x) => x.name)).toEqual(["Terrace", "Vasai Fort"]);
    expect((await q.listAllSpots(db)).length).toBe(2);
    expect(await q.deleteSpot(db, tmp.id)).toBe(true);
    expect(await q.getSpot(db, tmp.id)).toBeNull();
  });

  it("conditions upsert", async () => {
    const t = new Date("2026-10-07T01:00:00Z");
    const row = {
      time: t, spot_id: spotId, temp_c: 28.5, apparent_c: 31, rh_pct: 70, wind_ms: 2.5, precip_mm: 0,
      cloud_pct: 20, pm25: 30, pm10: 50, us_aqi: 80, tide_m: null, is_forecast: true,
    };
    await q.upsertConditions(db, [row]);
    await q.upsertConditions(db, [{ ...row, temp_c: 29 }]);
    const got = await q.getConditions(db, spotId, new Date("2026-10-07T00:00:00Z"), new Date("2026-10-07T02:00:00Z"));
    expect(got).toEqual([{ ...row, temp_c: 29 }]);
  });

  it("sightings near", async () => {
    const base = { checklist_id: "S1", species_code: "comkin", common_name: "Common Kingfisher", how_many: 1 };
    await q.upsertSightings(db, [
      { ...base, time: new Date("2026-10-05T02:00:00Z"), loc_id: "L1", lat: 19.4, lon: 72.84 }, // ~1.5 km
      { ...base, time: new Date("2026-10-05T02:00:00Z"), loc_id: "L2", lat: 18.9, lon: 72.8 }, // ~55 km
      { ...base, time: new Date("2026-09-01T02:00:00Z"), loc_id: "L1", lat: 19.4, lon: 72.84 }, // too old
    ]);
    const near = await q.recentSightingsNear(db, 19.39, 72.83, 10, new Date("2026-10-01T00:00:00Z"));
    expect(near.map((s) => s.loc_id)).toEqual(["L1"]);
    expect(near[0]!.time).toBeInstanceOf(Date);
  });

  it("forecasts latest per hour", async () => {
    const t = new Date("2026-10-07T01:00:00Z");
    await q.upsertForecasts(db, [{ time: t, spot_id: spotId, p_rich: 0.3, model_version: "baseline" }]);
    await new Promise((r) => setTimeout(r, 5));
    await q.upsertForecasts(db, [{ time: t, spot_id: spotId, p_rich: 0.7, model_version: "tabpfn-v1" }]);
    const f = await q.latestForecasts(db, spotId, new Date("2026-10-07T00:00:00Z"), new Date("2026-10-08T00:00:00Z"));
    expect(f).toEqual([{ time: t, spot_id: spotId, p_rich: 0.7, model_version: "tabpfn-v1" }]);
  });

  it("invitations, visits, detections, observations", async () => {
    const since = new Date(Date.now() - 60_000);
    const inv = await q.createInvitation(db, {
      user_id: userId, spot_id: spotId, window_start: new Date("2026-10-07T01:00:00Z"),
      window_end: new Date("2026-10-07T02:00:00Z"), score: 0.62, factors, reason: "Kingfishers likely.",
    });
    expect(inv).toMatchObject({ status: "pending", channel: "call", score: 0.62, factors, script: null, responded_at: null });
    expect(await q.getInvitation(db, inv.id)).toEqual(inv);
    expect((await q.openInvitation(db, userId))!.id).toBe(inv.id);
    expect(await q.countInvitationsSince(db, userId, since)).toBe(1);

    const now = new Date();
    const acc = await q.setInvitationStatus(db, inv.id, "accepted", { script: "hi", call_id: "c1", responded_at: now });
    expect(acc).toMatchObject({ status: "accepted", script: "hi", call_id: "c1", responded_at: now });
    expect((await q.listInvitations(db, userId, "accepted")).length).toBe(1);
    expect((await q.listInvitations(db, userId, "declined")).length).toBe(0);
    expect((await q.listInvitations(db, userId)).length).toBe(1);

    const visit = await q.createVisit(db, inv.id);
    expect(await q.getVisit(db, visit.id)).toEqual(visit);
    expect(await q.getVisitByInvitation(db, inv.id)).toEqual(visit);

    const det = [
      { time: new Date("2026-10-07T01:05:00Z"), species_code: "comkin", common_name: "Common Kingfisher", confidence: 0.9, model_version: "birdnet-2.4" },
      { time: new Date("2026-10-07T01:06:00Z"), species_code: "commyn", common_name: null, confidence: 0.75, model_version: "birdnet-2.4" },
    ];
    expect(await q.insertDetections(db, visit.id, det)).toBe(2);
    expect(await q.insertDetections(db, visit.id, det)).toBe(0); // idempotent
    const ds = await q.listDetections(db, visit.id);
    expect(ds).toEqual(det.map((d) => ({ ...d, visit_id: visit.id })));

    const obs = await q.addObservation(db, { visit_id: visit.id, user_id: userId, text: "two kites", embedding: emb(1) });
    expect(await q.listObservations(db, visit.id)).toEqual([obs]);

    const ended = await q.endVisit(db, visit.id, 4);
    expect(ended).toMatchObject({ rating: 4, minutes: 0 });
    expect(ended!.ended_at).toBeInstanceOf(Date);

    await q.setInvitationStatus(db, inv.id, "completed");
    expect(await q.openInvitation(db, userId)).toBeNull();
    expect(await q.lastDeclineAt(db, userId)).toBeNull();
    const inv2 = await q.createInvitation(db, { ...inv, status: "sent" });
    const at = new Date();
    await q.setInvitationStatus(db, inv2.id, "declined", { responded_at: at });
    expect(await q.lastDeclineAt(db, userId)).toEqual(at);

    const runId = await q.logAgentRun(db, { invitation_id: inv.id, kind: "script", model: "qwen", tokens_in: 10, latency_ms: 50 });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("notes + hybrid search", async () => {
    // "kingfisher" keyword hits A and B; vector is closest to A and C. A wins on both lists.
    const a = await q.insertNote(db, { user_id: userId, date: "2026-10-05", body: "A kingfisher dove at the creek.", facts: { n: 1 }, model: "m", embedding: emb(0) });
    const b = await q.insertNote(db, { user_id: userId, date: "2026-10-06", body: "Kingfisher calls, far away, heavy rain.", facts: {}, model: "m", embedding: emb(500) });
    const c = await q.insertNote(db, { user_id: userId, date: "2026-10-06", body: "Quiet terrace, only crows.", facts: {}, model: "m", embedding: emb(0).map((x, i) => (i === 1 ? 0.5 : x)) });
    expect(a).toEqual({ id: a.id, user_id: userId, date: "2026-10-05", body: a.body, facts: { n: 1 }, model: "m" });
    expect((await q.getNotes(db, userId)).length).toBe(3);
    expect((await q.getNotes(db, userId, "2026-10-06")).map((n) => n.id).sort()).toEqual([b.id, c.id].sort());

    const hybrid = await q.searchNotes(db, userId, "kingfisher", emb(0));
    expect(hybrid[0]!.id).toBe(a.id);
    expect(hybrid.map((h) => h.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(typeof hybrid[0]!.rrf).toBe("number");

    const kwOnly = await q.searchNotes(db, userId, "kingfisher", null);
    expect(kwOnly.map((h) => h.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("preferences", async () => {
    await expect(q.addPreference(db, userId, { key: "loves", value: "kingfisher", source_utterance: "" })).rejects.toThrow();
    await expect(q.addPreference(db, userId, { key: "loves", value: "kingfisher", source_utterance: "   " })).rejects.toThrow();
    const p = await q.addPreference(db, userId, { key: "loves", value: ["kingfisher"], source_utterance: "I love kingfishers" });
    expect(p).toMatchObject({ key: "loves", value: ["kingfisher"], source_utterance: "I love kingfishers", user_id: userId });
    expect(await q.listPreferences(db, userId)).toEqual([p]);
    expect(await q.deletePreference(db, p.id)).toBe(true);
    expect(await q.listPreferences(db, userId)).toEqual([]);
  });
});
