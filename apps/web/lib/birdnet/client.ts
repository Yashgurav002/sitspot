// Main-thread handle to the BirdNET worker. Import only from client components.
import type { WorkerIn, WorkerOut } from "./worker";

export type Prediction = { scientific_name: string; common_name: string; confidence: number };

export type BirdnetOptions = {
  /** Scientific names (case-insensitive) allowed for this place. Undefined = no regional filter. */
  allowedSpecies?: Set<string>;
  minConfidence?: number;
  /** Where fetch_model.py put the model files. */
  baseUrl?: string;
  /** Backend preference; first that initialises wins. */
  backends?: string[];
};

/** Keep predictions at/above minConfidence and (if given) in the allowed list. Pure. */
export function filterPredictions(preds: Prediction[], minConfidence: number, allowed?: Set<string>): Prediction[] {
  const ok = allowed && new Set([...allowed].map((s) => s.toLowerCase()));
  return preds.filter((p) => p.confidence >= minConfidence && (!ok || ok.has(p.scientific_name.toLowerCase())));
}

export function createBirdnet(opts: BirdnetOptions = {}) {
  const minConfidence = opts.minConfidence ?? 0.5;
  let allowed = opts.allowedSpecies;
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let backend = "";
  let onReady!: () => void;
  let onFail!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => ((onReady = res), (onFail = rej)));

  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data;
    if (m.type === "ready") {
      backend = m.backend;
      return onReady();
    }
    if (m.type === "error" && m.id === undefined) return onFail(new Error(m.message));
    const p = pending.get(m.id!);
    if (!p) return;
    pending.delete(m.id!);
    if (m.type === "error") p.reject(new Error(m.message));
    else p.resolve((m.type === "result" ? m.preds : m.names) as never);
  };
  worker.onerror = (e) => onFail(new Error(e.message || "BirdNET worker failed to start"));

  const call = <T>(msg: WorkerIn, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      pending.set((msg as { id: number }).id, { resolve: resolve as (v: never) => void, reject });
      worker.postMessage(msg, transfer);
    });

  worker.postMessage({ type: "init", baseUrl: opts.baseUrl ?? "/birdnet/", backends: opts.backends } satisfies WorkerIn);

  return {
    ready,
    /** Backend actually used ("webgl" | "wasm" | "cpu"), set once ready resolves. */
    get backend() {
      return backend;
    },
    /**
     * Score one 3-s window: exactly 144000 mono samples at 48 kHz (resample with resampleLinear first if needed).
     * The samples are copied and the copy transferred to the worker; zero your own buffer afterwards.
     * Await each call before the next — if inference is slower than 3 s, skip windows rather than queue.
     */
    async analyze(samples: Float32Array): Promise<Prediction[]> {
      await ready;
      const copy = samples.slice();
      const preds = await call<Prediction[]>({ type: "analyze", id: nextId++, samples: copy, topK: 10 }, [copy.buffer]);
      return filterPredictions(preds, minConfidence, allowed);
    },
    /** Offline regional list from BirdNET's location/season model (scientific names). 0.03 = BirdNET default. */
    async speciesAt(lat: number, lon: number, date = new Date(), threshold = 0.03): Promise<Set<string>> {
      await ready;
      return new Set(await call<string[]>({ type: "species", id: nextId++, lat, lon, time: date.getTime(), threshold }));
    },
    setAllowedSpecies(s: Set<string> | undefined) {
      allowed = s;
    },
    dispose() {
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("disposed"));
      pending.clear();
    },
  };
}

export type Birdnet = ReturnType<typeof createBirdnet>;
