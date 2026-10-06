// Temporal activity implementations (interface: workflows/src/activities-types.ts). All DB writes for
// workflow state happen here. Validation errors are non-retryable; everything else retries (3×).
import { ApplicationFailure } from "@temporalio/activity";
import { composeScript, fmtDate, writeNote, type DayFacts, type InvitationFacts, type Numbers } from "@sitspot/agent";
import { sunTimes, tideTrend } from "@sitspot/data";
import * as q from "@sitspot/db";
import type { Db } from "@sitspot/db";
import { llmFromEnv, type Llm } from "@sitspot/llm";
import { CONFIG, evaluateWindows } from "@sitspot/policy";
import type { Candidate, Factors, Invitation } from "@sitspot/shared";
import type { Activities, PickDTO } from "@sitspot/workflows";
import { buildEvaluateInput, evaluateForUser, istMidnight, tideEvents } from "./services/evaluate";

const HOUR = 3_600_000;
const SIGHTING_KM = 3; // the context block says "≤3 km"
const RECHECK_SLACK = 0.8; // fresh score may drop to 80% of the threshold and still go out

export type Deliver = (inv: Invitation, script: string) => Promise<{ channel: "call" | "push" | "none"; call_id?: string }>;

export type ActivityDeps = {
  db: Db;
  env: Record<string, string | undefined>;
  now?: () => Date;
  llm?: { script?: Llm; note?: Llm };
  deliver: Deliver;
};

const invalid = (msg: string) => ApplicationFailure.nonRetryable(msg, "ValidationError");

const toDTO = (c: Candidate): PickDTO => ({
  spot_id: c.spot_id,
  window_start: c.window_start.toISOString(),
  window_end: c.window_end.toISOString(),
  send_at: c.send_at.toISOString(),
  score: c.score,
  factors: c.factors,
  reason: c.reason,
});

