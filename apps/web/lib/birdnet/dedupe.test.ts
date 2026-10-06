import { describe, expect, it } from "vitest";
import { dedupeDetections } from "./dedupe";

const p = (s: string, c = 0.9) => ({ scientific_name: s, common_name: s, confidence: c });

describe("dedupeDetections", () => {
  it("reports a species once per window", () => {
    let r = dedupeDetections(new Map(), [p("A"), p("B")], 0);
    expect(r.fresh.map((x) => x.scientific_name)).toEqual(["A", "B"]);
    r = dedupeDetections(r.state, [p("A")], 30_000);
    expect(r.fresh).toEqual([]);
    r = dedupeDetections(r.state, [p("A")], 59_999);
    expect(r.fresh).toEqual([]);
    r = dedupeDetections(r.state, [p("A")], 60_000);
    expect(r.fresh).toHaveLength(1);
  });
  it("is pure", () => {
    const prev = new Map([["A", 0]]);
    dedupeDetections(prev, [p("B")], 1);
    expect([...prev]).toEqual([["A", 0]]);
  });
  it("dedupes within one batch and honours a custom window", () => {
    expect(dedupeDetections(new Map(), [p("A"), p("A")], 0).fresh).toHaveLength(1);
    const r = dedupeDetections(new Map([["A", 0]]), [p("A")], 5_000, 5_000);
    expect(r.fresh).toHaveLength(1);
  });
});
