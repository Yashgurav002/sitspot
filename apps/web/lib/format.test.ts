import { describe, expect, it } from "vitest";
import { barPct, currentHour, leaveBy, openInvitation, summarise, time, urlBase64ToUint8Array } from "./format";
import type { WInvitation } from "./api";

const now = new Date("2026-10-06T11:00:00Z");
const inv = (id: string, status: string, start: string, end: string) =>
  ({ id, status, window_start: start, window_end: end }) as WInvitation;

describe("format", () => {
  it("leaveBy subtracts travel minutes", () => {
    expect(leaveBy("2026-10-06T12:00:00Z", 15).toISOString()).toBe("2026-10-06T11:45:00.000Z");
  });

  it("formats in Asia/Kolkata", () => {
    expect(time("2026-10-06T11:35:00Z")).toMatch(/5:05\s?pm/i);
  });

  it("openInvitation picks the newest open, unexpired one", () => {
    const list = [
      inv("old", "sent", "2026-10-06T09:00:00Z", "2026-10-06T10:00:00Z"), // ended
      inv("dec", "declined", "2026-10-06T12:00:00Z", "2026-10-06T13:00:00Z"),
      inv("a", "sent", "2026-10-06T11:30:00Z", "2026-10-06T12:30:00Z"),
      inv("b", "accepted", "2026-10-06T12:00:00Z", "2026-10-06T13:00:00Z"),
    ];
    expect(openInvitation(list, now)?.id).toBe("b");
    expect(openInvitation([list[0]!, list[1]!], now)).toBeUndefined();
  });

  it("currentHour picks the closest hour", () => {
    const hours = ["10:00", "11:20", "13:00"].map((t) => ({ time: `2026-10-06T${t}:00Z` }));
    expect(currentHour(hours, now)?.time).toBe("2026-10-06T11:20:00Z");
    expect(currentHour([], now)).toBeUndefined();
  });

  it("summarise skips missing fields", () => {
    const h = { temp_c: 28.4, us_aqi: 42, tide_m: null } as never;
    expect(summarise(h)).toBe("28°C · AQI 42 (good)");
    expect(summarise(undefined)).toBe("No conditions yet");
  });

  it("barPct scales to each factor's ceiling and clamps", () => {
    expect(barPct("light_bonus", 1.3)).toBe(100);
    expect(barPct("comfort", 0.5)).toBe(50);
    expect(barPct("availability", 9)).toBe(100);
    expect(barPct("comfort", -1)).toBe(0);
  });

  it("decodes base64url VAPID keys", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID_-8"))).toEqual([1, 2, 3, 255, 239]);
  });
});
