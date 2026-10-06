// Mic → 3-s mono windows for BirdNET. Audio stays in memory only: each window is handed to the
// worker and the buffer is zeroed; nothing is stored or sent.
import { resampleLinear } from "../birdnet/resample";

export const MODEL_RATE = 48_000;
export const WINDOW = 144_000; // 3 s at 48 kHz

/** Fills a fixed-size buffer from arbitrary-length chunks; emits a copy each time it's full, then zeroes it. Pure. */
export function createWindower(size: number) {
  const buf = new Float32Array(size);
  let fill = 0;
  return {
    push(chunk: Float32Array): Float32Array[] {
      const out: Float32Array[] = [];
      let i = 0;
      while (i < chunk.length) {
        const n = Math.min(size - fill, chunk.length - i);
        buf.set(chunk.subarray(i, i + n), fill);
        fill += n;
        i += n;
        if (fill === size) {
          out.push(buf.slice());
          buf.fill(0);
          fill = 0;
        }
      }
      return out;
    },
  };
}

/** Bring a window recorded at `rate` to exactly 144000 samples at 48 kHz. */
export function toModelWindow(samples: Float32Array, rate: number): Float32Array {
  const r = rate === MODEL_RATE ? samples : resampleLinear(samples, rate, MODEL_RATE);
  if (r.length === WINDOW) return r;
  const out = new Float32Array(WINDOW);
  out.set(r.subarray(0, WINDOW));
  return out;
}

/** Run at most one job at a time; while busy, new windows are dropped (not queued). */
export function createDropGate() {
  let busy = false;
  let dropped = 0;
  return {
    get dropped() {
      return dropped;
    },
    async run(job: () => Promise<void>): Promise<boolean> {
      if (busy) {
        dropped++;
        return false;
      }
      busy = true;
      try {
        await job();
      } finally {
        busy = false;
      }
      return true;
    },
  };
}

// Batches 128-frame render quanta into 4096-sample chunks so the main thread gets ~12 messages/s, not 375.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.b[this.n++] = ch[i];
      if (this.n === 4096) { this.port.postMessage(this.b, [this.b.buffer]); this.b = new Float32Array(4096); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("sitspot-tap", Tap);`;

export type Mic = { rate: number; worklet: boolean; stop(): void; context: AudioContext };

/** Open the mic (no voice processing) and call onWindow with each 144000-sample 48 kHz window. */
export async function startMic(onWindow: (w: Float32Array) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: MODEL_RATE });
  } catch {
    ctx = new AudioContext(); // device refuses 48 kHz: record native rate, resample per window
  }
  if (ctx.state === "suspended") await ctx.resume();
  const rate = ctx.sampleRate;
  const windower = createWindower(Math.round(rate * 3));
  const onChunk = (c: Float32Array) => {
    for (const w of windower.push(c)) onWindow(toModelWindow(w, rate));
  };
  const src = ctx.createMediaStreamSource(stream);
  const mute = ctx.createGain();
  mute.gain.value = 0; // nodes must reach the destination to be pulled; silence it
  mute.connect(ctx.destination);

  let worklet = false;
  let node: AudioNode;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const w = new AudioWorkletNode(ctx, "sitspot-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    w.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(e.data);
    node = w;
    worklet = true;
  } catch {
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0).slice());
    node = sp;
  }
  src.connect(node);
  node.connect(mute);
  return {
    rate,
    worklet,
    context: ctx,
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      src.disconnect();
      node.disconnect();
      void ctx.close();
    },
  };
}
