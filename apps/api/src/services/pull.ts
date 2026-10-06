import { fetchConditions, fetchRecentSightings } from "@sitspot/data";
import { listAllSpots, upsertConditions, upsertSightings, type Db } from "@sitspot/db";
import { withSpan } from "../observability";

export type PullSummary = {
  spots: number;
  conditionRows: number;
  sightingRows: number;
  errors: { spot_id: string; source: "conditions" | "ebird"; error: string }[];
};

const DAY = 86_400_000;
// Last successful eBird pull per spot, per db instance.
// ponytail: in-memory, so a process restart allows one extra eBird call per spot; persist a marker table if that matters.
const lastEbird = new WeakMap<Db, Map<string, number>>();

/** Pull Open-Meteo conditions for every spot, and eBird sightings at most once per 24 h per spot.
 *  One spot failing never stops the others; failures are collected in `errors`. */
export async function pullAll(
  db: Db,
  opts: { fetch?: typeof fetch; now?: Date; ebirdKey?: string | null } = {},
): Promise<PullSummary> {
  const now = opts.now ?? new Date();
  const spots = await listAllSpots(db);
  const out: PullSummary = { spots: spots.length, conditionRows: 0, sightingRows: 0, errors: [] };
  const marks = lastEbird.get(db) ?? new Map<string, number>();
  lastEbird.set(db, marks);
  if (!opts.ebirdKey && spots.length) console.warn("[pull] EBIRD_API_KEY not set; skipping eBird sightings");

  for (const spot of spots) {
    try {
      await withSpan("pull conditions", "data.pull", { spot_id: spot.id, source: "open-meteo" }, async (set) => {
        const rows = await fetchConditions(spot, { fetch: opts.fetch, now });
        await upsertConditions(db, rows);
        out.conditionRows += rows.length;
        set({ rows: rows.length });
      });
    } catch (e) {
      out.errors.push({ spot_id: spot.id, source: "conditions", error: (e as Error).message });
    }
    const last = marks.get(spot.id);
    if (!opts.ebirdKey || (last !== undefined && now.getTime() - last < DAY)) continue;
    try {
      await withSpan("pull sightings", "data.pull", { spot_id: spot.id, source: "ebird" }, async (set) => {
        const rows = await fetchRecentSightings(spot.lat, spot.lon, opts.ebirdKey!, { fetch: opts.fetch });
        await upsertSightings(db, rows);
        out.sightingRows += rows.length;
        marks.set(spot.id, now.getTime());
        set({ rows: rows.length });
      });
    } catch (e) {
      out.errors.push({ spot_id: spot.id, source: "ebird", error: (e as Error).message });
    }
  }
  return out;
}
