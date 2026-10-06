import type { Llm, Message } from '@sitspot/llm';
import type { DayFacts, InvitationFacts } from '../src/index.js';

/** IST wall-clock → Date. */
export const ist = (s: string) => new Date(`${s}:00+05:30`);

export const creek: InvitationFacts = {
  now: ist('2026-10-08T17:05'),
  spot: { name: 'Creek edge', kind: 'coastal', travel_min: 12 },
  window_start: ist('2026-10-08T17:15'),
  window_end: ist('2026-10-08T18:05'),
  leave_by: ist('2026-10-08T17:05'),
  factors: { p_rich: 0.62, p_rich_model: 'tabpfn-v1', comfort: 0.9, tide_fit: 1, light_bonus: 1.2, novelty: 1.1, availability: 1 },
  numbers: {
    apparent_c: 28.2,
    us_aqi: 62,
    wind_ms: 4.1,
    tide: { low_time: ist('2026-10-08T17:20'), low_m: 0.6, trend: 'falling' },
    sunset: ist('2026-10-08T18:15'),
    golden_start: ist('2026-10-08T17:30'),
  },
  sightings: [
    { common_name: 'Little Egret', count: 6, when: ist('2026-10-07T07:40') },
    { common_name: 'Common Kingfisher', count: 1, when: ist('2026-10-08T08:10') },
  ],
  preferences: [{ key: 'loves', value: 'kingfishers', quote: 'I love kingfishers' }],
  notes: [{ date: '2026-10-07', excerpt: 'Egrets on the mudflats at falling tide' }],
  safety_line: 'leave before 17:45 (sunset − 30)',
};

export const park: InvitationFacts = {
  ...creek,
  spot: { name: 'Fort garden', kind: 'heritage', travel_min: 8 },
  numbers: { apparent_c: 29, us_aqi: 80 },
  sightings: [],
  preferences: [],
  notes: [],
  safety_line: undefined,
};

export const visitDay: DayFacts = {
  date: '2026-10-08',
  spot: { name: 'Creek edge', kind: 'coastal' },
  start: ist('2026-10-08T17:20'),
  end: ist('2026-10-08T18:02'),
  species: [
    { common_name: 'Common Kingfisher', count: 2, first_time: ist('2026-10-08T17:31'), confidence: 0.71 },
    { common_name: 'Red-vented Bulbul', count: 3, first_time: ist('2026-10-08T17:29'), confidence: 0.86 },
    { common_name: 'Little Egret', count: 1, first_time: ist('2026-10-08T17:40'), confidence: 0.52 },
  ],
  numbers: { apparent_c: 28, us_aqi: 62 },
  observations: [{ time: ist('2026-10-08T17:45'), text: 'a heron flew low over the creek' }],
};

/** Fake Llm returning scripted outputs in order (Error entries are thrown). Records calls. */
export function fakeLlm(outputs: (string | Error)[]) {
  const calls: Message[][] = [];
  const next = () => {
    const o = outputs.shift();
    if (o === undefined) throw new Error('fake llm: no more outputs');
    if (o instanceof Error) throw o;
    return o;
  };
  const llm: Llm = {
    model: 'fake',
    async chat(messages) {
      calls.push(messages);
      return { text: next(), usage: { tokens_in: 10, tokens_out: 5 }, latency_ms: 1, model: 'fake' };
    },
    async *chatStream(messages) {
      calls.push(messages);
      yield next();
    },
    async json(messages, schema) {
      calls.push(messages);
      const raw = next();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { ok: false, error: `invalid JSON: ${(e as Error).message}`, raw };
      }
      const v = schema.safeParse(parsed);
      if (!v.success) return { ok: false, error: v.error.message, raw };
      return { ok: true, value: v.data, raw, usage: { tokens_in: 10, tokens_out: 5 }, latency_ms: 1 };
    },
    async embed() {
      return [];
    },
  };
  return { llm, calls };
}
