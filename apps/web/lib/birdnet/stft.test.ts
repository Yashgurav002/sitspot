import { describe, expect, it } from "vitest";
import { stftRealJS } from "./model";

describe("stftRealJS", () => {
  it("matches a naive Hann-windowed DFT (real part)", () => {
    const n = 16, step = 5;
    const x = Float32Array.from({ length: 50 }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1));
    const out = stftRealJS(x, n, step);
    const frames = Math.floor((x.length - n) / step) + 1;
    expect(out).toHaveLength(frames * (n / 2 + 1));
    for (let f = 0; f < frames; f++)
      for (let k = 0; k <= n / 2; k++) {
        let re = 0;
        for (let t = 0; t < n; t++) re += x[f * step + t] * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / n)) * Math.cos((2 * Math.PI * k * t) / n);
        expect(out[f * (n / 2 + 1) + k]).toBeCloseTo(re, 4);
      }
  });
});
