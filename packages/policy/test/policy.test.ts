import { describe, expect, it } from "vitest";
import type { Candidate, ConditionsHour, Factors, SunTimes } from "@sitspot/shared";
import {
  CONFIG, availability, comfort, coastalSafetyLine, evaluateWindows, hhmm, lightBonus, novelty,
  overlapsQuietHours, parseClock, pickInvitation, requiresSafetyLine, safetyCheck, score, sendAt,
  tideFit, tideStateAt, type EvaluateInput, type SafetyInput,
} from "../src/index.js";

const ist = (s: string) => new Date(`${s}:00+05:30`); // "2026-10-06T17:00"
const D = "2026-10-06";
const at = (hm: string, day = D) => ist(`${day}T${hm}`);
const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

const sun: SunTimes = {
  sunrise: at("06:20"), goldenHourEnd: at("07:00"), goldenHourStart: at("17:30"), sunset: at("18:10"),
};

describe("comfort", () => {
  it("temperature: 1 at ≤30, linear to 0 at 38", () => {
    expect(comfort(25, null, null)).toBe(1);
    expect(comfort(30, null, null)).toBe(1);
    expect(comfort(34, null, null)).toBeCloseTo(0.5);
    expect(comfort(36, null, null)).toBeCloseTo(0.25);
    expect(comfort(38, null, null)).toBe(0);
    expect(comfort(45, null, null)).toBe(0);
  });
  it("AQI: 1 at ≤100, 0.5 at 150, 0 at ≥200, linear between", () => {
    expect(comfort(25, 100, 0)).toBe(1);
    expect(comfort(25, 125, 0)).toBeCloseTo(0.75);
    expect(comfort(25, 150, 0)).toBeCloseTo(0.5);
    expect(comfort(25, 175, 0)).toBeCloseTo(0.25);
    expect(comfort(25, 199, 0)).toBeCloseTo(0.01);
    expect(comfort(25, 200, 0)).toBe(0);
    expect(comfort(25, 350, 0)).toBe(0);
  });
  it("precip: 0 when > 2 mm, unaffected at exactly 2", () => {
    expect(comfort(25, 50, 2)).toBe(1);
    expect(comfort(25, 50, 2.01)).toBe(0);
  });
  it("multiplies temperature and AQI", () => {
    expect(comfort(34, 150, 0)).toBeCloseTo(0.25);
  });
  it("nulls never crash: missing AQI/precip -> 1, missing temp -> 0.5", () => {
    expect(comfort(null, null, null)).toBe(0.5);
    expect(comfort(NaN, NaN, NaN)).toBe(0.5);
    expect(comfort(28, null, null)).toBe(1);
  });
});

describe("tideFit", () => {
  it("non-coastal is always 1", () => {
    expect(tideFit("park", null)).toBe(1);
    expect(tideFit("home", { trend: "rising", hoursToLow: 0, minutesToNearestHigh: 0 })).toBe(1);
  });
  it("coastal values", () => {
    expect(tideFit("coastal", null)).toBe(0);
    expect(tideFit("coastal", { trend: "falling", hoursToLow: 2, minutesToNearestHigh: 240 })).toBe(1);
    expect(tideFit("coastal", { trend: "falling", hoursToLow: 1, minutesToNearestHigh: 300 })).toBe(1);
    expect(tideFit("coastal", { trend: "falling", hoursToLow: 3, minutesToNearestHigh: 180 })).toBe(1);
    expect(tideFit("coastal", { trend: "falling", hoursToLow: 0.5, minutesToNearestHigh: 300 })).toBe(0.6);
    expect(tideFit("coastal", { trend: "rising", hoursToLow: 0.5, minutesToNearestHigh: 300 })).toBe(0.6);
    expect(tideFit("coastal", { trend: "rising", hoursToLow: 2, minutesToNearestHigh: 200 })).toBe(0.2);
    expect(tideFit("coastal", { trend: "falling", hoursToLow: 3.5, minutesToNearestHigh: 120 })).toBe(0.2);
    expect(tideFit("coastal", { trend: "falling", hoursToLow: 2, minutesToNearestHigh: 60 })).toBe(0);
    expect(tideFit("coastal", { trend: "falling", hoursToLow: 2, minutesToNearestHigh: 61 })).toBe(1);
    expect(tideFit("coastal", { trend: "falling", hoursToLow: 2, minutesToNearestHigh: NaN })).toBe(0);
  });
  it("tideStateAt derives trend and distances", () => {
    const ev = { lows: [{ time: at("17:20"), tide_m: 0.4 }], highs: [{ time: at("11:00"), tide_m: 4 }, { time: at("23:30"), tide_m: 4 }] };
    expect(tideStateAt(at("15:20"), ev)).toEqual({ trend: "falling", hoursToLow: 2, minutesToNearestHigh: 260 });
    expect(tideStateAt(at("18:20"), ev)?.trend).toBe("rising");
    expect(tideStateAt(at("23:59"), ev)?.trend).toBe("falling"); // only a past high
    expect(tideStateAt(at("12:00"), { lows: [], highs: [] })).toBeNull();
  });
});

