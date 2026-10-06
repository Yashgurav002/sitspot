import type { Prediction } from "./client";

/** lastSeen: scientific_name -> ms timestamp of the last *reported* detection. */
export type DedupeState = ReadonlyMap<string, number>;

/**
 * Drop species already reported within `windowMs`. Pure: returns a new state.
 * A species keeps being suppressed only by reported detections, so a bird
 * calling continuously is reported once per window, not once ever.
 */
export function dedupeDetections(
  prev: DedupeState,
  preds: Prediction[],
  now: number,
  windowMs = 60_000,
): { state: Map<string, number>; fresh: Prediction[] } {
  const state = new Map(prev);
  const fresh: Prediction[] = [];
  for (const p of preds) {
    const last = state.get(p.scientific_name);
    if (last !== undefined && now - last < windowMs) continue;
    state.set(p.scientific_name, now);
    fresh.push(p);
  }
  return { state, fresh };
}
