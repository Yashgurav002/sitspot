import { expect, it } from "vitest";
import type { ConditionsHour, SpotKind, SunTimes } from "@sitspot/shared";
import { evaluateWindows, pickInvitation, type EvaluateInput } from "../src/index.js";

// Seeded PRNG so failures reproduce.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, IST = 330 * MIN;
// Oracle: IST is a fixed +05:30, computed by plain arithmetic (independent of the Intl code under test).
const istMinute = (t: number) => Math.floor((((t + IST) % DAY) + DAY) % DAY / MIN);
const istDayStart = (t: number) => Math.floor((t + IST) / DAY) * DAY - IST;
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
function inQuiet(m: number, qs: number, qe: number) {
  if (qs === qe) return false;
  return qs < qe ? m >= qs && m < qe : m >= qs || m < qe;
}
const KINDS: SpotKind[] = ["home", "park", "heritage", "coastal"];

it("pickInvitation never returns an unsafe, unavailable or quiet-hours candidate (2000 random inputs)", () => {
  const r = mulberry32(42);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const maybe = (p: number, v: () => number) => (r() < p ? null : v());
  let picks = 0;

  for (let iter = 0; iter < 2000; iter++) {
    const base = Date.UTC(2026, 9, 6) + Math.floor(r() * 3 * DAY / MIN) * MIN + Math.floor(r() * 60) * 1000;
    const now = new Date(base);
    const qs = Math.floor(r() * 24) * 60 + pick([0, 15, 30, 45]);
    const qe = r() < 0.1 ? qs : Math.floor(r() * 24) * 60 + pick([0, 30]);
    const sunFor = (_: string, d: Date): SunTimes => {
      const ds = istDayStart(d.getTime());
      return {
        sunrise: new Date(ds + 380 * MIN), goldenHourEnd: new Date(ds + 420 * MIN),
        goldenHourStart: new Date(ds + 1050 * MIN), sunset: new Date(ds + 1090 * MIN),
      };
    };
    const nSpots = 1 + Math.floor(r() * 4);
    const spots = Array.from({ length: nSpots }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `S${i}`,
      kind: pick(KINDS), travel_min: Math.floor(r() * 61),
    }));
    const conditionsBySpot: Record<string, ConditionsHour[]> = {};
    const forecastsBySpot: EvaluateInput["forecastsBySpot"] = {};
    const tideEventsBySpot: NonNullable<EvaluateInput["tideEventsBySpot"]> = {};
    const lovedSightingsBySpot: Record<string, number> = {};
    const h0 = Math.floor(base / HOUR) * HOUR - 30 * MIN; // IST top-of-hour
    for (const s of spots) {
      if (r() < 0.9) {
        conditionsBySpot[s.id] = Array.from({ length: 10 }, (_, i) => ({
          time: new Date(h0 + i * HOUR), spot_id: s.id,
          temp_c: maybe(0.2, () => 20 + r() * 25), apparent_c: maybe(0.2, () => 20 + r() * 25),
          rh_pct: null, wind_ms: null, precip_mm: maybe(0.2, () => r() * 3),
          cloud_pct: null, pm25: null, pm10: null, us_aqi: maybe(0.2, () => r() * 260),
          tide_m: null, is_forecast: true,
        }));
      }
      if (r() < 0.7) {
        forecastsBySpot[s.id] = Array.from({ length: 10 }, (_, i) => ({
          time: new Date(h0 + i * HOUR), spot_id: s.id, p_rich: r(), model_version: "m",
        }));
      }
      if (r() < 0.85) {
        const phase = base - 13 * HOUR + Math.floor(r() * 12.4 * 60) * MIN;
        const lows = [], highs = [];
        for (let k = 0; k < 6; k++) {
          const t = phase + k * 12.42 * HOUR;
          highs.push({ time: new Date(t), tide_m: 4 });
          lows.push({ time: new Date(t + 6.21 * HOUR), tide_m: 0.5 });
        }
        tideEventsBySpot[s.id] = { lows, highs: r() < 0.1 ? [] : highs };
      }
      lovedSightingsBySpot[s.id] = Math.floor(r() * 4);
    }
    const history = {
      invitesToday: Math.floor(r() * 4),
      lastDeclineAt: r() < 0.5 ? null : new Date(base - Math.floor(r() * 8 * 60) * MIN),
      hasOpenInvitation: r() < 0.2,
    };
    const acceptFactorByHour: Record<number, number> = {};
    for (let h = 0; h < 24; h++) if (r() < 0.5) acceptFactorByHour[h] = r() * 2;
    const threshold = r() * 0.5;
    const input: EvaluateInput = {
      now, user: { quiet_start: clock(qs), quiet_end: clock(qe), timezone: "Asia/Kolkata" },
      spots, conditionsBySpot, forecastsBySpot, sunFor, tideEventsBySpot, lovedSightingsBySpot, history, acceptFactorByHour,
    };

    const cands = evaluateWindows(input);
    expect(cands).toHaveLength(nSpots * 6);
    const p = pickInvitation(cands, threshold, now);
    if (!p) continue;
    picks++;
    const spot = spots.find((s) => s.id === p.spot_id)!;
    const ws = p.window_start.getTime(), we = p.window_end.getTime(), sa = p.send_at.getTime();

    // FR-10 / FR-11
    expect(p.score).toBeGreaterThanOrEqual(threshold);
    expect(sa).toBeGreaterThanOrEqual(base);
    expect(sa).toBe(ws - (spot.travel_min + 10) * MIN);
    expect(history.hasOpenInvitation).toBe(false);
    expect(history.invitesToday).toBeLessThan(2);
    if (history.lastDeclineAt) expect(base - history.lastDeclineAt.getTime()).toBeGreaterThanOrEqual(3 * HOUR);
    // S-5: every minute from the call to the window end is outside quiet hours.
    for (let t = sa; t < we; t += MIN) expect(inQuiet(istMinute(t), qs, qe)).toBe(false);
    // S-4: recompute from raw conditions.
    const row = conditionsBySpot[spot.id]?.find((c) => c.time.getTime() === ws);
    const app = row?.apparent_c ?? row?.temp_c ?? null;
    if (app !== null) expect(app).toBeLessThan(38);
    if (row?.us_aqi != null) expect(row.us_aqi).toBeLessThan(200);
    if (spot.kind === "coastal") {
      // S-1
      const sun = sunFor(spot.id, p.window_start);
      expect(ws).toBeGreaterThanOrEqual(sun.sunrise.getTime());
      expect(we).toBeLessThanOrEqual(sun.sunset.getTime() - 30 * MIN);
      // S-2
      const highs = tideEventsBySpot[spot.id]?.highs ?? [];
      expect(highs.length).toBeGreaterThan(0);
      for (const h of highs) {
        const ht = h.time.getTime();
        expect(we <= ht - HOUR || ws >= ht + HOUR).toBe(true);
      }
    }
  }
  expect(picks).toBeGreaterThan(50); // the property isn't vacuous
});
