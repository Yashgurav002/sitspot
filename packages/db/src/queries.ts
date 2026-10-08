import {
  PreferenceInput,
  type Channel,
  type ConditionsHour,
  type Detection,
  type DetectionInput,
  type Factors,
  type FieldNote,
  type Forecast,
  type Invitation,
  type InvitationStatus,
  type Observation,
  type Preference,
  type Sighting,
  type Spot,
  type SpotInput,
  type User,
  type Visit,
} from "@sitspot/shared";
import type { Db } from "./db";

// Params: jsonb goes in as `$n::text::jsonb` (JSON string) and vectors as `$n::text::vector` ('[1,2,..]')
// so both drivers send plain text. Counts are cast to int (bigint would be string/BigInt).
// ponytail: row-at-a-time upserts; batch with unnest() if ingest gets slow.

const json = (v: unknown) => JSON.stringify(v ?? null);
const vec = (e: number[] | null | undefined) => (e ? `[${e.join(",")}]` : null);
const one = <T>(rows: T[]): T | null => rows[0] ?? null;

// ---------- users ----------
const USER = "id, email, timezone, quiet_start::text as quiet_start, quiet_end::text as quiet_end, threshold";

/** Get-or-create the user row for an email (also the seeding helper). */
export async function ensureUser(db: Db, email: string): Promise<User> {
  const rows = await db.query<User>(
    `insert into users (email) values ($1) on conflict (email) do update set email = excluded.email returning ${USER}`,
    [email],
  );
  return rows[0]!;
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  return one(await db.query<User>(`select ${USER} from users where id = $1`, [id]));
}

export async function updateUserSettings(
  db: Db,
  id: string,
  s: { quiet_start?: string; quiet_end?: string; threshold?: number },
): Promise<User | null> {
  return one(
    await db.query<User>(
      `update users set quiet_start = coalesce($2::time, quiet_start), quiet_end = coalesce($3::time, quiet_end),
       threshold = coalesce($4::real, threshold) where id = $1 returning ${USER}`,
      [id, s.quiet_start ?? null, s.quiet_end ?? null, s.threshold ?? null],
    ),
  );
}

/** Learned accept factor per local hour (written by nightly reflect); {} when none yet. */
export async function getAcceptFactors(db: Db, id: string): Promise<Record<string, number>> {
  const r = one(await db.query<{ f: Record<string, number> | null }>(`select accept_factors as f from users where id = $1`, [id]));
  return r?.f ?? {};
}

export async function setAcceptFactors(db: Db, id: string, f: Record<string, number>): Promise<void> {
  await db.query(`update users set accept_factors = $2::text::jsonb where id = $1`, [id, json(f)]);
}

export async function setPushSubscription(db: Db, id: string, sub: unknown): Promise<void> {
  await db.query(`update users set push_subscription = $2::text::jsonb where id = $1`, [id, json(sub)]);
}

export async function getPushSubscription(db: Db, id: string): Promise<unknown | null> {
  const r = one(await db.query<{ s: unknown }>(`select push_subscription as s from users where id = $1`, [id]));
  return r?.s ?? null;
}

// ---------- spots ----------
const SPOT = "id, user_id, name, kind, lat, lon, travel_min, created_at";

export async function listSpots(db: Db, userId: string): Promise<Spot[]> {
  return db.query<Spot>(`select ${SPOT} from spots where user_id = $1 order by created_at, name`, [userId]);
}

export async function listAllSpots(db: Db): Promise<Spot[]> {
  return db.query<Spot>(`select ${SPOT} from spots order by created_at, name`);
}

export async function getSpot(db: Db, id: string): Promise<Spot | null> {
  return one(await db.query<Spot>(`select ${SPOT} from spots where id = $1`, [id]));
}

export async function createSpot(db: Db, userId: string, s: SpotInput): Promise<Spot> {
  const rows = await db.query<Spot>(
    `insert into spots (user_id, name, kind, lat, lon, travel_min) values ($1,$2,$3,$4,$5,$6) returning ${SPOT}`,
    [userId, s.name, s.kind, s.lat, s.lon, s.travel_min ?? 10],
  );
  return rows[0]!;
}

export async function updateSpot(db: Db, id: string, p: Partial<SpotInput>): Promise<Spot | null> {
  return one(
    await db.query<Spot>(
      `update spots set name = coalesce($2, name), kind = coalesce($3, kind), lat = coalesce($4::float8, lat),
       lon = coalesce($5::float8, lon), travel_min = coalesce($6::int, travel_min) where id = $1 returning ${SPOT}`,
      [id, p.name ?? null, p.kind ?? null, p.lat ?? null, p.lon ?? null, p.travel_min ?? null],
    ),
  );
}