export function createActivities(deps: ActivityDeps): Activities {
  const { db, env } = deps;
  const now = deps.now ?? (() => new Date());
  const scriptLlm = () => deps.llm?.script ?? llmFromEnv("script", env);
  const noteLlm = () => deps.llm?.note ?? llmFromEnv("note", env);

  const mustInv = async (id: string) => {
    const inv = await q.getInvitation(db, id);
    if (!inv) throw invalid(`invitation ${id} not found`);
    return inv;
  };
  const mustSpot = async (id: string) => {
    const spot = await q.getSpot(db, id);
    if (!spot) throw invalid(`spot ${id} not found`);
    return spot;
  };

  /** Facts for the call script. Tide: low TIME + trend only — the Open-Meteo tide model is good for timing, not height. */
  async function invitationFacts(inv: Invitation): Promise<InvitationFacts> {
    const spot = await mustSpot(inv.spot_id);
    const t = now();
    const ws = new Date(inv.window_start);
    const cond = (await q.getConditions(db, spot.id, new Date(ws.getTime() - HOUR), new Date(ws.getTime() + HOUR)))
      .sort((a, b) => Math.abs(+a.time - +ws) - Math.abs(+b.time - +ws))[0];
    const numbers: Numbers = {};
    const apparent = cond?.apparent_c ?? cond?.temp_c;
    if (apparent != null) numbers.apparent_c = apparent;
    if (cond?.us_aqi != null) numbers.us_aqi = cond.us_aqi;
    if (cond?.wind_ms != null) numbers.wind_ms = cond.wind_ms;
    const sun = sunTimes(ws, spot.lat, spot.lon);
    numbers.sunset = sun.sunset;
    if (inv.factors.light_bonus > 1) numbers.golden_start = sun.goldenHourStart;
    if (spot.kind === "coastal") {
      const series = await q.getConditions(db, spot.id, new Date(ws.getTime() - 12 * HOUR), new Date(ws.getTime() + 12 * HOUR));
      const mid = ws.getTime() + (new Date(inv.window_end).getTime() - ws.getTime()) / 2;
      const low = tideEvents(series).lows.sort((a, b) => Math.abs(+a.time - mid) - Math.abs(+b.time - mid))[0];
      const trend = tideTrend(series, ws);
      if (low || trend) numbers.tide = { ...(low && { low_time: low.time }), ...(trend && { trend }) };
    }

    const bySpecies = new Map<string, { common_name: string; count: number; when: Date }>();
    for (const s of await q.recentSightingsNear(db, spot.lat, spot.lon, SIGHTING_KM, new Date(t.getTime() - 48 * HOUR))) {
      const name = s.common_name ?? s.species_code;
      const e = bySpecies.get(name) ?? { common_name: name, count: 0, when: s.time };
      e.count += s.how_many ?? 1;
      if (s.time > e.when) e.when = s.time;
      bySpecies.set(name, e);
    }

    return {
      now: t,
      spot: { name: spot.name, kind: spot.kind, travel_min: spot.travel_min },
      window_start: ws,
      window_end: new Date(inv.window_end),
      leave_by: new Date(ws.getTime() - spot.travel_min * 60_000),
      factors: inv.factors as Factors,
      numbers,
      sightings: [...bySpecies.values()].sort((a, b) => b.count - a.count).slice(0, 8),
      preferences: (await q.listPreferences(db, inv.user_id)).map((p) => ({ key: p.key, value: p.value, quote: p.source_utterance })),
      notes: [],
      ...(spot.kind === "coastal" && { safety_line: CONFIG.coastalSafetyLine }),
    };
  }

  return {
    async evaluateWindows(userId) {
      const { pick } = await evaluateForUser(db, userId, now());
      return pick ? toDTO(pick) : null;
    },

    async createInvitation(userId, pick, workflowId) {
      // ponytail: select-then-insert (one UserDayWorkflow per user is the only writer); a unique
      // index on (user_id, spot_id, window_start) would make it race-proof.
      const existing = await db.query<{ id: string }>(
        `select id from invitations where user_id = $1 and spot_id = $2 and window_start = $3 limit 1`,
        [userId, pick.spot_id, new Date(pick.window_start)],
      );
      if (existing[0]) return { invitationId: existing[0].id, created: false };
      const inv = await q.createInvitation(db, {
        user_id: userId,
        spot_id: pick.spot_id,
        window_start: new Date(pick.window_start),
        window_end: new Date(pick.window_end),
        score: pick.score,
        factors: pick.factors as Factors,
        reason: pick.reason,
        workflow_id: workflowId,
      });
      return { invitationId: inv.id, created: true };
    },

    async reflect(userId) {
      // T13: threshold nudge + per-hour accept factors. For now just a log line.
      const n = await q.countInvitationsSince(db, userId, new Date(istMidnight(now()).getTime() - 24 * HOUR));
      console.log(`[reflect] user ${userId}: ${n} invitation(s) since yesterday`);
    },

    async recheckWindow(invitationId) {
      const inv = await mustInv(invitationId);
      if (inv.status !== "pending") return { ok: false, reason: `invitation is ${inv.status}` };
      const t = now();
      const { input, threshold } = await buildEvaluateInput(db, inv.user_id, t);
      // This invitation is the open one and counts toward today's cap — don't let it block itself.
      input.history = {
        ...input.history,
        hasOpenInvitation: false,
        invitesToday: Math.max(0, input.history.invitesToday - (new Date(inv.created_at) >= istMidnight(t) ? 1 : 0)),
      };
      const ws = new Date(inv.window_start).getTime();
      const c = evaluateWindows(input).find((x) => x.spot_id === inv.spot_id && x.window_start.getTime() === ws);
      if (!c) return { ok: false, reason: "window no longer in the forecast horizon" };
      if (!c.safe || c.blocked_by.length) return { ok: false, reason: `blocked by ${c.blocked_by.join(",")}` };
      if (!(c.factors.availability > 0)) return { ok: false, reason: "not available" };
      const min = threshold * RECHECK_SLACK;
      if (c.score < min) return { ok: false, reason: `score ${c.score.toFixed(2)} < ${min.toFixed(2)}` };
      return { ok: true, reason: c.reason };
    },

    async composeScript(invitationId) {
      const inv = await mustInv(invitationId);
      const r = await composeScript(scriptLlm(), await invitationFacts(inv));
      await q.setInvitationStatus(db, inv.id, inv.status, { script: r.script });
      await q.logAgentRun(db, {
        invitation_id: inv.id,
        kind: "script",
        model: r.meta.fallback ? "template" : r.meta.model,
        tokens_in: r.meta.tokens_in,
        tokens_out: r.meta.tokens_out,
        latency_ms: r.meta.latency_ms,
      });
      return { script: r.script, fallback: r.meta.fallback };
    },

    async deliver(invitationId) {
      const inv = await mustInv(invitationId);
      // Guard against a retry after a delivery that succeeded but whose completion was lost.
      if (inv.status !== "pending") return { channel: inv.channel, ...(inv.call_id && { call_id: inv.call_id }) };
      if (!inv.script) throw invalid(`invitation ${invitationId} has no script`);
      const r = await deps.deliver(inv, inv.script);
      if (r.channel === "none") console.warn(`[deliver] invitation ${inv.id}: no channel reached the user`);
      await q.setInvitationStatus(db, inv.id, "sent", {
        ...(r.channel !== "none" && { channel: r.channel }),
        ...(r.call_id && { call_id: r.call_id }),
      });
      return r;
    },

    async setStatus(invitationId, status) {
      await mustInv(invitationId);
      const responded = status === "accepted" || status === "declined" || status === "no_answer";
      await q.setInvitationStatus(db, invitationId, status, responded ? { responded_at: now() } : {});
    },

    async compileVisit(invitationId) {
      const prior = await db.query<{ id: string }>(`select id from field_notes where facts->>'invitation_id' = $1 limit 1`, [invitationId]);
      if (prior[0]) return { noteId: prior[0].id };
      const inv = await mustInv(invitationId);
      const visit = await q.getVisitByInvitation(db, inv.id);
      if (!visit) return { noteId: null };
      const spot = await mustSpot(inv.spot_id);

      const species = new Map<string, DayFacts["species"][number]>();
      for (const d of await q.listDetections(db, visit.id)) {
        const name = d.common_name ?? d.species_code;
        const s = species.get(name);
        if (!s) species.set(name, { common_name: name, count: 1, first_time: new Date(d.time), confidence: d.confidence });
        else {
          s.count++;
          s.confidence = Math.max(s.confidence, d.confidence);
        }
      }
      const start = new Date(visit.arrived_at);
      const facts: DayFacts = {
        date: fmtDate(start),
        spot: { name: spot.name, kind: spot.kind },
        start,
        end: visit.ended_at ? new Date(visit.ended_at) : now(),
        species: [...species.values()],
        observations: (await q.listObservations(db, visit.id)).map((o) => ({ time: new Date(o.time), text: o.text })),
      };
      const r = await writeNote(noteLlm(), facts);
      const model = r.meta.fallback ? "template" : r.meta.model;
      const note = await q.insertNote(db, {
        user_id: inv.user_id,
        date: facts.date,
        body: r.body,
        facts: { ...facts, invitation_id: inv.id, visit_id: visit.id },
        model,
      });
      await q.logAgentRun(db, {
        invitation_id: inv.id, kind: "note", model,
        tokens_in: r.meta.tokens_in, tokens_out: r.meta.tokens_out, latency_ms: r.meta.latency_ms,
      });
      return { noteId: note.id };
    },
  };
}