describe("lightBonus", () => {
  it("1.0 outside golden hours", () => expect(lightBonus(at("12:00"), sun)).toBe(1));
  it("1.3 for a window fully inside", () => expect(lightBonus(at("17:30"), sun, 30)).toBeCloseTo(1.3));
  it("proportional to overlap", () => {
    expect(lightBonus(at("17:00"), sun)).toBeCloseTo(1.15); // 17:30-18:00 of 17:00-18:00
    expect(lightBonus(at("06:00"), sun)).toBeCloseTo(1 + 0.3 * 40 / 60); // 06:20-07:00
    expect(lightBonus(at("17:30"), sun)).toBeCloseTo(1 + 0.3 * 40 / 60); // until sunset 18:10
  });
  it("null sun -> 1", () => expect(lightBonus(at("17:30"), null)).toBe(1));
});

describe("novelty", () => {
  it("boolean and count forms", () => {
    expect(novelty(false)).toBe(1);
    expect(novelty(true)).toBe(1.3);
    expect(novelty(0)).toBe(1);
    expect(novelty(1)).toBeCloseTo(1.15);
    expect(novelty(2)).toBeCloseTo(1.3);
    expect(novelty(50)).toBe(1.3);
    expect(novelty(-1)).toBe(1);
    expect(novelty(null)).toBe(1);
  });
});

describe("quiet hours (IST, midnight wrap)", () => {
  const q = (s: string, e: string, from: Date, to: Date) => overlapsQuietHours(from, to, s, e, "Asia/Kolkata");
  it("22:00–07:00 wraps midnight", () => {
    expect(q("22:00", "07:00", at("21:00"), at("22:00"))).toBe(false); // ends exactly at start
    expect(q("22:00", "07:00", at("21:30"), at("22:01"))).toBe(true);
    expect(q("22:00", "07:00", at("23:30"), at("00:30", "2026-10-07"))).toBe(true);
    expect(q("22:00", "07:00", at("03:00"), at("04:00"))).toBe(true);
    expect(q("22:00", "07:00", at("06:59"), at("07:30"))).toBe(true);
    expect(q("22:00", "07:00", at("07:00"), at("08:00"))).toBe(false); // starts exactly at end
    expect(q("22:00", "07:00", at("12:00"), at("13:00"))).toBe(false);
  });
  it("non-wrapping range, HH:MM:SS, empty and invalid", () => {
    expect(q("13:00:00", "14:00:00", at("12:30"), at("13:30"))).toBe(true);
    expect(q("13:00", "14:00", at("14:00"), at("15:00"))).toBe(false);
    expect(q("07:00", "07:00", at("07:00"), at("08:00"))).toBe(false);
    expect(q("garbage", "07:00", at("12:00"), at("13:00"))).toBe(true); // fail closed
    expect(q("25:00", "07:00", at("12:00"), at("13:00"))).toBe(true);
  });
  it("uses IST, not UTC (21:00 UTC = 02:30 IST)", () => {
    const t = new Date("2026-10-06T21:00:00Z");
    expect(q("22:00", "07:00", t, addMin(t, 60))).toBe(true);
    const u = new Date("2026-10-06T06:30:00Z"); // 12:00 IST
    expect(q("22:00", "07:00", u, addMin(u, 60))).toBe(false);
  });
  it("parseClock", () => {
    expect(parseClock("07:30")).toBe(450);
    expect(parseClock("7:05:30")).toBe(425.5);
    expect(parseClock("24:00")).toBeNull();
  });
});

