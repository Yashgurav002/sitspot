import { describe, expect, it } from "vitest";
import { filterPredictions } from "./client";

const preds = [
  { scientific_name: "Pycnonotus cafer", common_name: "Red-vented Bulbul", confidence: 0.93 },
  { scientific_name: "Pycnonotus goiavier", common_name: "Yellow-vented Bulbul", confidence: 0.68 },
  { scientific_name: "Corvus splendens", common_name: "House Crow", confidence: 0.3 },
];

describe("filterPredictions", () => {
  it("applies min confidence (inclusive)", () => {
    expect(filterPredictions(preds, 0.5)).toHaveLength(2);
    expect(filterPredictions(preds, 0.93)).toHaveLength(1);
  });
  it("applies the regional allow-list case-insensitively", () => {
    const out = filterPredictions(preds, 0.5, new Set(["pycnonotus CAFER", "Corvus splendens"]));
    expect(out.map((p) => p.common_name)).toEqual(["Red-vented Bulbul"]);
  });
  it("empty allow-list drops everything", () => {
    expect(filterPredictions(preds, 0, new Set())).toEqual([]);
  });
});
