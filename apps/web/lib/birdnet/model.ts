// BirdNET GLOBAL 6K V2.4 in TensorFlow.js. No relative imports on purpose:
// ml/birdnet-web/run_node.mjs imports this file directly (Node type stripping).
import * as tf from "@tensorflow/tfjs";

export const SAMPLE_RATE = 48000;
export const WINDOW_SAMPLES = 144000; // 3 s mono @ 48 kHz

type LoadOpts = { fetchFunc?: (url: string) => Promise<Response> };

/* eslint-disable @typescript-eslint/no-explicit-any */

// Custom layer from the official TFJS export (BirdNET-Analyzer v1.5.1 static/main.js,
// birdnet-team/real-time-pwa birdnet-worker.js). Raw audio -> mel spectrogram inside the graph.
class MelSpecLayerSimple extends tf.layers.Layer {
  static className = "MelSpecLayerSimple";
  specShape: number[];
  frameStep: number;
  frameLength: number;
  melFilterbank: tf.Tensor2D;
  magScale!: tf.LayerVariable;

  constructor(config: any) {
    super(config);
    this.specShape = config.specShape;
    this.frameStep = config.frameStep;
    this.frameLength = config.frameLength;
    this.melFilterbank = tf.tensor2d(config.melFilterbank);
  }

  build(inputShape: tf.Shape | tf.Shape[]) {
    this.magScale = this.addWeight("magnitude_scaling", [], "float32", tf.initializers.constant({ value: 1.23 }));
    super.build(inputShape);
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape {
    return [(inputShape as tf.Shape)[0], this.specShape[0], this.specShape[1], 1];
  }

  call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor {
    return tf.tidy(() => {
      const x = Array.isArray(inputs) ? inputs[0] : inputs;
      const specs = tf.split(x, x.shape[0]!).map((one) => {
        let s: tf.Tensor = one.squeeze();
        // normalise to [-1, 1]
        s = tf.sub(s, tf.min(s, -1, true));
        s = tf.div(s, tf.add(tf.max(s, -1, true), 1e-6));
        s = tf.mul(tf.sub(s, 0.5), 2.0);
        s = stftReal(s as tf.Tensor1D, this.frameLength, this.frameStep);
        s = tf.pow(tf.matMul(s as tf.Tensor2D, this.melFilterbank), 2.0);
        s = tf.pow(s, tf.div(1.0, tf.add(1.0, tf.exp(this.magScale.read()))));
        s = tf.reverse(s, -1);
        return tf.expandDims(tf.transpose(s), -1);
      });
      return tf.stack(specs);
    });
  }
}
tf.serialization.registerClass(MelSpecLayerSimple);

// Real part of a Hann-windowed STFT (the model was trained on tf.cast(complex -> float), i.e. the real part).
function stftReal(signal: tf.Tensor1D, frameLength: number, frameStep: number): tf.Tensor {
  if (tf.getBackend() === "webgl") {
    return tf.engine().runKernel("STFT", { signal }, { frameLength, frameStep } as any) as tf.Tensor;
  }
  // cpu / wasm: tfjs's generic FFT takes ~50 s per window on CPU; a plain JS radix-2 FFT takes ~50 ms.
  const frames = Math.floor((signal.shape[0] - frameLength) / frameStep) + 1;
  return tf.tensor2d(stftRealJS(signal.dataSync() as Float32Array, frameLength, frameStep), [frames, frameLength / 2 + 1]);
}

const fftCache = new Map<number, { rev: Uint32Array; cos: Float64Array; sin: Float64Array; win: Float64Array }>();

/**
 * Real part of the STFT with a periodic Hann window, no padding — same as
 * tf.real(tf.signal.stft(x, n, step, n, tf.signal.hannWindow)). n must be a power of 2.
 * Returns row-major [frames, n/2 + 1].
 */
export function stftRealJS(x: Float32Array, n: number, step: number): Float32Array {
  let c = fftCache.get(n);
  if (!c) {
    const bits = Math.log2(n);
    if (!Number.isInteger(bits)) throw new Error("frame length must be a power of 2");
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), win = new Float64Array(n);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    c = { rev, cos, sin, win };
    fftCache.set(n, c);
  }
  const frames = Math.floor((x.length - n) / step) + 1;
  const bins = n / 2 + 1;
  const out = new Float32Array(frames * bins);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    const off = f * step;
    for (let i = 0; i < n; i++) { re[c.rev[i]] = x[off + i] * c.win[i]; im[c.rev[i]] = 0; }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, tstep = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const wr = c.cos[k * tstep], wi = c.sin[k * tstep];
          const a = s + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let k = 0; k < bins; k++) out[f * bins + k] = re[k];
  }
  return out;
}

