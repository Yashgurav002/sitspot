import { z } from "zod";
import type { Sighting } from "@sitspot/shared";
import { getJson, type FetchOpts } from "./http.js";

// Fields per eBird API 2.0 docs, "Recent nearby observations" example response.
const Obs = z.object({
  speciesCode: z.string(),
  comName: z.string().optional(),
  locId: z.string(),
  obsDt: z.string(), // "YYYY-MM-DD HH:mm" or "YYYY-MM-DD", local time of the location
  howMany: z.number().int().optional(), // absent when observer recorded "X"
  lat: z.number().optional(),
  lng: z.number().optional(),
  subId: z.string().optional(), // not in the doc example; used when present
});

/** obsDt is local wall-clock at the location. ponytail: assumes IST (+05:30) since Sitspot is India-only. */
export function parseObsDt(s: string): Date {
  return new Date(`${s.length === 10 ? `${s} 00:00` : s}:00+05:30`.replace(" ", "T"));
}

export async function fetchRecentSightings(
  lat: number,
  lon: number,
  apiKey: string,
  opts: FetchOpts & { dist?: number; back?: number } = {},
): Promise<Sighting[]> {
  const url = `https://api.ebird.org/v2/data/obs/geo/recent?lat=${lat.toFixed(2)}&lng=${lon.toFixed(2)}&dist=${opts.dist ?? 5}&back=${opts.back ?? 7}`;
  const rows = z.array(Obs).parse(await getJson(url, { ...opts, headers: { "X-eBirdApiToken": apiKey } }));
  return rows.map((o) => ({
    time: parseObsDt(o.obsDt),
    checklist_id: o.subId ?? null,
    loc_id: o.locId,
    lat: o.lat ?? null,
    lon: o.lng ?? null,
    species_code: o.speciesCode,
    common_name: o.comName ?? null,
    how_many: o.howMany ?? null,
  }));
}
