// Detection outbox: survives reloads and no-signal spots; flushed to the idempotent API.
import type { DetectionInput } from "@sitspot/shared";
import type { Wire } from "@/lib/api";

export type OutboxItem = { visit_id: string; token: string; row: Wire<DetectionInput> };
export type Outbox = {
  add(items: OutboxItem[]): Promise<void>;
  peekBatch(n: number): Promise<{ key: number; value: OutboxItem }[]>;
  remove(keys: number[]): Promise<void>;
};

/** In-memory outbox: tests, and the fallback when IndexedDB is unavailable (some private modes). */
export function memoryOutbox(): Outbox {
  const m = new Map<number, OutboxItem>();
  let next = 1;
  return {
    async add(items) {
      for (const i of items) m.set(next++, i);
    },
    async peekBatch(n) {
      return [...m].slice(0, n).map(([key, value]) => ({ key, value }));
    },
    async remove(keys) {
      for (const k of keys) m.delete(k);
    },
  };
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
const done = (t: IDBTransaction) =>
  new Promise<void>((res, rej) => ((t.oncomplete = () => res()), (t.onerror = t.onabort = () => rej(t.error))));

/** IndexedDB outbox (db "sitspot-visit", store "outbox", auto-increment keys = insertion order). */
export async function idbOutbox(): Promise<Outbox> {
  const open = indexedDB.open("sitspot-visit", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("outbox", { autoIncrement: true });
  const db = await req(open);
  const store = (mode: IDBTransactionMode) => db.transaction("outbox", mode);
  return {
    async add(items) {
      const t = store("readwrite");
      for (const i of items) t.objectStore("outbox").add(i);
      await done(t);
    },
    async peekBatch(n) {
      const s = store("readonly").objectStore("outbox");
      const [keys, values] = await Promise.all([req(s.getAllKeys(null, n)), req(s.getAll(null, n))]);
      return keys.map((k, i) => ({ key: k as number, value: values[i] as OutboxItem }));
    },
    async remove(keys) {
      const t = store("readwrite");
      for (const k of keys) t.objectStore("outbox").delete(k);
      await done(t);
    },
  };
}

export type Send = (visitId: string, token: string, rows: Wire<DetectionInput>[]) => Promise<unknown>;

/**
 * Drain the outbox in batches of 200. Keeps items on network/5xx/408/429 errors (retry later);
 * drops a batch the server rejects outright (other 4xx) so one bad row can't block the queue forever.
 * Returns how many rows were sent (or dropped) and whether anything is left.
 */
export async function flushOutbox(box: Outbox, send: Send): Promise<{ sent: number; dropped: number; pending: boolean }> {
  let sent = 0;
  let dropped = 0;
  for (;;) {
    const batch = await box.peekBatch(200);
    if (batch.length === 0) return { sent, dropped, pending: false };
    const byVisit = new Map<string, typeof batch>();
    for (const b of batch) byVisit.set(b.value.visit_id, [...(byVisit.get(b.value.visit_id) ?? []), b]);
    for (const [visitId, items] of byVisit) {
      try {
        await send(visitId, items[0].value.token, items.map((i) => i.value.row));
        sent += items.length;
      } catch (e) {
        const status = (e as { status?: number }).status ?? 0;
        if (status === 0 || status >= 500 || status === 408 || status === 429) return { sent, dropped, pending: true };
        console.warn(`[sitspot] dropping ${items.length} detections rejected with ${status}`, e);
        dropped += items.length;
      }
      await box.remove(items.map((i) => i.key));
    }
  }
}
