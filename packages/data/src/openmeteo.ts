import { z } from "zod";
import type { ConditionsHour, Spot } from "@sitspot/shared";
import { getJson, type FetchOpts } from "./http.js";

const WEATHER_VARS = ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "wind_speed_10m", "precipitation", "cloud_cover"] as const;
const AIR_VARS = ["pm2_5", "pm10", "us_aqi"] as const;
const MARINE_VARS = ["sea_level_height_msl"] as const;

export type Hourly<V extends string> = Array<{ time: Date } & Record<V, number | null>>;

const Response = z.object({
  utc_offset_seconds: z.number(),
  hourly: z.object({ time: z.array(z.string()) }).catchall(z.array(z.number().nullable())),
});

/** Parse an Open-Meteo hourly block. Times come back as local wall-clock without offset; we request
 *  timezone=GMT so offset is 0, but still apply utc_offset_seconds so any timezone stays correct. */
export function parseHourly<V extends string>(json: unknown, vars: readonly V[]): Hourly<V> {
  const { utc_offset_seconds, hourly } = Response.parse(json);
  return hourly.time.map((t, i) => {
    const row: Record<string, unknown> = { time: new Date(Date.parse(`${t}Z`) - utc_offset_seconds * 1000) };
    for (const v of vars) {
      const col = hourly[v];
      if (!Array.isArray(col)) throw new Error(`Open-Meteo response missing hourly.${v}`);
      row[v] = col[i] ?? null;
    }
    return row as { time: Date } & Record<V, number | null>;
  });
}

async function openMeteo<V extends string>(base: string, lat: number, lon: number, vars: readonly V[], extra: string, opts: FetchOpts) {
  const url = `${base}?latitude=${lat}&longitude=${lon}&hourly=${vars.join(",")}&timezone=GMT&forecast_days=2${extra}`;
  return parseHourly(await getJson(url, opts), vars);
}

export const fetchWeather = (lat: number, lon: number, opts: FetchOpts = {}) =>
  openMeteo("https://api.open-meteo.com/v1/forecast", lat, lon, WEATHER_VARS, "&wind_speed_unit=ms", opts);

export const fetchAirQuality = (lat: number, lon: number, opts: FetchOpts = {}) =>
  openMeteo("https://air-quality-api.open-meteo.com/v1/air-quality", lat, lon, AIR_VARS, "", opts);

export const fetchMarine = (lat: number, lon: number, opts: FetchOpts = {}) =>
  openMeteo("https://marine-api.open-meteo.com/v1/marine", lat, lon, MARINE_VARS, "", opts);

/** Merge weather + air + (coastal only) marine into ConditionsHour rows on the weather time axis.
 *  Weather is required; air/marine failures degrade to null fields (sources may be missing). */
export async function fetchConditions(
  spot: Pick<Spot, "id" | "lat" | "lon" | "kind">,
  opts: FetchOpts & { now?: Date } = {},
): Promise<ConditionsHour[]> {
  const now = (opts.now ?? new Date()).getTime();
  const [weather, air, marine] = await Promise.all([
    fetchWeather(spot.lat, spot.lon, opts),
    fetchAirQuality(spot.lat, spot.lon, opts).catch(() => []),
    spot.kind === "coastal" ? fetchMarine(spot.lat, spot.lon, opts).catch(() => []) : Promise.resolve([]),
  ]);
  const airBy = new Map(air.map((r) => [r.time.getTime(), r]));
  const tideBy = new Map(marine.map((r) => [r.time.getTime(), r.sea_level_height_msl]));
  return weather.map((w) => {
    const t = w.time.getTime();
    const a = airBy.get(t);
    return {
      time: w.time,
      spot_id: spot.id,
      temp_c: w.temperature_2m,
      apparent_c: w.apparent_temperature,
      rh_pct: w.relative_humidity_2m,
      wind_ms: w.wind_speed_10m,
      precip_mm: w.precipitation,
      cloud_pct: w.cloud_cover,
      pm25: a?.pm2_5 ?? null,
      pm10: a?.pm10 ?? null,
      us_aqi: a?.us_aqi ?? null,
      tide_m: tideBy.get(t) ?? null,
      is_forecast: t > now,
    };
  });
}
