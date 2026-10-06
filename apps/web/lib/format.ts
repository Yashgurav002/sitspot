// Pure display helpers. All times shown in the user's zone (Asia/Kolkata by default).
import { TIMEZONE } from "@sitspot/shared";
import type { Factors } from "@sitspot/shared";
import type { WInvitation, Wire } from "./api";
import type { ConditionsHour } from "@sitspot/shared";

export function time(iso: string | Date, tz = TIMEZONE): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: tz });
}

export function day(iso: string | Date, tz = TIMEZONE): string {
  return new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: tz });
}

/** Leave-by = window start − travel minutes. */
export function leaveBy(windowStart: string | Date, travelMin: number): Date {
  return new Date(new Date(windowStart).getTime() - travelMin * 60_000);
}

const OPEN = new Set(["pending", "sent", "accepted", "arrived"]);

/** The invitation to show on home: newest one still open whose window hasn't ended. */
export function openInvitation(list: WInvitation[], now = new Date()): WInvitation | undefined {
  return list
    .filter((i) => OPEN.has(i.status) && new Date(i.window_end) > now)
    .sort((a, b) => +new Date(b.window_start) - +new Date(a.window_start))[0];
}

/** The hour closest to now, to summarise "current" conditions. */
export function currentHour<T extends Pick<Wire<ConditionsHour>, "time">>(hours: T[], now = new Date()): T | undefined {
  let best: T | undefined;
  for (const h of hours) {
    if (!best || Math.abs(+new Date(h.time) - +now) < Math.abs(+new Date(best.time) - +now)) best = h;
  }
  return best;
}

export function aqiLabel(aqi: number): string {
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "unhealthy for some";
  if (aqi <= 200) return "unhealthy";
  return "very unhealthy";
}

export function summarise(h: Wire<ConditionsHour> | undefined): string {
  if (!h) return "No conditions yet";
  const parts: string[] = [];
  if (h.temp_c != null) parts.push(`${Math.round(h.temp_c)}°C`);
  if (h.us_aqi != null) parts.push(`AQI ${Math.round(h.us_aqi)} (${aqiLabel(h.us_aqi)})`);
  if (h.tide_m != null) parts.push(`tide ${h.tide_m.toFixed(1)} m`);
  return parts.length ? parts.join(" · ") : "No conditions yet";
}

/** Display ceiling for each factor (spec §3.5), so bars are comparable. */
export const FACTOR_MAX: Record<Exclude<keyof Factors, "p_rich_model">, number> = {
  p_rich: 1, comfort: 1, tide_fit: 1, light_bonus: 1.3, novelty: 1.3, availability: 1.5,
};

export function barPct(key: keyof typeof FACTOR_MAX, value: number): number {
  return Math.max(0, Math.min(100, (value / FACTOR_MAX[key]) * 100));
}

/** VAPID public key (base64url) → bytes for PushManager.subscribe. */
export function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const s = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