describe("availability", () => {
  const base = {
    now: at("10:00"), window_start: at("12:00"), window_end: at("13:00"),
    quiet_start: "22:00", quiet_end: "07:00", invitesToday: 0, lastDeclineAt: null, hasOpenInvitation: false,
  };
  it("1 by default", () => expect(availability(base)).toBe(1));
  it("2/day cap", () => {
    expect(availability({ ...base, invitesToday: 1 })).toBe(1);
    expect(availability({ ...base, invitesToday: 2 })).toBe(0);
    expect(availability({ ...base, invitesToday: 3 })).toBe(0);
  });
  it("3 h decline cooldown (relative to now)", () => {
    expect(availability({ ...base, lastDeclineAt: addMin(base.now, -179) })).toBe(0);
    expect(availability({ ...base, lastDeclineAt: addMin(base.now, -180) })).toBe(1);
    expect(availability({ ...base, lastDeclineAt: addMin(base.now, 5) })).toBe(0);
  });
  it("open invitation blocks", () => expect(availability({ ...base, hasOpenInvitation: true })).toBe(0));
  it("quiet hours block, including send_at", () => {
    expect(availability({ ...base, window_start: at("23:00"), window_end: at("00:00", "2026-10-07") })).toBe(0);
    expect(availability({ ...base, window_start: at("07:00"), window_end: at("08:00") })).toBe(1);
    expect(availability({ ...base, window_start: at("07:00"), window_end: at("08:00"), send_at: at("06:40") })).toBe(0);
  });
  it("accept factor by IST hour, clamped", () => {
    expect(availability({ ...base, acceptFactorByHour: { 12: 1.2 } })).toBe(1.2);
    expect(availability({ ...base, acceptFactorByHour: { 12: 9 } })).toBe(1.5);
    expect(availability({ ...base, acceptFactorByHour: { 12: 0.1 } })).toBe(0.5);
    expect(availability({ ...base, acceptFactorByHour: { 6: 0.1 } })).toBe(1);
    expect(availability({ ...base, hasOpenInvitation: true, acceptFactorByHour: { 12: 1.5 } })).toBe(0);
  });
});

describe("safetyCheck", () => {
  const base: SafetyInput = {
    kind: "coastal", window_start: at("15:00"), window_end: at("16:00"), sun,
    highTides: [at("10:00"), at("22:30")], apparent_c: 30, us_aqi: 80, quiet_start: "22:00", quiet_end: "07:00",
  };
  it("passes a good coastal window", () => expect(safetyCheck(base)).toEqual({ ok: true, blocked_by: [] }));
  it("S-1 sunset − 30 / sunrise", () => {
    expect(safetyCheck({ ...base, window_start: at("16:40"), window_end: at("17:40") }).ok).toBe(true); // ends 17:40 = sunset−30
    expect(safetyCheck({ ...base, window_start: at("16:41"), window_end: at("17:41") }).blocked_by).toEqual(["S-1"]);
    expect(safetyCheck({ ...base, window_start: at("06:20"), window_end: at("07:20"), quiet_end: "06:00" }).ok).toBe(true);
    expect(safetyCheck({ ...base, window_start: at("06:19"), window_end: at("07:19"), quiet_end: "06:00" }).blocked_by).toEqual(["S-1"]);
    expect(safetyCheck({ ...base, sun: null }).blocked_by).toEqual(["S-1"]);
    expect(safetyCheck({ ...base, kind: "park", window_start: at("17:30"), window_end: at("18:30") }).ok).toBe(true);
  });
  it("S-2 high tide ± 60 min", () => {
    const w = { window_start: at("15:00"), window_end: at("16:00") };
    expect(safetyCheck({ ...base, ...w, highTides: [at("17:00")] }).ok).toBe(true); // margin starts 16:00
    expect(safetyCheck({ ...base, ...w, highTides: [at("16:59")] }).blocked_by).toEqual(["S-2"]);
    expect(safetyCheck({ ...base, ...w, highTides: [at("14:00")] }).ok).toBe(true); // margin ends 15:00
    expect(safetyCheck({ ...base, ...w, highTides: [at("14:01")] }).blocked_by).toEqual(["S-2"]);
    expect(safetyCheck({ ...base, ...w, highTides: [at("15:30")] }).blocked_by).toEqual(["S-2"]);
    expect(safetyCheck({ ...base, ...w, highTides: [] }).blocked_by).toEqual(["S-2"]); // fail closed
    expect(safetyCheck({ ...base, ...w, kind: "heritage", highTides: [at("15:30")] }).ok).toBe(true);
  });
  it("S-4 heat / AQI applies to every kind", () => {
    for (const kind of ["home", "park", "heritage", "coastal"] as const) {
      expect(safetyCheck({ ...base, kind, apparent_c: 38 }).blocked_by).toContain("S-4");
      expect(safetyCheck({ ...base, kind, us_aqi: 200 }).blocked_by).toContain("S-4");
      expect(safetyCheck({ ...base, kind, apparent_c: 37.9, us_aqi: 199 }).blocked_by).not.toContain("S-4");
      expect(safetyCheck({ ...base, kind, apparent_c: null, us_aqi: null }).blocked_by).not.toContain("S-4");
    }
  });
  it("S-5 quiet hours incl. send_at", () => {
    const p = { ...base, kind: "park" as const };
    expect(safetyCheck({ ...p, window_start: at("21:30"), window_end: at("22:30") }).blocked_by).toEqual(["S-5"]);
    expect(safetyCheck({ ...p, window_start: at("07:00"), window_end: at("08:00") }).ok).toBe(true);
    expect(safetyCheck({ ...p, window_start: at("07:00"), window_end: at("08:00"), send_at: at("06:50") }).blocked_by).toEqual(["S-5"]);
  });
  it("reports multiple rules", () => {
    expect(safetyCheck({ ...base, window_start: at("22:00"), window_end: at("23:00"), highTides: [at("22:30")], apparent_c: 40 }).blocked_by)
      .toEqual(["S-1", "S-2", "S-4", "S-5"]);
  });
  it("S-3 helpers", () => {
    expect(coastalSafetyLine).toBe("Stay on firm ground");
    expect(requiresSafetyLine("coastal")).toBe(true);
    expect(requiresSafetyLine("park")).toBe(false);
  });
});

