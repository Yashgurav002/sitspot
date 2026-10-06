// Plain-data inputs to the agent. Callers (workflows/api) build these from db + policy;
// the agent never touches either. Every number the model may say is rendered by the
// helpers below, so the context block and the templates format numbers identically.
import { TIMEZONE, type Factors, type SpotKind } from '@sitspot/shared';

export interface Tide {
  low_time?: Date;
  low_m?: number;
  trend?: 'falling' | 'rising' | 'slack';
}

export interface Numbers {
  apparent_c?: number;
  us_aqi?: number;
  wind_ms?: number;
  tide?: Tide;
  sunset?: Date;
  golden_start?: Date;
}

export interface InvitationFacts {
  now: Date;
  spot: { name: string; kind: SpotKind; travel_min: number };
  window_start: Date;
  window_end: Date;
  leave_by: Date;
  factors: Factors;
  numbers: Numbers;
  sightings: { common_name: string; count: number; when: Date }[];
  preferences: { key: string; value: unknown; quote: string }[];
  notes: { date: string; excerpt: string }[];
  /** Present only during a visit. */
  detections?: { common_name: string; confidence: number; time: Date }[];
  safety_line?: string;
}

/** Deterministic facts of one visit day, for the field note (spec §13). */
export interface DayFacts {
  date: string; // YYYY-MM-DD
  spot: { name: string; kind: SpotKind };
  start: Date;
  end: Date;
  species: { common_name: string; count: number; first_time: Date; confidence: number }[];
  numbers?: Numbers;
  observations?: { time: Date; text: string }[];
}

const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** HH:MM in Asia/Kolkata. */
export const fmtTime = (d: Date) => hm.format(d);
/** YYYY-MM-DD in Asia/Kolkata. */
export const fmtDate = (d: Date) => ymd.format(d);

export const fmtTemp = (c: number) => `${Math.round(c)}°C`;
export const fmtAqi = (n: number) => `US AQI ${Math.round(n)}`;
export const fmtWind = (ms: number) => `wind ${Math.round(ms)} m/s`;
export const fmtTideM = (m: number) => `${Math.round(m * 10) / 10} m`;

/** "today" / "yesterday" / YYYY-MM-DD, relative to now, in IST. */
export function dayLabel(d: Date, now: Date): string {
  const a = fmtDate(d);
  if (a === fmtDate(now)) return 'today';
  if (a === fmtDate(new Date(now.getTime() - 86_400_000))) return 'yesterday';
  return a;
}

export function visitMinutes(f: DayFacts): number {
  return Math.max(0, Math.round((f.end.getTime() - f.start.getTime()) / 60_000));
}

/** Spoken confidence wording (spec §9.3): ≥0.8 confident, 0.6–0.8 fairly confident, <0.6 possibly. */
export function confidenceWord(c: number): string {
  if (c >= 0.8) return 'confident';
  if (c >= 0.6) return 'fairly confident, not certain';
  return 'possibly';
}
