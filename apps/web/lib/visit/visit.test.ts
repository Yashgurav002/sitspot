import { describe, expect, it } from "vitest";
import { answerSpeciesQuestion, confidenceWord, isSpeciesQuestion, summarize, type Heard } from "./answer";
import { createDropGate, createWindower, toModelWindow, WINDOW } from "./audio";
import { flushOutbox, memoryOutbox, type OutboxItem } from "./outbox";

const NOW = 1_000_000_000;
const h = (common: string, confidence: number, agoMs = 0, sci = common + " sci"): Heard => ({
  time: NOW - agoMs, scientific_name: sci, common_name: common, confidence,
});

describe("answer", () => {
  it("confidence words", () => {
    expect(confidenceWord(0.95)).toBe("confident");
    expect(confidenceWord(0.8)).toBe("confident");
    expect(confidenceWord(0.7)).toBe("fairly confident, not certain");
    expect(confidenceWord(0.6)).toBe("fairly confident, not certain");
    expect(confidenceWord(0.55)).toBe("possibly");
  });

  it("matches the spec phrasing", () => {
    const heard = [h("Red-vented Bulbul", 0.72, 40_000), h("Red-vented Bulbul", 0.65, 10_000)];
    expect(answerSpeciesQuestion("what was that?", heard, NOW)).toBe(
      "Most likely a Red-vented Bulbul, heard twice in the last minute. Fairly confident, not certain.",
    );
  });

  it("hedges low confidence and uses 'an'", () => {
    expect(answerSpeciesQuestion("what's that call", [h("Indian Golden Oriole", 0.52)], NOW)).toBe(
      "Possibly an Indian Golden Oriole, heard once in the last minute. Possibly — low confidence.",
    );
  });

  it("falls back to the last bird when nothing is recent", () => {
    const a = answerSpeciesQuestion("what was that", [h("House Crow", 0.9, 5 * 60_000)], NOW);
    expect(a).toBe("Nothing in the last minute. The last bird I heard was a House Crow, about 5 minutes ago. Confident.");
  });

  it("lists everything heard", () => {
    const heard = [h("House Crow", 0.9), h("House Crow", 0.85, 1000), h("Asian Koel", 0.7, 2000)];
    expect(answerSpeciesQuestion("what birds have you heard?", heard, NOW)).toBe(
      "So far I've heard 2 species: House Crow, twice, confident; Asian Koel, once, fairly confident, not certain.",
    );
  });

  it("never names a species that was not detected", () => {
    const names = ["Red-vented Bulbul", "House Crow", "Common Kingfisher", "Asian Koel", "Oriental Magpie-Robin"];
    const pool = [h("Red-vented Bulbul", 0.9, 5000), h("House Crow", 0.55, 120_000)];
    for (const q of ["what was that", "what birds so far", "which bird is singing", "what's that"]) {
      for (const heard of [[], pool.slice(0, 1), pool.slice(1), pool]) {
        const a = answerSpeciesQuestion(q, heard, NOW);
        for (const n of names) if (!heard.some((x) => x.common_name === n)) expect(a).not.toContain(n);
      }
    }
    expect(answerSpeciesQuestion("what was that", [], NOW)).toMatch(/haven't identified any birds/);
  });

  it("classifies questions vs observations", () => {
    for (const q of ["What was that?", "what's that call", "what birds have you heard", "which bird is that"])
      expect(isSpeciesQuestion(q), q).toBe(true);
    for (const o of ["the creek is high today", "saw two egrets near the mangroves", "windy"])
      expect(isSpeciesQuestion(o), o).toBe(false);
  });

  it("summarize groups and sorts by count", () => {
    const s = summarize([h("A", 0.6), h("B", 0.9), h("A", 0.7, 1000)]);
    expect(s.map((x) => [x.common_name, x.times, x.best])).toEqual([["A", 2, 0.7], ["B", 1, 0.9]]);
  });
});

describe("audio windows", () => {
  it("emits full windows across chunk boundaries and zeroes between", () => {
    const w = createWindower(5);
    expect(w.push(new Float32Array([1, 2, 3]))).toEqual([]);
    const out = w.push(new Float32Array([4, 5, 6, 7, 8, 9, 10, 11]));
    expect(out.map((x) => [...x])).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]);
    // remaining sample 11 is kept; rest of the buffer was zeroed
    expect([...w.push(new Float32Array([12, 13, 14, 15]))[0]]).toEqual([11, 12, 13, 14, 15]);
  });

  it("returned windows are copies", () => {
    const w = createWindower(2);
    const [a] = w.push(new Float32Array([1, 2]));
    w.push(new Float32Array([3, 4]));
    expect([...a]).toEqual([1, 2]);
  });

  it("toModelWindow yields exactly 144000 samples", () => {
    expect(toModelWindow(new Float32Array(144_000), 48_000).length).toBe(WINDOW);
    expect(toModelWindow(new Float32Array(132_300), 44_100).length).toBe(WINDOW);
    expect(toModelWindow(new Float32Array(48_000), 16_000).length).toBe(WINDOW);
  });

  it("drop gate skips windows while busy", async () => {
    const g = createDropGate();
    let release!: () => void;
    const first = g.run(() => new Promise<void>((r) => (release = r)));
    expect(await g.run(async () => {})).toBe(false);
    expect(g.dropped).toBe(1);
    release();
    expect(await first).toBe(true);
    expect(await g.run(async () => {})).toBe(true);
  });
});

describe("outbox", () => {
  const item = (i: number, visit_id = "v1"): OutboxItem => ({
    visit_id, token: "t-" + visit_id,
    row: { time: new Date(i).toISOString(), species_code: "X " + i, common_name: "x", confidence: 0.9, model_version: "m" },
  });

  it("peekBatch is FIFO and remove deletes", async () => {
    const b = memoryOutbox();
    await b.add([item(1), item(2), item(3)]);
    const p = await b.peekBatch(2);
    expect(p.map((x) => x.value.row.species_code)).toEqual(["X 1", "X 2"]);
    await b.remove(p.map((x) => x.key));
    expect((await b.peekBatch(10)).map((x) => x.value.row.species_code)).toEqual(["X 3"]);
  });

  it("flushes in batches of 200 with the right token", async () => {
    const b = memoryOutbox();
    await b.add([...Array(450)].map((_, i) => item(i)).concat([item(9, "v2")]));
    const calls: [string, string, number][] = [];
    const r = await flushOutbox(b, async (v, t, rows) => void calls.push([v, t, rows.length]));
    expect(r).toEqual({ sent: 451, dropped: 0, pending: false });
    expect(calls.every(([, , n]) => n <= 200)).toBe(true);
    expect(calls.find(([v]) => v === "v2")).toEqual(["v2", "t-v2", 1]);
    expect(await b.peekBatch(1)).toEqual([]);
  });

  it("keeps items when offline, retries later", async () => {
    const b = memoryOutbox();
    await b.add([item(1)]);
    const r = await flushOutbox(b, async () => { throw Object.assign(new Error("offline"), { status: 0 }); });
    expect(r).toEqual({ sent: 0, dropped: 0, pending: true });
    expect(await b.peekBatch(5)).toHaveLength(1);
    expect((await flushOutbox(b, async () => {})).sent).toBe(1);
  });

  it("drops a batch the server rejects outright", async () => {
    const b = memoryOutbox();
    await b.add([item(1)]);
    const warn = console.warn;
    console.warn = () => {};
    const r = await flushOutbox(b, async () => { throw Object.assign(new Error("bad"), { status: 400 }); });
    console.warn = warn;
    expect(r).toEqual({ sent: 0, dropped: 1, pending: false });
  });
});