export async function deleteSpot(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from spots where id = $1 returning id`, [id])).length > 0;
}

// ---------- conditions ----------
const COND_COLS = [
  "temp_c", "apparent_c", "rh_pct", "wind_ms", "precip_mm", "cloud_pct",
  "pm25", "pm10", "us_aqi", "tide_m", "is_forecast",
] as const;

export async function upsertConditions(db: Db, rows: ConditionsHour[]): Promise<void> {
  const cols = ["time", "spot_id", ...COND_COLS];
  const sql = `insert into conditions (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})
    on conflict (spot_id, time) do update set ${COND_COLS.map((c) => `${c} = excluded.${c}`).join(", ")}`;
  for (const r of rows) await db.query(sql, cols.map((c) => r[c as keyof ConditionsHour] ?? null));
}

export async function getConditions(db: Db, spotId: string, from: Date, to: Date): Promise<ConditionsHour[]> {
  return db.query<ConditionsHour>(
    `select time, spot_id, ${COND_COLS.join(", ")} from conditions
     where spot_id = $1 and time >= $2 and time < $3 order by time`,
    [spotId, from, to],
  );
}

// ---------- sightings ----------
export async function upsertSightings(db: Db, rows: Sighting[]): Promise<void> {
  for (const r of rows)
    await db.query(
      `insert into sightings (time, checklist_id, loc_id, lat, lon, species_code, common_name, how_many)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (loc_id, species_code, time) do update set
       checklist_id = excluded.checklist_id, lat = excluded.lat, lon = excluded.lon,
       common_name = excluded.common_name, how_many = excluded.how_many`,
      [r.time, r.checklist_id, r.loc_id, r.lat, r.lon, r.species_code, r.common_name, r.how_many],
    );
}

/** Sightings within `km` (haversine) of a point since `since`, newest first. */
export async function recentSightingsNear(
  db: Db,
  lat: number,
  lon: number,
  km: number,
  since: Date,
): Promise<Sighting[]> {
  return db.query<Sighting>(
    `select time, checklist_id, loc_id, lat, lon, species_code, common_name, how_many from sightings
     where time >= $4 and lat is not null and lon is not null
       and 2 * 6371 * asin(sqrt(power(sin(radians(lat - $1::float8) / 2), 2)
           + cos(radians($1::float8)) * cos(radians(lat)) * power(sin(radians(lon - $2::float8) / 2), 2))) <= $3::float8
     order by time desc`,
    [lat, lon, km, since],
  );
}

// ---------- forecasts ----------
export async function upsertForecasts(db: Db, rows: Forecast[]): Promise<void> {
  for (const r of rows)
    await db.query(
      `insert into forecasts (time, spot_id, p_rich, model_version) values ($1,$2,$3,$4)
       on conflict (spot_id, time, model_version) do update set p_rich = excluded.p_rich, created_at = now()`,
      [r.time, r.spot_id, r.p_rich, r.model_version],
    );
}

/** One forecast per hour: the most recently created model_version. */
export async function latestForecasts(db: Db, spotId: string, from: Date, to: Date): Promise<Forecast[]> {
  return db.query<Forecast>(
    `select distinct on (time) time, spot_id, p_rich, model_version from forecasts
     where spot_id = $1 and time >= $2 and time < $3 order by time, created_at desc`,
    [spotId, from, to],
  );
}

// ---------- invitations ----------
const INV = `id, user_id, spot_id, window_start, window_end, score, factors, reason, script, channel, status,
  workflow_id, call_id, created_at, responded_at`;

export type InvitationInput = {
  user_id: string;
  spot_id: string;
  window_start: Date;
  window_end: Date;
  score: number;
  factors: Factors;
  reason: string;
  channel?: Channel;
  status?: InvitationStatus;
  script?: string | null;
  workflow_id?: string | null;
};

export async function createInvitation(db: Db, i: InvitationInput): Promise<Invitation> {
  const rows = await db.query<Invitation>(
    `insert into invitations (user_id, spot_id, window_start, window_end, score, factors, reason, channel, status, script, workflow_id)
     values ($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9,$10,$11) returning ${INV}`,
    [
      i.user_id, i.spot_id, i.window_start, i.window_end, i.score, json(i.factors), i.reason,
      i.channel ?? "call", i.status ?? "pending", i.script ?? null, i.workflow_id ?? null,
    ],
  );
  return rows[0]!;
}

export async function getInvitation(db: Db, id: string): Promise<Invitation | null> {
  return one(await db.query<Invitation>(`select ${INV} from invitations where id = $1`, [id]));
}

export async function listInvitations(db: Db, userId: string, status?: InvitationStatus): Promise<Invitation[]> {
  return db.query<Invitation>(
    `select ${INV} from invitations where user_id = $1 and ($2::text is null or status = $2) order by created_at desc`,
    [userId, status ?? null],
  );
}

export async function setInvitationStatus(
  db: Db,
  id: string,
  status: InvitationStatus,
  extra: { script?: string; call_id?: string; workflow_id?: string; channel?: Channel; responded_at?: Date } = {},
): Promise<Invitation | null> {
  return one(
    await db.query<Invitation>(
      `update invitations set status = $2, script = coalesce($3, script), call_id = coalesce($4, call_id),
       workflow_id = coalesce($5, workflow_id), channel = coalesce($6, channel),
       responded_at = coalesce($7::timestamptz, responded_at) where id = $1 returning ${INV}`,
      [id, status, extra.script ?? null, extra.call_id ?? null, extra.workflow_id ?? null,
        extra.channel ?? null, extra.responded_at ?? null],
    ),
  );
}

/** All invitations created at/after `since` (any status). */
export async function countInvitationsSince(db: Db, userId: string, since: Date): Promise<number> {
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from invitations where user_id = $1 and created_at >= $2`,
    [userId, since],
  );
  return r[0]!.n;
}

