import { nextHighTide, nextLowTide, sunTimes, type TideRow } from "@sitspot/data";
import {
  countInvitationsSince, getAcceptFactors, getConditions, getUser, lastDeclineAt, latestForecasts, listPreferences,
  listSpots, openInvitation, recentSightingsNear, type Db,
} from "@sitspot/db";
import { evaluateWindows, pickInvitation, type EvaluateInput, type TideEvent, type TideEvents } from "@sitspot/policy";
import type { Candidate, Spot } from "@sitspot/shared";
import { acceptFactorsByHour, buildRules } from "./memory";

const HOUR = 3_600_000;
const IST_MS = 5.5 * HOUR;
const SIGHTING_KM = 5; // same radius the eBird puller asks for

/** Local IST midnight at or before `now`. ponytail: fixed IST like packages/data; use user.timezone if we leave India. */
export function istMidnight(now: Date): Date {
  return new Date(Math.floor((now.getTime() + IST_MS) / (24 * HOUR)) * 24 * HOUR - IST_MS);
}

/** Every hourly low/high in a tide series (hourly resolution, from packages/data). */
export function tideEvents(rows: TideRow[]): TideEvents {
  const all = (pick: typeof nextLowTide) => {
    const out: TideEvent[] = [];
    for (let p = pick(rows, new Date(0)); p; p = pick(rows, new Date(p.time.getTime() + 1))) out.push(p);
    return out;
  };
  return { lows: all(nextLowTide), highs: all(nextHighTide) };
}

/** Strings found in 'loves' preferences (value may be a string or a string[]). */
function lovedNames(prefs: { key: string; value: unknown }[]): string[] {
  return prefs
    .filter((p) => p.key === "loves")
    .flatMap((p) => (Array.isArray(p.value) ? p.value : [p.value]))
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase());
}

export async function buildEvaluateInput(db: Db, userId: string, now: Date): Promise<{ input: EvaluateInput; threshold: number; spots: Spot[] }> {
  const user = await getUser(db, userId);
  if (!user) throw new Error(`user ${userId} not found`);
  const spots = await listSpots(db, userId);
  const prefs = await listPreferences(db, userId);
  const loved = lovedNames(prefs);

  const conditionsBySpot: EvaluateInput["conditionsBySpot"] = {};
  const forecastsBySpot: EvaluateInput["forecastsBySpot"] = {};
  const tideEventsBySpot: Record<string, TideEvents> = {};
  const lovedSightingsBySpot: Record<string, number> = {};
  const from = new Date(now.getTime() - HOUR), to = new Date(now.getTime() + 7 * HOUR);

  for (const s of spots) {
    conditionsBySpot[s.id] = await getConditions(db, s.id, from, to);
    forecastsBySpot[s.id] = await latestForecasts(db, s.id, from, to);
    if (s.kind === "coastal") {
      // Wider series so events either side of the 6 h horizon are known (trend + nearest low/high).
      const series = await getConditions(db, s.id, new Date(now.getTime() - 12 * HOUR), new Date(now.getTime() + 48 * HOUR));
      tideEventsBySpot[s.id] = tideEvents(series);
    }
    if (loved.length) {
      const seen = await recentSightingsNear(db, s.lat, s.lon, SIGHTING_KM, new Date(now.getTime() - 48 * HOUR));
      lovedSightingsBySpot[s.id] = seen.filter((x) => {
        const n = (x.common_name ?? "").toLowerCase();
        return n && loved.some((l) => n.includes(l));
      }).length;
    }
  }
  const byId = new Map(spots.map((s) => [s.id, s]));
  const input: EvaluateInput = {
    now,
    user,
    spots,
    conditionsBySpot,
    forecastsBySpot,
    sunFor: (id, date) => {
      const s = byId.get(id);
      return s ? sunTimes(date, s.lat, s.lon) : null;
    },
    tideEventsBySpot,
    lovedSightingsBySpot,
    history: {
      invitesToday: await countInvitationsSince(db, userId, istMidnight(now)),
      lastDeclineAt: await lastDeclineAt(db, userId),
      hasOpenInvitation: (await openInvitation(db, userId)) !== null,
    },
    acceptFactorByHour: acceptFactorsByHour(await getAcceptFactors(db, userId)),
    rules: buildRules(prefs, spots),
  };
  return { input, threshold: user.threshold, spots };
}

/** Score every spot × next 6 windows for a user and pick the invitation (if any). */
export async function evaluateForUser(
  db: Db,
  userId: string,
  now: Date,
): Promise<{ candidates: (Candidate & { held?: string })[]; pick: Candidate | null; threshold: number }> {
  const { input, threshold } = await buildEvaluateInput(db, userId, now);
  const candidates = evaluateWindows(input);
  return { candidates, pick: pickInvitation(candidates, threshold, now), threshold };
}
