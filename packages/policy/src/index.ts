// Decision + safety policy (spec §3.5, §3.6; PRD §6.3, §6.4). Pure: no I/O, no clock reads.
import {
  TIMEZONE,
  type Candidate,
  type ConditionsHour,
  type Factors,
  type Forecast,
  type Spot,
  type SpotKind,
  type SunTimes,
  type User,
} from "@sitspot/shared";
import { CONFIG } from "./config.js";

export { CONFIG };

const MIN = 60_000;
const HOUR = 60 * MIN;
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const validDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---------- local time (Intl, no deps) ----------

const fmts = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
    } catch {
      f = formatter(TIMEZONE); // unknown tz string -> fall back to IST rather than crash
    }
    fmts.set(tz, f);
  }
  return f;
}

function localHMS(d: Date, tz: string) {
  const p = formatter(tz).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { h: get("hour") % 24, m: get("minute"), s: get("second") };
}

/** Fractional minute-of-day of `d` in `tz` (0 ≤ x < 1440). */
export function localMinuteOfDay(d: Date, tz: string = TIMEZONE): number {
  const { h, m, s } = localHMS(d, tz);
  return h * 60 + m + (s + d.getUTCMilliseconds() / 1000) / 60;
}

export function localHour(d: Date, tz: string = TIMEZONE): number {
  return localHMS(d, tz).h;
}

/** "HH:MM" in `tz`. */
export function hhmm(d: Date, tz: string = TIMEZONE): string {
  const { h, m } = localHMS(d, tz);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" or "HH:MM:SS" -> minutes since midnight, or null if unparseable. */
export function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]), ss = Number(m[3] ?? 0);
  if (h > 23 || mm > 59 || ss > 59) return null;
  return h * 60 + mm + ss / 60;
}

/**
 * Does [start, end) touch quiet hours [quiet_start, quiet_end) in `tz`? Handles the midnight wrap
 * (22:00–07:00). quiet_start === quiet_end means no quiet hours. Unparseable times fail closed (true).
 * A zero-length interval is treated as the instant `start`.
 * ponytail: local minute = start's local minute + elapsed minutes, so a DST jump inside the interval
 * is ignored; fine for Asia/Kolkata (no DST), revisit if other zones matter.
 */
export function overlapsQuietHours(
  start: Date, end: Date, quiet_start: string, quiet_end: string, tz: string = TIMEZONE,
): boolean {
  const qs = parseClock(quiet_start), qe = parseClock(quiet_end);
  if (qs === null || qe === null || !validDate(start) || !validDate(end)) return true;
  if (qs === qe) return false;
  const len = Math.max((end.getTime() - start.getTime()) / MIN, 1e-9);
  if (len >= 1440) return true;
  const a = localMinuteOfDay(start, tz), b = a + len; // b < 2880
  const segs: [number, number][] = qs < qe ? [[qs, qe]] : [[qs, 1440], [0, qe]];
  return segs.some(([s, e]) => [0, 1440].some((k) => a < e + k && b > s + k));
}

// ---------- factors ----------

/** 0..1 from apparent temp (°C), US AQI and precipitation (mm/h). Nulls never throw. */
export function comfort(apparent_c: number | null, us_aqi: number | null, precip_mm: number | null): number {
  const c = CONFIG.comfort;
  if (fin(precip_mm) && precip_mm > c.precipMaxMm) return 0;
  let t: number;
  if (!fin(apparent_c)) t = c.missingTempFactor;
  else t = clamp((c.tempZeroC - apparent_c) / (c.tempZeroC - c.tempFullC), 0, 1);
  let q = 1;
  if (fin(us_aqi)) {
    if (us_aqi <= c.aqiFull) q = 1;
    else if (us_aqi <= c.aqiHalf) q = 1 - 0.5 * (us_aqi - c.aqiFull) / (c.aqiHalf - c.aqiFull);
    else if (us_aqi < c.aqiZero) q = 0.5 * (c.aqiZero - us_aqi) / (c.aqiZero - c.aqiHalf);
    else q = 0;
  }
  return t * q;
}

export type TideState = {
  trend: "falling" | "rising";
  /** Hours to the nearest low tide, either side (absolute). */
  hoursToLow: number;
  /** Minutes to the nearest high tide, either side (absolute). */
  minutesToNearestHigh: number;
};

/** Non-coastal: 1. Coastal with unknown tide: 0. */
export function tideFit(kind: SpotKind, tide: TideState | null): number {
  if (kind !== "coastal") return 1;
  const t = CONFIG.tide;
  if (!tide) return 0;
  if (Number.isNaN(tide.minutesToNearestHigh)) return 0; // Infinity = no high known; S-2 still guards
  if (tide.minutesToNearestHigh <= CONFIG.highTideMarginMin) return t.highMargin;
  const h = fin(tide.hoursToLow) ? tide.hoursToLow : Infinity;
  if (h < t.bestFromH) return t.nearLow;
  if (tide.trend === "falling" && h <= t.bestToH) return t.best;
  return t.rising;
}