export async function lastDeclineAt(db: Db, userId: string): Promise<Date | null> {
  const r = await db.query<{ t: Date | null }>(
    `select max(coalesce(responded_at, created_at)) as t from invitations where user_id = $1 and status = 'declined'`,
    [userId],
  );
  return r[0]?.t ?? null;
}

/** Newest invitation still in flight (pending / sent / accepted / arrived). */
export async function openInvitation(db: Db, userId: string): Promise<Invitation | null> {
  return one(
    await db.query<Invitation>(
      `select ${INV} from invitations where user_id = $1 and status in ('pending','sent','accepted','arrived')
       order by created_at desc limit 1`,
      [userId],
    ),
  );
}

// ---------- visits ----------
const VISIT = "id, invitation_id, arrived_at, ended_at, minutes, rating";

export async function createVisit(db: Db, invitationId: string | null): Promise<Visit> {
  const rows = await db.query<Visit>(
    `insert into visits (invitation_id, arrived_at) values ($1, now()) returning ${VISIT}`,
    [invitationId],
  );
  return rows[0]!;
}

export async function getVisit(db: Db, id: string): Promise<Visit | null> {
  return one(await db.query<Visit>(`select ${VISIT} from visits where id = $1`, [id]));
}

export async function getVisitByInvitation(db: Db, invitationId: string): Promise<Visit | null> {
  return one(await db.query<Visit>(`select ${VISIT} from visits where invitation_id = $1`, [invitationId]));
}

export async function endVisit(db: Db, id: string, rating: number | null): Promise<Visit | null> {
  return one(
    await db.query<Visit>(
      `update visits set ended_at = now(), rating = $2,
       minutes = round(extract(epoch from now() - arrived_at) / 60)::int where id = $1 returning ${VISIT}`,
      [id, rating],
    ),
  );
}

// ---------- detections ----------
/** Idempotent: duplicates on (visit_id, time, species_code) are ignored. Returns rows actually inserted. */
export async function insertDetections(db: Db, visitId: string, rows: DetectionInput[]): Promise<number> {
  let n = 0;
  for (const d of rows) {
    const r = await db.query(
      `insert into detections (time, visit_id, species_code, common_name, confidence, model_version)
       values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning visit_id`,
      [d.time, visitId, d.species_code, d.common_name ?? null, d.confidence, d.model_version],
    );
    n += r.length;
  }
  return n;
}

export async function listDetections(db: Db, visitId: string): Promise<Detection[]> {
  return db.query<Detection>(
    `select time, visit_id, species_code, common_name, confidence, model_version from detections
     where visit_id = $1 order by time`,
    [visitId],
  );
}

// ---------- observations ----------
export async function addObservation(
  db: Db,
  o: { visit_id: string | null; user_id: string; text: string; embedding?: number[] | null },
): Promise<Observation> {
  const rows = await db.query<Observation>(
    `insert into observations (visit_id, user_id, text, embedding) values ($1,$2,$3,$4::text::vector)
     returning id, visit_id, user_id, time, text`,
    [o.visit_id, o.user_id, o.text, vec(o.embedding)],
  );
  return rows[0]!;
}

