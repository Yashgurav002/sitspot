"use client";
import { useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { createBirdnet, type Birdnet } from "@/lib/birdnet/client";

const BASE = "/birdnet/";

export type ModelState =
  | { phase: "downloading"; progress: number }
  | { phase: "starting" }
  | { phase: "ready"; backend: string }
  | { phase: "failed"; message: string };

export type Regional = "pending" | "ok" | "failed";

/**
 * Warm the HTTP cache for the model files (so we can show progress — the worker can't), then boot
 * the worker. The worker's own fetches then hit the cache (or a 304) instead of downloading again.
 */
async function warmCache(onProgress: (p: number) => void, signal: AbortSignal) {
  const urls = ["labels.json"];
  for (const m of ["model.json", "mdata/model.json"]) {
    const j = (await (await fetch(BASE + m, { signal })).json()) as { weightsManifest: { paths: string[] }[] };
    const dir = m.replace(/[^/]*$/, "");
    urls.push(m, ...j.weightsManifest.flatMap((g) => g.paths.map((p) => dir + p)));
  }
  let done = 0;
  let next = 0;
  const lane = async () => {
    while (next < urls.length) {
      const r = await fetch(BASE + urls[next++], { signal });
      if (!r.ok) throw new Error(`model file missing (${r.status})`);
      await r.arrayBuffer();
      onProgress(++done / urls.length);
    }
  };
  await Promise.all([lane(), lane(), lane(), lane()]);
}

/** Loads BirdNET on mount; once `coords` are known, restricts it to species expected there. */
export function useBirdnet(coords: { lat: number; lon: number } | null | undefined) {
  const bn = useRef<Birdnet | null>(null);
  const [model, setModel] = useState<ModelState>({ phase: "downloading", progress: 0 });
  const [regional, setRegional] = useState<Regional>("pending");
  const [regionalCount, setRegionalCount] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    let b: Birdnet | null = null;
    // Model load (download + worker boot); ended once ready/failed. Never sent when Sentry is off.
    const span = Sentry.startInactiveSpan({ name: "birdnet model load", op: "birdnet.load", forceTransaction: true });
    (async () => {
      try {
        await warmCache((progress) => setModel({ phase: "downloading", progress }), ac.signal);
      } catch (e) {
        if (ac.signal.aborted) return;
        console.warn("[sitspot] model warm-up failed, trying the worker anyway", e);
      }
      if (ac.signal.aborted) return;
      setModel({ phase: "starting" });
      b = createBirdnet({ minConfidence: 0.5 });
      try {
        await b.ready;
        if (ac.signal.aborted) return;
        bn.current = b;
        span.setAttribute("backend", b.backend);
        span.end();
        setModel({ phase: "ready", backend: b.backend });
      } catch (e) {
        if (ac.signal.aborted) return;
        span.setStatus({ code: 2, message: "internal_error" });
        span.end();
        setModel({ phase: "failed", message: (e as Error).message });
      }
    })();
    return () => {
      ac.abort();
      b?.dispose();
      bn.current = null;
    };
  }, []);

  const ready = model.phase === "ready";
  const lat = coords?.lat;
  const lon = coords?.lon;
  useEffect(() => {
    if (!ready || coords === undefined) return;
    if (coords === null || lat === undefined || lon === undefined) return setRegional("failed");
    let live = true;
    bn.current!.speciesAt(lat, lon).then(
      (s) => {
        if (!live) return;
        bn.current?.setAllowedSpecies(s);
        setRegionalCount(s.size);
        setRegional("ok");
      },
      (e) => {
        console.warn("[sitspot] regional species list failed; detections are unfiltered", e);
        if (live) setRegional("failed");
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, coords === undefined, coords === null, lat, lon]);

  return { bn, model, regional, regionalCount };
}
