// Shared contracts between web, api, workflows and packages. Mirrors SITSPOT_BUILD_SPEC.md §7.
import { z } from "zod";

export const TIMEZONE = "Asia/Kolkata";

export const SpotKind = z.enum(["home", "park", "heritage", "coastal"]);
export type SpotKind = z.infer<typeof SpotKind>;

export const SpotInput = z.object({
  name: z.string().min(1).max(80),
  kind: SpotKind,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  travel_min: z.number().int().min(0).max(180).default(10),
});
export type SpotInput = z.infer<typeof SpotInput>;

export const Spot = SpotInput.extend({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  created_at: z.coerce.date(),
});
export type Spot = z.infer<typeof Spot>;

export const User = z.object({
  id: z.string().uuid(),
  email: z.string(),
  timezone: z.string().default(TIMEZONE),
  quiet_start: z.string(), // "HH:MM" or "HH:MM:SS" local time
  quiet_end: z.string(),
  threshold: z.number(),
});
export type User = z.infer<typeof User>;

/** One hour of conditions for one spot. All fields nullable: a source may be missing. */
export const ConditionsHour = z.object({
  time: z.coerce.date(),
  spot_id: z.string().uuid(),
  temp_c: z.number().nullable(),
  apparent_c: z.number().nullable(),
  rh_pct: z.number().nullable(),
  wind_ms: z.number().nullable(),
  precip_mm: z.number().nullable(),
  cloud_pct: z.number().nullable(),
  pm25: z.number().nullable(),
  pm10: z.number().nullable(),
  us_aqi: z.number().nullable(),
  tide_m: z.number().nullable(),
  is_forecast: z.boolean(),
});
export type ConditionsHour = z.infer<typeof ConditionsHour>;

export const Sighting = z.object({
  time: z.coerce.date(),
  checklist_id: z.string().nullable(),
  loc_id: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  species_code: z.string(),
  common_name: z.string().nullable(),
  how_many: z.number().int().nullable(),
});
export type Sighting = z.infer<typeof Sighting>;

export const Forecast = z.object({
  time: z.coerce.date(),
  spot_id: z.string().uuid(),
  p_rich: z.number().min(0).max(1),
  model_version: z.string(),
});
export type Forecast = z.infer<typeof Forecast>;

/** Each factor of the decision score (spec §3.5). */
export const Factors = z.object({
  p_rich: z.number(),
  p_rich_model: z.string(),
  comfort: z.number(),
  tide_fit: z.number(),
  light_bonus: z.number(),
  novelty: z.number(),
  availability: z.number(),
});
export type Factors = z.infer<typeof Factors>;

export const InvitationStatus = z.enum([
  "pending", "sent", "accepted", "declined", "no_answer",
  "arrived", "completed", "missed", "cancelled",
]);
export type InvitationStatus = z.infer<typeof InvitationStatus>;

export const Channel = z.enum(["call", "push"]);
export type Channel = z.infer<typeof Channel>;

export const Invitation = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  spot_id: z.string().uuid(),
  window_start: z.coerce.date(),
  window_end: z.coerce.date(),
  score: z.number(),
  factors: Factors,
  reason: z.string(),
  script: z.string().nullable(),
  channel: Channel,
  status: InvitationStatus,
  workflow_id: z.string().nullable(),
  call_id: z.string().nullable(),
  created_at: z.coerce.date(),
  responded_at: z.coerce.date().nullable(),
});
export type Invitation = z.infer<typeof Invitation>;

export const Visit = z.object({
  id: z.string().uuid(),
  invitation_id: z.string().uuid().nullable(),
  arrived_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
  minutes: z.number().int().nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
});
export type Visit = z.infer<typeof Visit>;

export const DetectionInput = z.object({
  time: z.coerce.date(),
  species_code: z.string().min(1),
  common_name: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  model_version: z.string().min(1),
});
export type DetectionInput = z.infer<typeof DetectionInput>;
export type Detection = DetectionInput & { visit_id: string };

export const Observation = z.object({
  id: z.string().uuid(),
  visit_id: z.string().uuid().nullable(),
  user_id: z.string().uuid(),
  time: z.coerce.date(),
  text: z.string(),
});
export type Observation = z.infer<typeof Observation>;

export const FieldNote = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  date: z.string(), // YYYY-MM-DD
  body: z.string(),
  facts: z.record(z.string(), z.unknown()),
  model: z.string(),
});
export type FieldNote = z.infer<typeof FieldNote>;

export const PreferenceInput = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  source_utterance: z.string().min(1), // the user's own words, required (spec §3.7)
});
export type PreferenceInput = z.infer<typeof PreferenceInput>;
export type Preference = PreferenceInput & { id: string; user_id: string; created_at: Date };

/** Sun times for one day at one spot. */
export type SunTimes = {
  sunrise: Date;
  sunset: Date;
  goldenHourStart: Date; // evening golden hour start
  goldenHourEnd: Date; // morning golden hour end
};

/** A scored candidate window from the policy. */
export type Candidate = {
  spot_id: string;
  window_start: Date;
  window_end: Date;
  send_at: Date;
  score: number;
  factors: Factors;
  reason: string;
  safe: boolean;
  blocked_by: string[]; // safety rule ids, e.g. ["S-1"]
};