export async function listObservations(db: Db, visitId: string): Promise<Observation[]> {
  return db.query<Observation>(
    `select id, visit_id, user_id, time, text from observations where visit_id = $1 order by time`,
    [visitId],
  );
}

// ---------- field notes ----------
const NOTE = "id, user_id, date::text as date, body, facts, model";

export async function insertNote(
  db: Db,
  n: { user_id: string; date: string; body: string; facts: Record<string, unknown>; model: string; embedding?: number[] | null },
): Promise<FieldNote> {
  const rows = await db.query<FieldNote>(
    `insert into field_notes (user_id, date, body, facts, model, embedding)
     values ($1,$2::date,$3,$4::text::jsonb,$5,$6::text::vector) returning ${NOTE}`,
    [n.user_id, n.date, n.body, json(n.facts), n.model, vec(n.embedding)],
  );
  return rows[0]!;
}

export async function getNotes(db: Db, userId: string, date?: string): Promise<FieldNote[]> {
  return db.query<FieldNote>(
    `select ${NOTE} from field_notes where user_id = $1 and ($2::date is null or date = $2::date) order by date desc`,
    [userId, date ?? null],
  );
}

/** Hybrid keyword + vector search fused with reciprocal rank fusion (spec §7). Keyword-only if no embedding. */
export async function searchNotes(
  db: Db,
  userId: string,
  q: string,
  embedding: number[] | null,
): Promise<(FieldNote & { rrf: number })[]> {
  const kw = `select id, row_number() over (order by ts_rank_cd(body_tsv, q.tsq) desc) as r
    from field_notes, q
    where user_id = $2 and body_tsv @@ q.tsq
    order by ts_rank_cd(body_tsv, q.tsq) desc
    limit 20`;
  const vecCte = `select id, row_number() over (order by embedding <=> $3::text::vector) as r
    from (select id, embedding from field_notes where user_id = $2 and embedding is not null
          order by embedding <=> $3::text::vector limit 20) s`;
  const sql = `with q as (select plainto_tsquery('english', $1) as tsq),
    kw as (${kw})${embedding ? `, vec as (${vecCte})` : ""},
    fused as (
      select id, sum(1.0 / (60 + r))::float8 as rrf
      from (select * from kw${embedding ? " union all select * from vec" : ""}) t
      group by id order by rrf desc limit 5
    )
    select n.id, n.user_id, n.date::text as date, n.body, n.facts, n.model, f.rrf
    from fused f join field_notes n on n.id = f.id order by f.rrf desc`;
  return db.query(sql, embedding ? [q, userId, vec(embedding)] : [q, userId]);
}

// ---------- preferences ----------
/** Rejects (throws) when source_utterance is missing/empty: memory needs the user's own words. */
export async function addPreference(db: Db, userId: string, p: PreferenceInput): Promise<Preference> {
  const v = PreferenceInput.parse(p);
  if (!v.source_utterance.trim()) throw new Error("source_utterance required");
  const rows = await db.query<Preference>(
    `insert into preferences (user_id, key, value, source_utterance) values ($1,$2,$3::text::jsonb,$4)
     returning id, user_id, key, value, source_utterance, created_at`,
    [userId, v.key, json(v.value), v.source_utterance],
  );
  return rows[0]!;
}

export async function listPreferences(db: Db, userId: string): Promise<Preference[]> {
  return db.query<Preference>(
    `select id, user_id, key, value, source_utterance, created_at from preferences where user_id = $1 order by created_at`,
    [userId],
  );
}

export async function deletePreference(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from preferences where id = $1 returning id`, [id])).length > 0;
}

// ---------- agent runs ----------
export async function logAgentRun(
  db: Db,
  r: {
    invitation_id?: string | null;
    kind: string;
    model: string;
    tokens_in?: number | null;
    tokens_out?: number | null;
    latency_ms?: number | null;
    trace_id?: string | null;
    summary?: unknown;
  },
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into agent_runs (invitation_id, kind, model, tokens_in, tokens_out, latency_ms, trace_id, summary)
     values ($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb) returning id`,
    [r.invitation_id ?? null, r.kind, r.model, r.tokens_in ?? null, r.tokens_out ?? null, r.latency_ms ?? null,
      r.trace_id ?? null, r.summary === undefined ? null : json(r.summary)],
  );
  return rows[0]!.id;
}

export async function findAgentRun(db: Db, kind: string, traceId: string): Promise<{ id: string; summary: unknown } | null> {
  return one(await db.query<{ id: string; summary: unknown }>(
    `select id, summary from agent_runs where kind = $1 and trace_id = $2 order by created_at limit 1`, [kind, traceId]));
}
