// Deterministic on-visit answers (spec §3.8). Only ever names species present in `heard`.

/** One model hit kept in memory on the phone (no audio). time = ms epoch. */
export type Heard = { time: number; scientific_name: string; common_name: string; confidence: number };

export type SpeciesSummary = { scientific_name: string; common_name: string; times: number; best: number; last: number };

export function confidenceWord(c: number): "confident" | "fairly confident, not certain" | "possibly" {
  return c >= 0.8 ? "confident" : c >= 0.6 ? "fairly confident, not certain" : "possibly";
}

/** Group by species, most-heard first (ties: most recent). */
export function summarize(heard: Heard[]): SpeciesSummary[] {
  const by = new Map<string, SpeciesSummary>();
  for (const h of heard) {
    const s = by.get(h.scientific_name);
    if (!s) by.set(h.scientific_name, { ...h, times: 1, best: h.confidence, last: h.time });
    else {
      s.times++;
      s.best = Math.max(s.best, h.confidence);
      s.last = Math.max(s.last, h.time);
    }
  }
  return [...by.values()].sort((a, b) => b.times - a.times || b.last - a.last);
}

const ONE_OF = /\b(what|which|who)\b.*\b(that|this|bird|birds|call|calls|song|sound|singing|calling|heard?|hearing)\b/i;
const LIST = /\b(birds|species|so far|all)\b/i;

/** Does this utterance ask what was heard? Everything else is treated as an observation. */
export function isSpeciesQuestion(text: string): boolean {
  return ONE_OF.test(text) || /^what('|’)?s that\b/i.test(text.trim());
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const article = (name: string) => (/^[aeiou]/i.test(name) ? "an" : "a");
const sentence = (c: number) =>
  c >= 0.8 ? "Confident." : c >= 0.6 ? "Fairly confident, not certain." : "Possibly — low confidence.";
const lead = (s: { common_name: string; best: number }) =>
  `${s.best >= 0.6 ? "Most likely" : "Possibly"} ${article(s.common_name)} ${s.common_name}`;
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m <= 1 ? "about a minute ago" : `about ${m} minutes ago`;
};

/** Spoken answer to "what was that?" / "what birds have you heard?". */
export function answerSpeciesQuestion(question: string, heard: Heard[], now: number): string {
  if (heard.length === 0) return "I haven't identified any birds yet. I only name what I've actually heard.";
  if (LIST.test(question) && !/\b(that|this)\b/i.test(question)) {
    const all = summarize(heard);
    const parts = all.slice(0, 5).map((s) => `${s.common_name}, ${times(s.times)}, ${confidenceWord(s.best)}`);
    const more = all.length > 5 ? ` And ${all.length - 5} more.` : "";
    return `So far I've heard ${all.length} species: ${parts.join("; ")}.${more}`;
  }
  const recent = summarize(heard.filter((h) => now - h.time <= 60_000));
  if (recent.length === 0) {
    const last = summarize(heard).sort((a, b) => b.last - a.last)[0];
    return `Nothing in the last minute. The last bird I heard was ${article(last.common_name)} ${last.common_name}, ${ago(now - last.last)}. ${sentence(last.best)}`;
  }
  const top = recent[0];
  const also = recent.length > 1 ? ` Also ${recent.slice(1, 3).map((s) => s.common_name).join(" and ")}.` : "";
  return `${lead(top)}, heard ${times(top.times)} in the last minute. ${sentence(top.best)}${also}`;
}