/** 1 + 0.3 × (fraction of [time, time+windowMin] inside a golden hour). Golden hours are
 * [sunrise, goldenHourEnd] and [goldenHourStart, sunset]. */
export function lightBonus(time: Date, sun: SunTimes | null, windowMin: number = CONFIG.windowMin): number {
  if (!sun || !validDate(time) || !(windowMin > 0)) return 1;
  const a = time.getTime(), b = a + windowMin * MIN;
  const ov = (s: Date, e: Date) =>
    validDate(s) && validDate(e) ? Math.max(0, Math.min(b, e.getTime()) - Math.max(a, s.getTime())) : 0;
  const inside = ov(sun.sunrise, sun.goldenHourEnd) + ov(sun.goldenHourStart, sun.sunset);
  return 1 + (CONFIG.light.max - 1) * clamp(inside / (b - a), 0, 1);
}

/** true -> 1.3; count n -> 1 + 0.15n capped at 1.3; false/0/invalid -> 1. */
export function novelty(lovedSeenWithin48h: boolean | number | null | undefined): number {
  const n = CONFIG.novelty;
  if (typeof lovedSeenWithin48h === "boolean") return lovedSeenWithin48h ? n.max : 1;
  if (!fin(lovedSeenWithin48h) || lovedSeenWithin48h <= 0) return 1;
  return Math.min(n.max, 1 + n.perSighting * lovedSeenWithin48h);
}

export type History = {
  invitesToday: number;
  lastDeclineAt: Date | null;
  hasOpenInvitation: boolean;
};

/** Learned accept factor per local hour (0..23); clamped to 0.5..1.5. */
export type AcceptFactorByHour = Partial<Record<number, number>>;

export type AvailabilityInput = History & {
  now: Date;
  window_start: Date;
  window_end: Date;
  /** When the call goes out; quiet hours are checked over [send_at, window_end]. */
  send_at?: Date;
  quiet_start: string;
  quiet_end: string;
  timezone?: string;
  acceptFactorByHour?: AcceptFactorByHour;
};

/** 0 if blocked by policy, else the clamped per-hour accept factor (default 1). */
export function availability(i: AvailabilityInput): number {
  const a = CONFIG.availability;
  if (i.hasOpenInvitation) return 0;
  if (!(i.invitesToday < a.maxInvitesPerDay)) return 0; // NaN -> blocked
  if (i.lastDeclineAt && !(i.now.getTime() - i.lastDeclineAt.getTime() >= a.declineCooldownMin * MIN)) return 0;
  const from = i.send_at && i.send_at < i.window_start ? i.send_at : i.window_start;
  if (overlapsQuietHours(from, i.window_end, i.quiet_start, i.quiet_end, i.timezone)) return 0;
  const f = i.acceptFactorByHour?.[localHour(i.window_start, i.timezone)];
  return fin(f) ? clamp(f, a.acceptFactorMin, a.acceptFactorMax) : 1;
}

// ---------- safety (S-1, S-2, S-4, S-5; S-3 is enforced on the script) ----------

export const coastalSafetyLine = CONFIG.coastalSafetyLine;
export const requiresSafetyLine = (kind: SpotKind): boolean => kind === "coastal";

export type SafetyRule = "S-1" | "S-2" | "S-4" | "S-5";
export type SafetyInput = {
  kind: SpotKind;
  window_start: Date;
  window_end: Date;
  send_at?: Date;
  sun: SunTimes | null;
  highTides: Date[];
  apparent_c: number | null;
  us_aqi: number | null;
  quiet_start: string;
  quiet_end: string;
  timezone?: string;
};

