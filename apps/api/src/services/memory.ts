// Long-term memory (spec §3.7, T13): preference value shapes, preferences -> policy rules, nightly reflect.
import { z } from "zod";
import * as q from "@sitspot/db";
import type { Db } from "@sitspot/db";
import { CONFIG, localHour, parseClock, type AcceptFactorByHour, type MemoryRules } from "@sitspot/policy";
import type { Preference, Spot } from "@sitspot/shared";
import { istMidnight } from "./evaluate";

const DAY = 86_400_000;
const Clock = z.string().refine((s) => parseClock(s) !== null, "expected HH:MM");
const off = { enabled: z.literal(false).optional() }; // a later {…, enabled:false} switches the rule off
const SpotRef = z.union([
  z.string().trim().min(1).transform((spot) => ({ spot })),
  z.object({ spot: z.string().trim().min(1), ...off }).strict(),
]);

/** Value shape per key the policy reads. Other keys are stored as-is and ignored by policy. */
export const PREFERENCE_VALUES = {
  spot_weekends_only: SpotRef,
  spot_avoid: SpotRef,
  avoid_hours: z.object({ start: Clock, end: Clock, ...off }).strict(),
  loves: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]),
} as const;

/** Validate + normalise a preference value for its key. */
export function parsePreferenceValue(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = PREFERENCE_VALUES[key as keyof typeof PREFERENCE_VALUES];
  if (!schema) return { ok: true, value };
  const r = schema.safeParse(value);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: `invalid value for ${key}: ${r.error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}` };
}

