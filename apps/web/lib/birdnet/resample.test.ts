import { describe, expect, it } from "vitest";
import { resampleLinear } from "./resample";

describe("resampleLinear", () => {
  it("is a copy at equal rates", () => {
    const x = new Float32Array([1, 2, 3]);
    const y = resampleLinear(x, 48000);
    expect(Array.from(y)).toEqual([1, 2, 3]);
    expect(y).not.toBe(x);
  });
  it("produces 144000 samples from 3 s at 44.1 kHz", () => {
    expect(resampleLinear(new Float32Array(132300), 44100)).toHaveLength(144000);
  });
  it("interpolates linearly when upsampling", () => {
    expect(Array.from(resampleLinear(new Float32Array([0, 1]), 1, 2))).toEqual([0, 0.5, 1, 1]);
  });
  it("preserves a sine's frequency (44.1k -> 48k)", () => {
    const f = 1000, n = 44100;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / 44100));
    const y = resampleLinear(x, 44100);
    let maxErr = 0;
    for (let i = 0; i < y.length - 2; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - Math.sin((2 * Math.PI * f * i) / 48000)));
    expect(maxErr).toBeLessThan(0.01);
  });
  it("rejects bad rates", () => {
    expect(() => resampleLinear(new Float32Array(4), 0)).toThrow();
  });
});
