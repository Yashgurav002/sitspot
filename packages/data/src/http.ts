export type FetchFn = typeof fetch;
export type FetchOpts = { fetch?: FetchFn; ttlMs?: number };

// ponytail: per-process Map, unbounded; swap for an LRU/Redis if memory or multi-instance matters.
const cache = new Map<string, { at: number; body: unknown }>();
export const DEFAULT_TTL_MS = 15 * 60_000;

export function clearCache(): void {
  cache.clear();
}

/** GET JSON with a tiny URL-keyed cache. ttlMs=0 disables caching. */
export async function getJson(url: string, opts: FetchOpts & { headers?: Record<string, string> } = {}): Promise<unknown> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hit = cache.get(url);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.body;
  const res = await (opts.fetch ?? fetch)(url, { headers: opts.headers });
  if (!res.ok) throw new Error(`GET ${url.split("?")[0]} -> HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (ttl > 0) cache.set(url, { at: Date.now(), body });
  return body;
}