// Fast WebGL STFT kernel, ported from birdnet-team/real-time-pwa (MIT, based on georg95/birdnet-web).
// tfjs's generic WebGL FFT is far slower for 500+ frames.
tf.registerKernel({
  kernelName: "STFT",
  backendName: "webgl",
  kernelFunc: ({ backend, inputs, attrs }: any) => {
    const { signal } = inputs;
    const { frameLength, frameStep } = attrs;
    const innerDim = frameLength / 2;
    const log2 = Math.log2(innerDim);
    const batch = ((signal.shape[0] - frameLength + frameStep) / frameStep) | 0;

    let cur = backend.runWebGLProgram(
      {
        variableNames: ["x"],
        outputShape: [batch, frameLength],
        userCode: `void main(){
          ivec2 c=getOutputCoords();
          int p=c[1]%${innerDim};
          int k=0;
          for(int i=0;i<${log2};++i){ if((p & (1<<i))!=0){ k|=(1<<(${log2 - 1}-i)); } }
          int i=2*k;
          if(c[1]>=${innerDim}){ i=2*(k%${innerDim})+1; }
          int q=c[0]*${frameLength}+i;
          float val=getX((q/${frameLength})*${frameStep}+ q % ${frameLength});
          float cosArg=${(2.0 * Math.PI) / frameLength}*float(q);
          float mul=0.5-0.5*cos(cosArg);
          setOutput(val*mul);
        }`,
      },
      [signal],
      "float32",
    );
    for (let len = 1; len < innerDim; len *= 2) {
      const prev = cur;
      cur = backend.runWebGLProgram(
        {
          variableNames: ["x"],
          outputShape: [batch, innerDim * 2],
          userCode: `void main(){
            ivec2 c=getOutputCoords();
            int b=c[0]; int i=c[1];
            int k=i%${innerDim};
            int isHigh=(k%${len * 2})/${len};
            int highSign=(1 - isHigh*2);
            int baseIndex=k - isHigh*${len};
            float t=${Math.PI / len}*float(k%${len});
            float a=cos(t); float bsin=sin(-t);
            float oddK_re=getX(b, baseIndex+${len});
            float oddK_im=getX(b, baseIndex+${len + innerDim});
            if(i<${innerDim}){
              float evenK_re=getX(b, baseIndex);
              setOutput(evenK_re + (oddK_re*a - oddK_im*bsin)*float(highSign));
            } else {
              float evenK_im=getX(b, baseIndex+${innerDim});
              setOutput(evenK_im + (oddK_re*bsin + oddK_im*a)*float(highSign));
            }
          }`,
        },
        [prev],
        "float32",
      );
      backend.disposeIntermediateTensorInfo(prev);
    }
    const real = backend.runWebGLProgram(
      {
        variableNames: ["x"],
        outputShape: [batch, innerDim + 1],
        userCode: `void main(){
          ivec2 c=getOutputCoords();
          int b=c[0]; int i=c[1];
          int zI=i%${innerDim};
          int conjI=(${innerDim}-i)%${innerDim};
          float Zk0=getX(b,zI); float Zk1=getX(b,zI+${innerDim});
          float Zk_conj0=getX(b,conjI); float Zk_conj1=-getX(b,conjI+${innerDim});
          float t=${-2.0 * Math.PI}*float(i)/float(${innerDim * 2});
          float diff0=Zk0 - Zk_conj0; float diff1=Zk1 - Zk_conj1;
          setOutput((Zk0+Zk_conj0 + cos(t)*diff1 + sin(t)*diff0)*0.5);
        }`,
      },
      [cur],
      "float32",
    );
    backend.disposeIntermediateTensorInfo(cur);
    return real;
  },
});

/**
 * Default: WASM first (deterministic, ~0.35 s/window in desktop Chromium), then WebGL (needs OffscreenCanvas
 * in workers; mobile GPUs without float32 textures may lose precision), then plain CPU (~3-5 s/window).
 * wasmPath: URL dir holding tfjs-backend-wasm*.wasm (browser only; Node finds them in node_modules).
 */
export async function pickBackend(prefer: string[] = ["wasm", "webgl", "cpu"], wasmPath?: string): Promise<string> {
  for (const b of prefer) {
    try {
      if (b === "wasm") {
        const wasm = await import("@tensorflow/tfjs-backend-wasm");
        if (wasmPath) wasm.setWasmPaths(wasmPath);
      }
      if (await tf.setBackend(b)) {
        await tf.ready();
        return b;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error("no TF.js backend available");
}

export async function loadAudioModel(baseUrl: string, opts: LoadOpts = {}): Promise<tf.LayersModel> {
  const model = await tf.loadLayersModel(baseUrl + "model.json", opts as any);
  tf.tidy(() => {
    model.predict(tf.zeros([1, WINDOW_SAMPLES])); // warm-up: compiles shaders
  });
  return model;
}

/** One 3-s window -> 6522 sigmoid scores (index-aligned with labels.json). */
export async function predictWindow(model: tf.LayersModel, samples: Float32Array): Promise<Float32Array> {
  if (samples.length !== WINDOW_SAMPLES) throw new Error(`expected ${WINDOW_SAMPLES} samples, got ${samples.length}`);
  const x = tf.tensor2d(samples, [1, WINDOW_SAMPLES]);
  const y = model.predict(x) as tf.Tensor;
  try {
    return (await y.data()) as Float32Array;
  } finally {
    x.dispose();
    y.dispose();
  }
}

export async function loadMetaModel(baseUrl: string, opts: LoadOpts = {}): Promise<tf.GraphModel> {
  return tf.loadGraphModel(baseUrl + "mdata/model.json", opts as any);
}

/** Location/season prior: occurrence score per label for (lat, lon, BirdNET week 1-48, or -1 = all year). */
export async function metaScores(meta: tf.GraphModel, lat: number, lon: number, week: number): Promise<Float32Array> {
  const x = tf.tensor2d([[lat, lon, week]]);
  const y = meta.predict(x) as tf.Tensor;
  try {
    return (await y.data()) as Float32Array;
  } finally {
    x.dispose();
    y.dispose();
  }
}

/** BirdNET's 48-week year: 4 "weeks" per month. */
export function birdnetWeek(d: Date): number {
  return d.getMonth() * 4 + Math.min(4, Math.floor((d.getDate() - 1) / 7) + 1);
}