describe("score / sendAt", () => {
  const f: Factors = { p_rich: 0.5, p_rich_model: "x", comfort: 0.8, tide_fit: 1, light_bonus: 1.3, novelty: 1, availability: 1.5 };
  it("is the product", () => expect(score(f)).toBeCloseTo(0.5 * 0.8 * 1.3 * 1.5));
  it("NaN -> 0", () => expect(score({ ...f, comfort: NaN })).toBe(0));
  it("send_at = start − travel − 10", () => {
    expect(sendAt(at("17:00"), 25)).toEqual(at("16:25"));
    expect(sendAt(at("17:00"), 0)).toEqual(at("16:50"));
  });
});

const PARK = "00000000-0000-4000-8000-000000000001";
const CREEK = "00000000-0000-4000-8000-000000000002";
function hours(spot_id: string, from: Date, n: number, over: Partial<ConditionsHour> = {}): ConditionsHour[] {
  return Array.from({ length: n }, (_, i) => ({
    time: addMin(from, i * 60), spot_id, temp_c: 28, apparent_c: 28, rh_pct: 70, wind_ms: 2, precip_mm: 0,
    cloud_pct: 20, pm25: 10, pm10: 20, us_aqi: 62, tide_m: null, is_forecast: true, ...over,
  }));
}
function input(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    now: at("12:05"),
    user: { quiet_start: "22:00", quiet_end: "07:00", timezone: "Asia/Kolkata", threshold: 0.35 },
    spots: [
      { id: PARK, name: "Park", kind: "park", travel_min: 10 },
      { id: CREEK, name: "Creek", kind: "coastal", travel_min: 25 },
    ],
    conditionsBySpot: { [PARK]: hours(PARK, at("12:00"), 8), [CREEK]: hours(CREEK, at("12:00"), 8) },
    forecastsBySpot: { [CREEK]: [{ time: at("15:00"), spot_id: CREEK, p_rich: 0.8, model_version: "tabpfn-1" }] },
    sunFor: () => sun,
    tideEventsBySpot: { [CREEK]: { lows: [{ time: at("17:20"), tide_m: 0.3 }], highs: [{ time: at("11:00"), tide_m: 4 }, { time: at("23:30"), tide_m: 4 }] } },
    lovedSightingsBySpot: {},
    history: { invitesToday: 0, lastDeclineAt: null, hasOpenInvitation: false },
    ...over,
  };
}

