/** Linear-interpolation resampler, used when the device won't open an AudioContext at 48 kHz. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate = 48000): Float32Array {
  if (fromRate === toRate) return input.slice();
  if (!(fromRate > 0 && toRate > 0)) throw new Error("sample rates must be positive");
  const outLen = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    if (i0 >= last) {
      out[i] = input[last] ?? 0;
      continue;
    }
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i0 + 1] * frac;
  }
  // ponytail: no anti-alias low-pass when downsampling (e.g. 96k->48k); BirdNET only looks at <15 kHz so aliasing is minor.
  return out;
}