export function safetyCheck(i: SafetyInput): { ok: boolean; blocked_by: SafetyRule[] } {
  const blocked: SafetyRule[] = [];
  const s = i.window_start.getTime(), e = i.window_end.getTime();
  if (i.kind === "coastal") {
    // S-1: inside [sunrise, sunset − 30 min]. Missing/invalid sun data fails closed.
    const sun = i.sun;
    if (!sun || !validDate(sun.sunrise) || !validDate(sun.sunset) || !(s >= sun.sunrise.getTime())
      || !(e <= sun.sunset.getTime() - CONFIG.safety.sunsetBufferMin * MIN)) blocked.push("S-1");
    // S-2: no overlap with any high tide ± margin. No tide data at all fails closed.
    const m = CONFIG.highTideMarginMin * MIN;
    const highs = (i.highTides ?? []).filter(validDate);
    if (highs.length === 0 || highs.some((h) => s < h.getTime() + m && e > h.getTime() - m)) blocked.push("S-2");
  }
  // S-4: heat / air. Unknown values do not block (comfort penalises missing temp instead).
  if ((fin(i.apparent_c) && i.apparent_c >= CONFIG.safety.maxApparentC)
    || (fin(i.us_aqi) && i.us_aqi >= CONFIG.safety.maxAqi)) blocked.push("S-4");
  // S-5: quiet hours are absolute — covers the call itself (send_at) through window end.
  const from = i.send_at && i.send_at < i.window_start ? i.send_at : i.window_start;
  if (overlapsQuietHours(from, i.window_end, i.quiet_start, i.quiet_end, i.timezone)) blocked.push("S-5");
  return { ok: blocked.length === 0, blocked_by: blocked };
}

// ---------- scoring ----------

export function score(f: Factors): number {
  const x = f.p_rich * f.comfort * f.tide_fit * f.light_bonus * f.novelty * f.availability;
  return fin(x) ? Math.max(0, x) : 0;
}

export function sendAt(window_start: Date, travel_min: number): Date {
  const t = fin(travel_min) ? Math.max(0, travel_min) : 0;
  return new Date(window_start.getTime() - (t + CONFIG.sendLeadMin) * MIN);
}

export type TideEvent = { time: Date; tide_m: number | null };
export type TideEvents = { lows: TideEvent[]; highs: TideEvent[] };

/** Tide state at instant t from surrounding low/high events; null if there are none. */
export function tideStateAt(t: Date, ev: TideEvents | null | undefined): TideState | null {
  const lows = (ev?.lows ?? []).filter((x) => validDate(x.time));
  const highs = (ev?.highs ?? []).filter((x) => validDate(x.time));
  if (lows.length === 0 && highs.length === 0) return null;
  const tt = t.getTime();
  const all = [...lows.map((x) => ({ t: x.time.getTime(), low: true })), ...highs.map((x) => ({ t: x.time.getTime(), low: false }))]
    .sort((a, b) => a.t - b.t);
  const next = all.find((x) => x.t > tt);
  const prev = [...all].reverse().find((x) => x.t <= tt);
  // Heading to a low = falling. With only a past event: after a high it's falling, after a low rising.
  const falling = next ? next.low : !prev!.low;
  const dist = (xs: TideEvent[]) => Math.min(Infinity, ...xs.map((x) => Math.abs(x.time.getTime() - tt)));
  return { trend: falling ? "falling" : "rising", hoursToLow: dist(lows) / HOUR, minutesToNearestHigh: dist(highs) / MIN };
}

export type EvaluateInput = {
  now: Date;
  user: Pick<User, "quiet_start" | "quiet_end" | "timezone"> & Partial<Pick<User, "threshold">>;
  spots: Pick<Spot, "id" | "name" | "kind" | "travel_min">[];
  conditionsBySpot: Record<string, ConditionsHour[]>;
  forecastsBySpot: Record<string, Forecast[]>;
  /** Sun times for the local day containing `date` at this spot. */
  sunFor: (spotId: string, date: Date) => SunTimes | null;
  tideEventsBySpot?: Record<string, TideEvents>;
  /** Loved-species sightings near the spot in the last 48 h. */
  lovedSightingsBySpot?: Record<string, number>;
  history: History;
  acceptFactorByHour?: AcceptFactorByHour;
};

/** Row whose time is closest to t (strictly within 60 min), or null. Later rows win ties. */
function nearest<T extends { time: Date }>(rows: T[] | undefined, t: Date): T | null {
  let best: T | null = null, bd = HOUR;
  for (const r of rows ?? []) {
    if (!validDate(r.time)) continue;
    const d = Math.abs(r.time.getTime() - t.getTime());
    if (d < bd || (d === bd && best)) { best = r; bd = d; }
  }
  return best;
}

/** First window start: next local top-of-hour at or after now. */
function firstWindowStart(now: Date, tz: string): Date {
  const off = (60 - (localMinuteOfDay(now, tz) % 60)) % 60;
  return new Date(Math.round((now.getTime() + off * MIN) / 1000) * 1000);
}

