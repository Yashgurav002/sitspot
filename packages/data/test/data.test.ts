import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { ConditionsHour, Sighting } from "@sitspot/shared";
import {
  clearCache, fetchAirQuality, fetchConditions, fetchMarine, fetchRecentSightings, fetchWeather,
  hoursToHighTide, hoursToLowTide, isGoldenHour, minutesFromSunrise, minutesToSunset,
  nextHighTide, nextLowTide, parseHourly, parseObsDt, sunTimes, tideTrend, type FetchFn,
} from "../src/index.js";

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const LAT = 19.37, LON = 72.81;
const SPOT = { id: "00000000-0000-4000-8000-000000000001", lat: LAT, lon: LON };

/** Fake fetch: routes by host, records calls. */
function fakeFetch(routes: Record<string, unknown>, calls: { url: string; headers?: HeadersInit }[] = []): FetchFn {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as FetchFn;
}
const OM = { "//api.open-meteo.com": fx("weather"), "air-quality-api": fx("air"), "marine-api": fx("marine_creek") };

beforeEach(() => clearCache());

describe("Open-Meteo clients (real recorded fixtures)", () => {
  it("parses weather with UTC times, 48 hours, correct request params", async () => {
    const calls: { url: string }[] = [];
    const rows = await fetchWeather(LAT, LON, { fetch: fakeFetch(OM, calls) });
    expect(rows).toHaveLength(48);
    expect(rows[0]!.time.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(rows[0]!.temperature_2m).toBe(26.8);
    expect(calls[0]!.url).toContain("wind_speed_unit=ms");
    expect(calls[0]!.url).toContain("timezone=GMT");
    expect(calls[0]!.url).toContain("forecast_days=2");
  });

  it("parses air quality and marine", async () => {
    const air = await fetchAirQuality(LAT, LON, { fetch: fakeFetch(OM) });
    expect(air[0]).toMatchObject({ pm2_5: 37.6, pm10: 51.1, us_aqi: 108 });
    const sea = await fetchMarine(LAT, LON, { fetch: fakeFetch(OM) });
    expect(sea[3]!.sea_level_height_msl).toBe(1.63);
  });

  it("applies utc_offset_seconds when a local timezone is returned", () => {
    const rows = parseHourly({ utc_offset_seconds: 19800, hourly: { time: ["2026-10-06T05:30"], x: [1] } }, ["x"]);
    expect(rows[0]!.time.toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });

  it("rejects a response missing a requested variable", () => {
    expect(() => parseHourly({ utc_offset_seconds: 0, hourly: { time: ["2026-10-06T00:00"] } }, ["x"])).toThrow(/hourly.x/);
  });

  it("throws on HTTP errors", async () => {
    await expect(fetchWeather(LAT, LON, { fetch: fakeFetch({}) })).rejects.toThrow(/HTTP 500/);
  });

  it("caches by URL within ttl; ttlMs=0 bypasses", async () => {
    const calls: { url: string }[] = [];
    const f = fakeFetch(OM, calls);
    await fetchWeather(LAT, LON, { fetch: f });
    await fetchWeather(LAT, LON, { fetch: f });
    expect(calls).toHaveLength(1);
    await fetchWeather(LAT, LON, { fetch: f, ttlMs: 0 });
    expect(calls).toHaveLength(2);
  });
});

describe("fetchConditions", () => {
  const now = new Date("2026-10-06T10:30:00Z");

  it("coastal: merges all three sources into valid ConditionsHour rows", async () => {
    const rows = await fetchConditions({ ...SPOT, kind: "coastal" }, { fetch: fakeFetch(OM), now });
    expect(rows).toHaveLength(48);
    for (const r of rows) ConditionsHour.parse(r);
    expect(rows[0]).toMatchObject({ temp_c: 26.8, apparent_c: 32.1, rh_pct: 85, wind_ms: 1.61, precip_mm: 0, cloud_pct: 4, pm25: 37.6, us_aqi: 108, tide_m: 0.57, is_forecast: false });
    expect(rows[10]!.is_forecast).toBe(false);
    expect(rows[11]!.is_forecast).toBe(true);
  });

  it("non-coastal: never calls marine, tide_m null", async () => {
    const calls: { url: string }[] = [];
    const rows = await fetchConditions({ ...SPOT, kind: "park" }, { fetch: fakeFetch(OM, calls), now });
    expect(calls.some((c) => c.url.includes("marine"))).toBe(false);
    expect(rows.every((r) => r.tide_m === null)).toBe(true);
  });

  it("air quality failure degrades to null fields", async () => {
    const rows = await fetchConditions({ ...SPOT, kind: "park" }, { fetch: fakeFetch({ "//api.open-meteo.com": fx("weather") }), now });
    expect(rows[0]).toMatchObject({ temp_c: 26.8, pm25: null, us_aqi: null });
  });
});

describe("eBird client (doc-example fixture, NOT live-verified)", () => {
  it("sends token header and maps documented fields", async () => {
    const calls: { url: string; headers?: HeadersInit }[] = [];
    const rows = await fetchRecentSightings(LAT, LON, "KEY", { fetch: fakeFetch({ "api.ebird.org": fx("ebird_recent") }, calls) });
    expect(calls[0]!.url).toBe("https://api.ebird.org/v2/data/obs/geo/recent?lat=19.37&lng=72.81&dist=5&back=7");
    expect(calls[0]!.headers).toEqual({ "X-eBirdApiToken": "KEY" });
    expect(rows).toHaveLength(3);
    for (const r of rows) Sighting.parse(r);
    expect(rows[1]).toMatchObject({ species_code: "cangoo", common_name: "Canada Goose", loc_id: "L1150539", how_many: 30, lat: 42.4663513, checklist_id: null });
  });

  it("handles missing howMany (X), subId, and date-only obsDt", async () => {
    const body = [{ speciesCode: "litegr", locId: "L1", obsDt: "2026-10-05", subId: "S123" }];
    const [r] = await fetchRecentSightings(LAT, LON, "K", { fetch: fakeFetch({ "api.ebird.org": body }) });
    expect(r).toMatchObject({ how_many: null, checklist_id: "S123", common_name: null, lat: null });
    expect(r!.time.toISOString()).toBe("2026-10-04T18:30:00.000Z");
  });

  it("obsDt is read as IST", () => {
    expect(parseObsDt("2026-10-06 07:15").toISOString()).toBe("2026-10-06T01:45:00.000Z");
  });
});

describe("sun features (Vasai)", () => {
  it("sunTimes are plausible and stable across the IST day", () => {
    const morning = sunTimes(new Date("2026-10-05T20:00:00Z"), LAT, LON); // 01:30 IST Oct 6
    const evening = sunTimes(new Date("2026-10-06T17:00:00Z"), LAT, LON); // 22:30 IST Oct 6
    expect(morning.sunrise.getTime()).toBe(evening.sunrise.getTime());
    // Mumbai early October: sunrise ~06:25 IST (00:55Z), sunset ~18:25 IST (12:55Z)
    expect(Math.abs(morning.sunrise.getTime() - Date.parse("2026-10-06T00:55:00Z"))).toBeLessThan(15 * 60_000);
    expect(Math.abs(morning.sunset.getTime() - Date.parse("2026-10-06T12:55:00Z"))).toBeLessThan(15 * 60_000);
    expect(morning.goldenHourEnd > morning.sunrise && morning.goldenHourStart < morning.sunset).toBe(true);
  });

  it("minutes from sunrise / to sunset and golden hour", () => {
    const s = sunTimes(new Date("2026-10-06T06:00:00Z"), LAT, LON);
    const t = new Date(s.sunrise.getTime() + 10 * 60_000);
    expect(minutesFromSunrise(t, LAT, LON)).toBeCloseTo(10);
    expect(minutesToSunset(new Date(s.sunset.getTime() - 30 * 60_000), LAT, LON)).toBeCloseTo(30);
    expect(isGoldenHour(t, LAT, LON)).toBe(true);
    expect(isGoldenHour(new Date("2026-10-06T06:30:00Z"), LAT, LON)).toBe(false); // noon IST
    expect(isGoldenHour(new Date(s.sunset.getTime() - 5 * 60_000), LAT, LON)).toBe(true);
    expect(isGoldenHour(new Date(s.sunset.getTime() + 30 * 60_000), LAT, LON)).toBe(false);
  });
});

describe("tide features (real marine fixture, Vasai creek grid cell)", () => {
  const rows = parseHourly(fx("marine_creek"), ["sea_level_height_msl"]).map((r) => ({ time: r.time, tide_m: r.sea_level_height_msl }));
  const at = (iso: string) => new Date(iso);

  it("trend", () => {
    expect(tideTrend(rows, at("2026-10-06T01:00:00Z"))).toBe("rising"); // 1.11 -> 1.51
    expect(tideTrend(rows, at("2026-10-06T05:30:00Z"))).toBe("falling"); // 1.15 -> 0.69
    expect(tideTrend(rows, at("2026-10-05T00:00:00Z"))).toBeNull();
    expect(tideTrend([{ time: at("2026-10-06T00:00:00Z"), tide_m: null }, { time: at("2026-10-06T01:00:00Z"), tide_m: 1 }], at("2026-10-06T00:00:00Z"))).toBeNull();
  });

  it("next low/high from local extrema", () => {
    expect(nextHighTide(rows, at("2026-10-06T00:00:00Z"))).toEqual({ time: at("2026-10-06T03:00:00Z"), tide_m: 1.63 });
    expect(nextLowTide(rows, at("2026-10-06T00:00:00Z"))).toEqual({ time: at("2026-10-06T09:00:00Z"), tide_m: -0.52 });
    expect(nextLowTide(rows, at("2026-10-06T09:30:00Z"))).toEqual({ time: at("2026-10-06T21:00:00Z"), tide_m: -0.91 });
    expect(hoursToLowTide(rows, at("2026-10-06T06:30:00Z"))).toBe(2.5);
    expect(hoursToHighTide(rows, at("2026-10-06T03:00:00Z"))).toBe(0);
    expect(nextLowTide(rows, at("2026-10-09T00:00:00Z"))).toBeNull();
    expect(hoursToHighTide([], at("2026-10-06T00:00:00Z"))).toBeNull();
  });
});

describe.runIf(process.env.LIVE === "1")("LIVE Open-Meteo (Vasai)", () => {
  it("returns 48 hourly rows with tide for a coastal spot", async () => {
    const rows = await fetchConditions({ ...SPOT, kind: "coastal" }, { ttlMs: 0 });
    expect(rows).toHaveLength(48);
    for (const r of rows) ConditionsHour.parse(r);
    expect(rows.filter((r) => r.temp_c !== null).length).toBe(48);
    expect(rows.filter((r) => r.us_aqi !== null).length).toBeGreaterThan(40);
    expect(rows.filter((r) => r.tide_m !== null).length).toBe(48);
    expect(nextLowTide(rows, rows[0]!.time)).not.toBeNull();
    expect(rows[0]!.time.getUTCHours()).toBe(0);
  }, 30_000);
});
