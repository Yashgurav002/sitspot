import { describe, expect, it } from "vitest";
import { parseLabel, parseLabels } from "./labels";

describe("labels", () => {
  it("splits on the first underscore only", () => {
    expect(parseLabel("Pycnonotus cafer_Red-vented Bulbul")).toEqual({ scientific_name: "Pycnonotus cafer", common_name: "Red-vented Bulbul" });
    expect(parseLabel("Foo bar_Odd_Name ")).toEqual({ scientific_name: "Foo bar", common_name: "Odd_Name" });
  });
  it("handles labels without a common name", () => {
    expect(parseLabel("Engine")).toEqual({ scientific_name: "Engine", common_name: "Engine" });
  });
  it("parses json arrays and txt files alike", () => {
    expect(parseLabels("A a_X\r\nB b_Y\n\n")).toEqual(parseLabels(["A a_X", "B b_Y"]));
    expect(parseLabels(["A a_X"])).toHaveLength(1);
  });
});
