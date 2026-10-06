import { beforeEach, describe, expect, it } from "vitest";
import * as q from "@sitspot/db";
import { createDb, migrate, type Db } from "@sitspot/db";
import type { Llm, Message } from "@sitspot/llm";
import type { PickDTO } from "@sitspot/workflows";
import { createActivities } from "../src/activities";

const NOW = new Date("2026-10-06T06:00:00Z"); // 11:30 IST
const WS = new Date("2026-10-06T07:30:00Z"); // 13:00 IST
const LOW = new Date("2026-10-06T08:30:00Z"); // 14:00 IST
const H = 3_600_000;

/** An LLM that is always down; records what it was asked. */
function brokenLlm(seen: Message[][] = []): Llm {
  const fail = async (m: Message[]) => {
    seen.push(m);
    throw new Error("model down");
  };
  return { model: "broken", chat: fail, json: fail, embed: fail, chatStream: fail } as unknown as Llm;
}

let db: Db;
let userId: string;
let spotId: string;
let delivered: string[];
const seen: Message[][] = [];
const pick = (): PickDTO => ({
  spot_id: spotId,
  window_start: WS.toISOString(),
  window_end: new Date(WS.getTime() + H).toISOString(),
  send_at: new Date(WS.getTime() - 25 * 60_000).toISOString(),
  score: 0.6,
  factors: { p_rich: 0.6, p_rich_model: "prior", comfort: 1, tide_fit: 1, light_bonus: 1, novelty: 1, availability: 1 },
  reason: "Low tide at 14:00.",
});
const acts = () =>
  createActivities({
    db, env: {}, now: () => NOW,
    llm: { script: brokenLlm(seen), note: brokenLlm() },
    deliver: async (inv) => {
      delivered.push(inv.id);
      return { channel: "push" };
    },
  });

beforeEach(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  delivered = [];
  seen.length = 0;
  userId = (await q.ensureUser(db, "me@test")).id;
  spotId = (await q.createSpot(db, userId, { name: "Vasai creek", kind: "coastal", lat: 19.37, lon: 72.81, travel_min: 15 })).id;
  // Semidiurnal tide with its low at LOW; the model's heights are not trustworthy, only the timing.
  const rows = [];
  for (let h = -14; h <= 14; h++) {
    const time = new Date(LOW.getTime() + h * H);
    rows.push({
      time, spot_id: spotId, temp_c: 29, apparent_c: 31, rh_pct: 60, wind_ms: 3, precip_mm: 0, cloud_pct: 20,
      pm25: 20, pm10: 40, us_aqi: 62, tide_m: 2 - 1.6 * Math.cos((2 * Math.PI * h) / 12.4), is_forecast: true,
    });
  }
  await q.upsertConditions(db, rows);
  await q.upsertSightings(db, [{
    time: new Date(NOW.getTime() - 5 * H), checklist_id: "S1", loc_id: "L1", lat: 19.371, lon: 72.811,
    species_code: "litegr", common_name: "Little Egret", how_many: 4,
  }]);
});

describe("activities", () => {
  it("createInvitation is idempotent on (user, spot, window_start)", async () => {
    const a = acts();
    const first = await a.createInvitation(userId, pick(), "inv-wf");
    const second = await a.createInvitation(userId, pick(), "inv-wf");
    expect(first.created).toBe(true);
    expect(second).toEqual({ invitationId: first.invitationId, created: false });
    expect(await q.listInvitations(db, userId)).toHaveLength(1);
    expect((await q.getInvitation(db, first.invitationId))?.workflow_id).toBe("inv-wf");
  });

  it("composeScript: tide time + trend but no tide height; template fallback when the LLM throws", async () => {
    const a = acts();
    const { invitationId } = await a.createInvitation(userId, pick(), "inv-wf");
    const r = await a.composeScript(invitationId);

    const context = seen[0]!.map((m) => m.content).join("\n");
    expect(context).toMatch(/low tide 14:00, falling/);
    expect(context).not.toMatch(/\d m\)/); // no "(0.4 m)"
    expect(context).toContain("Little Egret ×4");
    expect(context).toMatch(/firm ground/i);

    expect(r.fallback).toBe(true);
    expect(r.script).toMatch(/Want to go\?$/);
    expect(r.script).toMatch(/low tide is at 14:00 and it's falling/i);
    expect(r.script).toMatch(/Stay on firm ground/);
    const inv = await q.getInvitation(db, invitationId);
    expect(inv?.script).toBe(r.script);
    const runs = await db.query<{ kind: string; model: string }>(`select kind, model from agent_runs where invitation_id = $1`, [invitationId]);
    expect(runs).toEqual([{ kind: "script", model: "template" }]);
  });

  it("deliver marks sent once and never re-delivers", async () => {
    const a = acts();
    const { invitationId } = await a.createInvitation(userId, pick(), "inv-wf");
    await a.composeScript(invitationId);
    await a.deliver(invitationId);
    await a.deliver(invitationId);
    expect(delivered).toEqual([invitationId]);
    const inv = await q.getInvitation(db, invitationId);
    expect([inv?.status, inv?.channel]).toEqual(["sent", "push"]);
  });

  it("recheckWindow passes for a still-good window despite its own open invitation", async () => {
    const a = acts();
    const { invitationId } = await a.createInvitation(userId, pick(), "inv-wf");
    await q.upsertForecasts(db, [{ time: WS, spot_id: spotId, p_rich: 0.9, model_version: "tabpfn-test" }]);
    const r = await a.recheckWindow(invitationId);
    // Coastal at 13:00 IST: daylight, highs ~5 h away → safe; 0.9 × comfort 0.875 × near-low 0.6 ≈ 0.47 ≥ 0.35 × 0.8.
    expect(r.ok, r.reason).toBe(true);
    await q.setInvitationStatus(db, invitationId, "declined");
    expect((await a.recheckWindow(invitationId)).ok).toBe(false);
  });

  it("compileVisit writes one field note from detections (template on LLM failure)", async () => {
    const a = acts();
    const { invitationId } = await a.createInvitation(userId, pick(), "inv-wf");
    const visit = await q.createVisit(db, invitationId);
    const t0 = new Date(visit.arrived_at);
    await q.insertDetections(db, visit.id, [
      { time: new Date(t0.getTime() + 60_000), species_code: "litegr", common_name: "Little Egret", confidence: 0.9, model_version: "birdnet" },
      { time: new Date(t0.getTime() + 120_000), species_code: "litegr", common_name: "Little Egret", confidence: 0.7, model_version: "birdnet" },
    ]);
    await q.endVisit(db, visit.id, 5);

    const { noteId } = await a.compileVisit(invitationId);
    expect(noteId).toBeTruthy();
    const notes = await q.getNotes(db, userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toMatch(/Vasai creek.*Heard 2 Little Egrets/);
    expect(notes[0]!.model).toBe("template");
    expect(notes[0]!.facts.invitation_id).toBe(invitationId);

    expect(await a.compileVisit(invitationId)).toEqual({ noteId }); // retry-safe
    expect(await q.getNotes(db, userId)).toHaveLength(1);
  });
});
