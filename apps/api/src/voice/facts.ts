// InvitationFacts from the DB (spec §9.2). Shared by the voice endpoint and workflow scripts.
import { fmtDate, type InvitationFacts } from "@sitspot/agent";
import { nextLowTide, sunTimes, tideTrend } from "@sitspot/data";
import * as q from "@sitspot/db";
import type { Db } from "@sitspot/db";
import { coastalSafetyLine, sendAt } from "@sitspot/policy";

const HOUR = 3_600_000;
const SIGHTING_KM = 3;
const def = <T>(v: T | null | undefined) => (v == null ? undefined : v);

export async function buildInvitationFacts(db: Db, invitationId: string, now: Date, visitId?: string | null): Promise<InvitationFacts | null> {
  const inv = await q.getInvitation(db, invitationId);
  const spot = inv && (await q.getSpot(db, inv.spot_id));
  if (!inv || !spot) return null;

  const ws = new Date(inv.window_start), we = new Date(inv.window_end);
  const hour = new Date(Math.floor(ws.getTime() / HOUR) * HOUR);
  const series = await q.getConditions(db, spot.id, new Date(now.getTime() - 12 * HOUR), new Date(Math.max(now.getTime(), we.getTime()) + 12 * HOUR));
  const at = series.find((r) => new Date(r.time).getTime() === hour.getTime()) ?? series.find((r) => new Date(r.time) >= hour);
  const sun = sunTimes(ws, spot.lat, spot.lon);

  const numbers: InvitationFacts["numbers"] = {
    apparent_c: def(at?.apparent_c),
    us_aqi: def(at?.us_aqi),
    wind_ms: def(at?.wind_ms),
    sunset: sun.sunset,
    golden_start: sun.goldenHourStart,
  };
  if (spot.kind === "coastal" && series.some((r) => r.tide_m != null)) {
    const low = nextLowTide(series, new Date(ws.getTime() - HOUR));
    numbers.tide = { low_time: low?.time, low_m: def(low?.tide_m), trend: def(tideTrend(series, ws)) };
  }

  // Aggregate eBird rows per species: count = summed how_many, when = latest.
  const bySpecies = new Map<string, { common_name: string; count: number; when: Date }>();
  for (const s of await q.recentSightingsNear(db, spot.lat, spot.lon, SIGHTING_KM, new Date(now.getTime() - 48 * HOUR))) {
    if (!s.common_name) continue;
    const e = bySpecies.get(s.common_name) ?? { common_name: s.common_name, count: 0, when: new Date(s.time) };
    e.count += s.how_many ?? 1;
    if (new Date(s.time) > e.when) e.when = new Date(s.time);
    bySpecies.set(s.common_name, e);
  }

  const facts: InvitationFacts = {
    now,
    spot: { name: spot.name, kind: spot.kind, travel_min: spot.travel_min },
    window_start: ws,
    window_end: we,
    leave_by: sendAt(ws, spot.travel_min),
    factors: inv.factors,
    numbers,
    sightings: [...bySpecies.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    preferences: (await q.listPreferences(db, inv.user_id)).map((p) => ({ key: p.key, value: p.value, quote: p.source_utterance })),
    notes: (await q.getNotes(db, inv.user_id)).slice(0, 2).map((n) => ({ date: typeof n.date === "string" ? n.date.slice(0, 10) : fmtDate(n.date as Date), excerpt: n.body.slice(0, 160) })),
    safety_line: spot.kind === "coastal" ? coastalSafetyLine : undefined,
  };
  if (visitId) {
    facts.detections = (await q.listDetections(db, visitId)).slice(-10).map((d) => ({
      common_name: d.common_name ?? d.species_code, confidence: d.confidence, time: new Date(d.time),
    }));
  }
  return facts;
}