/** Every spot × next 6 hourly windows, scored, sorted by score desc (ties: earlier, then spot id). */
export function evaluateWindows(input: EvaluateInput): Candidate[] {
  const tz = input.user.timezone || TIMEZONE;
  const first = firstWindowStart(input.now, tz);
  const out: Candidate[] = [];
  for (const spot of input.spots) {
    for (let k = 0; k < CONFIG.horizonHours; k++) {
      const window_start = new Date(first.getTime() + k * HOUR);
      const window_end = new Date(window_start.getTime() + CONFIG.windowMin * MIN);
      const mid = new Date((window_start.getTime() + window_end.getTime()) / 2);
      const send_at = sendAt(window_start, spot.travel_min);
      const cond = nearest(input.conditionsBySpot[spot.id], window_start);
      const fc = nearest(input.forecastsBySpot[spot.id], window_start);
      const sun = input.sunFor(spot.id, window_start);
      const tides = input.tideEventsBySpot?.[spot.id];
      const loved = input.lovedSightingsBySpot?.[spot.id] ?? 0;
      // Missing apparent temp falls back to air temp; both missing -> comfort penalty.
      const apparent = fin(cond?.apparent_c) ? cond!.apparent_c : fin(cond?.temp_c) ? cond!.temp_c : null;
      const aqi = cond?.us_aqi ?? null;
      const p_ok = fc && fin(fc.p_rich);
      const factors: Factors = {
        p_rich: p_ok ? clamp(fc.p_rich, 0, 1) : CONFIG.prior.p_rich,
        p_rich_model: p_ok ? fc.model_version : CONFIG.prior.model,
        comfort: comfort(apparent, aqi, cond?.precip_mm ?? null),
        tide_fit: tideFit(spot.kind, tideStateAt(mid, tides)),
        light_bonus: lightBonus(window_start, sun),
        novelty: novelty(loved),
        availability: availability({
          ...input.history, now: input.now, window_start, window_end, send_at,
          quiet_start: input.user.quiet_start, quiet_end: input.user.quiet_end, timezone: tz,
          acceptFactorByHour: input.acceptFactorByHour,
        }),
      };
      const safety = safetyCheck({
        kind: spot.kind, window_start, window_end, send_at, sun,
        highTides: (tides?.highs ?? []).map((h) => h.time),
        apparent_c: apparent, us_aqi: aqi,
        quiet_start: input.user.quiet_start, quiet_end: input.user.quiet_end, timezone: tz,
      });
      out.push({
        spot_id: spot.id, window_start, window_end, send_at,
        score: score(factors), factors,
        reason: reasonFor(spot.kind, mid, apparent, aqi, sun, window_start, window_end, tides, loved, factors, tz),
        safe: safety.ok, blocked_by: safety.blocked_by,
      });
    }
  }
  return out.sort((a, b) =>
    b.score - a.score || a.window_start.getTime() - b.window_start.getTime() || a.spot_id.localeCompare(b.spot_id));
}

function reasonFor(
  kind: SpotKind, mid: Date, apparent: number | null, aqi: number | null, sun: SunTimes | null,
  start: Date, end: Date, tides: TideEvents | undefined, loved: number, f: Factors, tz: string,
): string {
  const lead: string[] = [];
  if (kind === "coastal") {
    const low = (tides?.lows ?? []).filter((x) => validDate(x.time))
      .sort((a, b) => Math.abs(a.time.getTime() - mid.getTime()) - Math.abs(b.time.getTime() - mid.getTime()))[0];
    lead.push(low ? `low tide at ${hhmm(low.time, tz)}` : "tide times unknown");
  }
  if (fin(apparent)) lead.push(`${Math.round(apparent)}°C apparent` + (fin(aqi) ? ` with AQI ${Math.round(aqi)}` : ""));
  else lead.push(fin(aqi) ? `AQI ${Math.round(aqi)} (temperature unknown)` : "no weather data");
  const parts = [lead.join(" and ")];
  if (f.light_bonus > 1 && sun) {
    const evening = validDate(sun.goldenHourStart) && sun.goldenHourStart < end && sun.sunset > start;
    parts.push(evening ? `golden hour starts ${hhmm(sun.goldenHourStart, tz)}` : `golden hour until ${hhmm(sun.goldenHourEnd, tz)}`);
  }
  if (fin(loved) && loved > 0) parts.push(`${loved} loved-species sighting${loved === 1 ? "" : "s"} nearby in 48 h`);
  parts.push(`${Math.round(f.p_rich * 100)}% birding chance${f.p_rich_model === CONFIG.prior.model ? " (prior)" : ""}`);
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** Best safe, available candidate with score ≥ threshold whose send time hasn't passed; else null. */
export function pickInvitation(
  candidates: Candidate[], threshold: number, now: Date,
): Candidate | null {
  const th = fin(threshold) ? threshold : CONFIG.defaultThreshold;
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (!c.safe || c.blocked_by.length > 0) continue;
    if (!(c.factors.availability > 0) || !fin(c.score) || c.score < th) continue;
    if (!(c.send_at.getTime() >= now.getTime())) continue;
    if (!best || c.score > best.score
      || (c.score === best.score && c.window_start.getTime() < best.window_start.getTime())) best = c;
  }
  return best;
}
