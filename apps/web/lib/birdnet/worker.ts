/// <reference lib="webworker" />
// BirdNET Web Worker. Audio arrives as a transferred Float32Array, is scored, and is dropped
// when this handler returns — nothing is stored, nothing leaves the device.
import type * as tfType from "@tensorflow/tfjs";
import { parseLabels, type Species } from "./labels";
import { birdnetWeek, loadAudioModel, loadMetaModel, metaScores, pickBackend, predictWindow } from "./model";

export type WorkerIn =
  | { type: "init"; baseUrl: string; backends?: string[] }
  | { type: "analyze"; id: number; samples: Float32Array; topK: number }
  | { type: "species"; id: number; lat: number; lon: number; time: number; threshold: number };

export type WorkerOut =
  | { type: "ready"; backend: string }
  | { type: "result"; id: number; preds: (Species & { confidence: number })[] }
  | { type: "species"; id: number; names: string[] }
  | { type: "error"; id?: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let baseUrl = "/birdnet/";
let audio: Promise<{ model: tfType.LayersModel; labels: Species[] }> | null = null;
let meta: Promise<tfType.GraphModel> | null = null;

const post = (m: WorkerOut) => ctx.postMessage(m);

ctx.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      baseUrl = msg.baseUrl;
      const backend = await pickBackend(msg.backends, baseUrl + "wasm/");
      audio = Promise.all([
        loadAudioModel(baseUrl),
        fetch(baseUrl + "labels.json").then((r) => r.json()),
      ]).then(([model, labels]) => ({ model, labels: parseLabels(labels) }));
      await audio;
      post({ type: "ready", backend });
    } else if (msg.type === "analyze") {
      if (!audio) throw new Error("not initialised");
      const { model, labels } = await audio;
      const probs = await predictWindow(model, msg.samples);
      const idx = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]).slice(0, msg.topK);
      post({ type: "result", id: msg.id, preds: idx.map((i) => ({ ...labels[i], confidence: probs[i] })) });
    } else if (msg.type === "species") {
      if (!audio) throw new Error("not initialised");
      meta ??= loadMetaModel(baseUrl);
      const [{ labels }, m] = await Promise.all([audio, meta]);
      const s = await metaScores(m, msg.lat, msg.lon, birdnetWeek(new Date(msg.time)));
      post({ type: "species", id: msg.id, names: labels.filter((_, i) => s[i] >= msg.threshold).map((l) => l.scientific_name) });
    }
  } catch (err) {
    post({ type: "error", id: "id" in msg ? msg.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};
