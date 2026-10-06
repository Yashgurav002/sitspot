import * as SunCalc from "suncalc";
import type { SunTimes } from "@sitspot/shared";

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

/** Sun times for the IST calendar day containing `date`. Anchored at local noon so suncalc
 *  never picks the neighbouring UTC day. ponytail: fixed IST (India has no DST); per-user tz if we leave India. */
export function sunTimes(date: Date, lat: number, lon: number): SunTimes {
  const noon = new Date(Math.floor((date.getTime() + IST_MS) / DAY_MS) * DAY_MS + 12 * 3_600_000 - IST_MS);
  const t = SunCalc.getTimes(noon, lat, lon);
  const { sunrise, sunset, goldenHour, goldenHourEnd } = t;
  // Only missing at polar latitudes (no sunrise that day); never for India.
  if (!sunrise || !sunset || !goldenHour || !goldenHourEnd) throw new Error(`no sunrise/sunset at ${lat},${lon}`);
  return { sunrise, sunset, goldenHourStart: goldenHour, goldenHourEnd };
}

const minutes = (ms: number) => ms / 60_000;

export const minutesFromSunrise = (time: Date, lat: number, lon: number) =>
  minutes(time.getTime() - sunTimes(time, lat, lon).sunrise.getTime());

export const minutesToSunset = (time: Date, lat: number, lon: number) =>
  minutes(sunTimes(time, lat, lon).sunset.getTime() - time.getTime());

/** Morning: sunrise..goldenHourEnd. Evening: goldenHourStart..sunset. */
export function isGoldenHour(time: Date, lat: number, lon: number): boolean {
  const s = sunTimes(time, lat, lon);
  const t = time.getTime();
  return (t >= s.sunrise.getTime() && t <= s.goldenHourEnd.getTime()) || (t >= s.goldenHourStart.getTime() && t <= s.sunset.getTime());
}

export type TideRow = { time: Date; tide_m: number | null };
export type TidePoint = { time: Date; tide_m: number };

/** Rising/falling from the hour containing `time` to the next (or previous→current at the series end). */
export function tideTrend(rows: TideRow[], time: Date): "rising" | "falling" | null {
  let i = -1;
  for (let k = 0; k < rows.length && rows[k]!.time <= time; k++) i = k;
  if (i < 0) return null;
  const [a, b] = i + 1 < rows.length ? [rows[i], rows[i + 1]] : [rows[i - 1], rows[i]];
  if (a?.tide_m == null || b?.tide_m == null || a.tide_m === b.tide_m) return null;
  return b.tide_m > a.tide_m ? "rising" : "falling";
}

// ponytail: hourly-resolution extrema; parabolic interpolation if sub-hour tide timing matters.
function nextExtremum(rows: TideRow[], after: Date, low: boolean): TidePoint | null {
  for (let i = 1; i + 1 < rows.length; i++) {
    const [p, c, n] = [rows[i - 1]!.tide_m, rows[i]!.tide_m, rows[i + 1]!.tide_m];
    if (p == null || c == null || n == null || rows[i]!.time < after) continue;
    if (low ? c < p && c <= n : c > p && c >= n) return { time: rows[i]!.time, tide_m: c };
  }
  return null;
}

export const nextLowTide = (rows: TideRow[], after: Date) => nextExtremum(rows, after, true);
export const nextHighTide = (rows: TideRow[], after: Date) => nextExtremum(rows, after, false);

const hoursUntil = (p: TidePoint | null, time: Date) => (p ? (p.time.getTime() - time.getTime()) / 3_600_000 : null);
export const hoursToLowTide = (rows: TideRow[], time: Date) => hoursUntil(nextLowTide(rows, time), time);
export const hoursToHighTide = (rows: TideRow[], time: Date) => hoursUntil(nextHighTide(rows, time), time);