const norm = (s: string) => s.toLowerCase().replace(/\b(the|a|an|my|spot)\b/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Spots whose name contains the phrase (or vice versa), else share a ≥4-letter word. Case-insensitive. */
export function matchSpots<T extends Pick<Spot, "id" | "name">>(phrase: string, spots: T[]): T[] {
  const p = norm(phrase);
  if (!p) return [];
  const direct = spots.filter((s) => { const n = norm(s.name); return n.includes(p) || p.includes(n); });
  if (direct.length) return direct;
  const words = p.split(" ").filter((w) => w.length >= 4);
  return spots.filter((s) => norm(s.name).split(" ").some((w) => words.includes(w)));
}

/** Preferences -> policy rules. Latest row per key+target wins; {enabled:false} switches it off; DELETE removes it. */
export function buildRules(prefs: Pick<Preference, "key" | "value" | "source_utterance" | "created_at">[], spots: Pick<Spot, "id" | "name">[]): MemoryRules {
  const latest = new Map<string, { key: string; value: Record<string, unknown>; quote: string }>();
  const sorted = [...prefs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const p of sorted) {
    if (!(p.key in PREFERENCE_VALUES) || p.key === "loves") continue;
    const v = parsePreferenceValue(p.key, p.value); // rows written before validation existed may be malformed
    if (!v.ok) continue;
    const val = v.value as Record<string, unknown>;
    const target = p.key === "avoid_hours" ? `${val.start}-${val.end}` : norm(String(val.spot));
    latest.set(`${p.key}|${target}`, { key: p.key, value: val, quote: p.source_utterance });
  }
  const rules: Required<MemoryRules> = { weekendsOnlySpotIds: [], avoidSpotIds: [], avoidHours: [], rule_notes: {} };
  for (const { key, value, quote } of latest.values()) {
    if (value.enabled === false) continue;
    if (key === "avoid_hours") {
      const h = { start: String(value.start), end: String(value.end) };
      rules.avoidHours.push(h);
      rules.rule_notes[`avoid_hours:${h.start}-${h.end}`] = quote;
      continue;
    }
    for (const s of matchSpots(String(value.spot), spots)) {
      if (key === "spot_weekends_only") {
        rules.weekendsOnlySpotIds.push(s.id);
        rules.rule_notes[`weekends_only:${s.id}`] = quote;
      } else {
        rules.avoidSpotIds.push(s.id);
        rules.rule_notes[`avoid:${s.id}`] = quote;
      }
    }
  }
  return rules;
}

// ---------- nightly reflect ----------

export const REFLECT = {
  lookbackDays: 14,
  nudge: 0.05,
  thresholdMin: 0.2,
  thresholdMax: 0.6,
  inviteMore: { acceptRate: 0.6, rating: 4 }, // rate > 0.6 AND mean rating ≥ 4 -> threshold − 0.05
  inviteLess: { acceptRate: 0.3, rating: 2 }, // rate < 0.3 OR mean rating ≤ 2 -> threshold + 0.05
};

/** "Said yes" statuses vs "said no / didn't answer". pending/sent/cancelled carry no signal. */
const YES = new Set(["accepted", "arrived", "completed", "missed"]);
const NO = new Set(["declined", "no_answer"]);

export type ReflectRow = { status: string; window_start: Date; rating: number | null };
export type ReflectSummary = {
  day: string;
  invitations: number;
  responded: number;
  accepted: number;
  accept_rate: number | null;
  mean_rating: number | null;
  threshold_before: number;
  threshold_after: number;
  accept_factors: Record<string, number>;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pure reflect math: threshold nudge + Laplace-smoothed per-IST-hour accept factors. */
export function reflectMath(rows: ReflectRow[], threshold: number, tz = "Asia/Kolkata") {
  const responded = rows.filter((r) => YES.has(r.status) || NO.has(r.status));
  const accepted = responded.filter((r) => YES.has(r.status)).length;
  const rate = responded.length ? accepted / responded.length : null;
  const ratings = rows.map((r) => r.rating).filter((x): x is number => typeof x === "number");
  const mean = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  let next = threshold;
  const { inviteMore: m, inviteLess: l } = REFLECT;
  if (rate !== null && rate > m.acceptRate && mean !== null && mean >= m.rating) next -= REFLECT.nudge;
  else if ((rate !== null && rate < l.acceptRate) || (mean !== null && mean <= l.rating)) next += REFLECT.nudge;
  next = r2(Math.min(REFLECT.thresholdMax, Math.max(REFLECT.thresholdMin, next)));

  // (yes + 1) / (n + 2) is 0.5 with no data -> factor 1.0; maps 0..1 onto 0.5..1.5.
  const byHour = new Map<number, { yes: number; n: number }>();
  for (const r of responded) {
    const h = localHour(new Date(r.window_start), tz);
    const e = byHour.get(h) ?? { yes: 0, n: 0 };
    e.n++;
    if (YES.has(r.status)) e.yes++;
    byHour.set(h, e);
  }
  const { acceptFactorMin: lo, acceptFactorMax: hi } = CONFIG.availability;
  const factors: Record<string, number> = {};
  for (const [h, e] of [...byHour].sort((a, b) => a[0] - b[0])) factors[h] = r2(lo + (hi - lo) * ((e.yes + 1) / (e.n + 2)));
  return { threshold: next, factors, responded: responded.length, accepted, rate, mean };
}

/** IST date (YYYY-MM-DD) of the day that just ended at the midnight on/before `now`. */
const reflectDay = (now: Date) => new Date(istMidnight(now).getTime() - DAY + 5.5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Nightly reflection over the last 14 days. Idempotent per IST day via agent_runs trace_id
 * `reflect:<user>:<day>` — a second run that day returns the stored summary and changes nothing.
 * ponytail: no transaction; a crash between the writes and the agent_runs row could nudge twice on retry.
 */
export async function reflectForUser(db: Db, userId: string, now: Date): Promise<ReflectSummary> {
  const day = reflectDay(now);
  const trace = `reflect:${userId}:${day}`;
  const prior = await q.findAgentRun(db, "reflect", trace);
  if (prior) return prior.summary as ReflectSummary;
  const user = await q.getUser(db, userId);
  if (!user) throw new Error(`user ${userId} not found`);
  const rows = await db.query<ReflectRow>(
    `select i.status, i.window_start, v.rating from invitations i left join visits v on v.invitation_id = i.id
     where i.user_id = $1 and i.created_at >= $2 and i.created_at < $3`,
    [userId, new Date(now.getTime() - REFLECT.lookbackDays * DAY), now],
  );
  const m = reflectMath(rows, r2(user.threshold), user.timezone);
  if (m.threshold !== r2(user.threshold)) await q.updateUserSettings(db, userId, { threshold: m.threshold });
  await q.setAcceptFactors(db, userId, m.factors);
  const summary: ReflectSummary = {
    day, invitations: rows.length, responded: m.responded, accepted: m.accepted,
    accept_rate: m.rate === null ? null : r2(m.rate), mean_rating: m.mean === null ? null : r2(m.mean),
    threshold_before: r2(user.threshold), threshold_after: m.threshold, accept_factors: m.factors,
  };
  await q.logAgentRun(db, { kind: "reflect", model: "rules", trace_id: trace, summary });
  return summary;
}

/** Stored factors (string hour keys) -> policy shape. */
export function acceptFactorsByHour(f: Record<string, number>): AcceptFactorByHour {
  const out: AcceptFactorByHour = {};
  for (const [h, v] of Object.entries(f)) if (Number.isInteger(Number(h)) && typeof v === "number") out[Number(h)] = v;
  return out;
}