describe("evaluateWindows", () => {
  it("spots × 6 hourly IST-aligned windows, sorted desc", () => {
    const c = evaluateWindows(input());
    expect(c).toHaveLength(12);
    for (let i = 1; i < c.length; i++) expect(c[i - 1]!.score).toBeGreaterThanOrEqual(c[i]!.score);
    const starts = [...new Set(c.map((x) => hhmm(x.window_start)))].sort();
    expect(starts).toEqual(["13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
    for (const x of c) expect(x.window_end.getTime() - x.window_start.getTime()).toBe(3_600_000);
  });
  it("send_at, prior p_rich, reason", () => {
    const c = evaluateWindows(input());
    const creek15 = c.find((x) => x.spot_id === CREEK && hhmm(x.window_start) === "15:00")!;
    expect(creek15.send_at).toEqual(at("14:25"));
    expect(creek15.factors.p_rich).toBe(0.8);
    expect(creek15.factors.tide_fit).toBe(1); // mid 15:30, low 17:20: falling, 1.83 h before low
    expect(creek15.reason).toBe("Low tide at 17:20 and 28°C apparent with AQI 62; 80% birding chance.");
    const creek16 = c.find((x) => x.spot_id === CREEK && hhmm(x.window_start) === "16:00")!;
    expect(creek16.factors.tide_fit).toBe(0.6); // mid 16:30 is 50 min from low
    expect(creek16.factors.p_rich_model).toBe("prior");
    const park17 = c.find((x) => x.spot_id === PARK && hhmm(x.window_start) === "17:00")!;
    expect(park17.factors.p_rich_model).toBe("prior");
    expect(park17.send_at).toEqual(at("16:40"));
    expect(park17.reason).toBe("28°C apparent with AQI 62; golden hour starts 17:30; 50% birding chance (prior).");
    // deterministic
    expect(evaluateWindows(input()).map((x) => x.reason)).toEqual(c.map((x) => x.reason));
  });
  it("coastal evening windows are blocked by S-1", () => {
    const c = evaluateWindows(input());
    const creek17 = c.find((x) => x.spot_id === CREEK && hhmm(x.window_start) === "17:00")!;
    expect(creek17.safe).toBe(false);
    expect(creek17.blocked_by).toContain("S-1");
  });
  it("missing conditions -> comfort 0.5, no crash", () => {
    const c = evaluateWindows(input({ conditionsBySpot: {} }));
    expect(c.every((x) => x.factors.comfort === 0.5)).toBe(true);
    expect(c.find((x) => x.spot_id === PARK)!.reason).toMatch(/^No weather data;/);
  });
  it("falls back to air temp when apparent missing (S-4 still applies)", () => {
    const c = evaluateWindows(input({ conditionsBySpot: { [PARK]: hours(PARK, at("12:00"), 8, { apparent_c: null, temp_c: 39 }) } }));
    expect(c.filter((x) => x.spot_id === PARK).every((x) => x.blocked_by.includes("S-4"))).toBe(true);
  });
});

describe("pickInvitation", () => {
  it("picks the best safe candidate", () => {
    const inp = input();
    const p = pickInvitation(evaluateWindows(inp), 0.35, inp.now)!;
    expect(p.spot_id).toBe(CREEK);
    expect(hhmm(p.window_start)).toBe("15:00");
    expect(p.safe).toBe(true);
  });
  it("null when history blocks", () => {
    for (const history of [
      { invitesToday: 2, lastDeclineAt: null, hasOpenInvitation: false },
      { invitesToday: 0, lastDeclineAt: at("10:00"), hasOpenInvitation: false },
      { invitesToday: 0, lastDeclineAt: null, hasOpenInvitation: true },
    ]) {
      const inp = input({ history });
      expect(pickInvitation(evaluateWindows(inp), 0.35, inp.now)).toBeNull();
    }
  });
  it("null when threshold too high", () => {
    const inp = input();
    expect(pickInvitation(evaluateWindows(inp), 5, inp.now)).toBeNull();
  });
  it("rejects unsafe, unavailable, past send_at", () => {
    const f: Factors = { p_rich: 1, p_rich_model: "m", comfort: 1, tide_fit: 1, light_bonus: 1, novelty: 1, availability: 1 };
    const mk = (o: Partial<Candidate>): Candidate => ({
      spot_id: PARK, window_start: at("14:00"), window_end: at("15:00"), send_at: at("13:50"),
      score: 1, factors: f, reason: "", safe: true, blocked_by: [], ...o,
    });
    const now = at("12:00");
    expect(pickInvitation([mk({ safe: false, blocked_by: ["S-4"] })], 0.35, now)).toBeNull();
    expect(pickInvitation([mk({ blocked_by: ["S-5"] })], 0.35, now)).toBeNull();
    expect(pickInvitation([mk({ factors: { ...f, availability: 0 } })], 0.35, now)).toBeNull();
    expect(pickInvitation([mk({ send_at: at("11:59") })], 0.35, now)).toBeNull();
    expect(pickInvitation([mk({ score: 0.34 })], 0.35, now)).toBeNull();
    expect(pickInvitation([mk({ score: 0.35 })], 0.35, now)).not.toBeNull();
    expect(pickInvitation([mk({ score: 0.5 }), mk({ score: 0.9, spot_id: CREEK })], 0.35, now)!.spot_id).toBe(CREEK);
  });
  it("default threshold constant", () => expect(CONFIG.defaultThreshold).toBe(0.35));
});
