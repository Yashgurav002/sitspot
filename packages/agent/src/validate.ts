// Grounding validators (spec §9.1, PRD FR-15, S-3, §13). Pure. Each check returns a list of
// problems; [] means the text passes. Problems are fed back to the model on the retry.
import type { SpotKind } from '@sitspot/shared';
import { renderDayFacts } from './context.js';
import { type DayFacts, fmtTime } from './facts.js';
import { BIRD_GROUPS, KNOWN_SPECIES } from './species.js';

export { confidenceWord } from './facts.js';

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUM_RE = new RegExp(
  [
    String.raw`\d{4}-\d{2}-\d{2}`, // date
    String.raw`\d{1,2}:\d{2}`, // time
    String.raw`\d+(?:\.\d+)?`, // integer / decimal
    String.raw`\b(?:${TENS.slice(2).join('|')})(?:[- ](?:${UNITS.slice(1, 10).join('|')}))?\b`,
    String.raw`\b(?:${UNITS.join('|')})\b`,
  ].join('|'),
  'gi',
);

/**
 * Small numbers anyone says without it being a factual claim ("one more", "a couple").
 * Judgment call: 0–2 only. "3 hours" or "three egrets" must be in the facts.
 */
export const FREE_NUMBERS = new Set(['n:0', 'n:1', 'n:2']);

function wordValue(w: string): number {
  const [t, u] = w.toLowerCase().split(/[- ]/);
  const ti = TENS.indexOf(t!);
  if (ti >= 2) return ti * 10 + (u ? UNITS.indexOf(u) : 0);
  return UNITS.indexOf(t!);
}

/** Normalised number tokens. Times also yield their 12-hour spelling on the facts side. */
function numberKeys(text: string, expand: boolean): { raw: string; keys: string[] }[] {
  return [...text.matchAll(NUM_RE)].map(([raw]) => {
    if (/^\d{4}-/.test(raw)) return { raw, keys: [`d:${raw}`] };
    const tm = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (tm) {
      const h = Number(tm[1]);
      const mm = tm[2]!;
      const keys = [`t:${h}:${mm}`];
      if (expand) {
        keys.push(`t:${h % 12 || 12}:${mm}`);
        if (mm === '00') keys.push(`n:${h}`, `n:${h % 12 || 12}`);
      }
      return { raw, keys };
    }
    return { raw, keys: [`n:${/\d/.test(raw) ? Number(raw) : wordValue(raw)}`] };
  });
}

/**
 * Every number in `text` (digits, decimals, HH:MM times, dates, number words up to 99)
 * must appear in `factsText`. "5:20 pm" matches a fact "17:20". 0–2 are always allowed.
 * ponytail: token-level match, not semantic — "6" is fine if any fact says 6.
 */
export function numbersInFacts(text: string, factsText: string): string[] {
  const allowed = new Set([...FREE_NUMBERS, ...numberKeys(factsText, true).flatMap((t) => t.keys)]);
  const bad = numberKeys(text, false).filter((t) => !t.keys.some((k) => allowed.has(k)));
  return [...new Set(bad.map((t) => t.raw))].map((r) => `number "${r}" is not in the facts`);
}

/** Text says this IST time, as 17:05, 5:05 or 05:05. */
export function mentionsTime(text: string, d: Date): boolean {
  const [h, mm] = fmtTime(d).split(':').map(Number) as [number, number];
  const m = String(mm).padStart(2, '0');
  return new RegExp(`\\b(?:0?${h}|${h % 12 || 12}):${m}\\b`).test(text);
}

const norm = (s: string) => s.toLowerCase().replace(/['’]/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const DEFAULT_KNOWN = [...KNOWN_SPECIES, ...BIRD_GROUPS];

/**
 * Rejects any known bird name in `text` not backed by `allowedNames`. Case/hyphen/plural-insensitive.
 * A name is backed if an allowed name equals it or ends with it ("egrets" ⇐ "Little Egret").
 * Generic words ("bird", "birds", "waders") are not in the known list, so they're always fine.
 */
export function speciesInFacts(text: string, allowedNames: string[], knownSpeciesNames: string[] = DEFAULT_KNOWN): string[] {
  const allowed = allowedNames.map(norm);
  return mentionedBirds(text, knownSpeciesNames)
    .filter((k) => !allowed.some((a) => a === k || a.endsWith(` ${k}`)))
    .map((k) => `species "${k}" is not in the facts`);
}

/** Known bird names (normalised) that appear in text. */
export function mentionedBirds(text: string, known: string[] = DEFAULT_KNOWN): string[] {
  const t = ` ${norm(text)} `;
  return [...new Set(known.map(norm))].filter((k) => new RegExp(`\\b${esc(k)}(?:e?s)?\\b`).test(t));
}

const UNSAFE = [
  /\b(?:walk|go|goes|going|step|head|venture|wander|cross|stand|get|getting)(?:s|ing|ed|ping)?\s+(?:out\s+)?(?:on|onto|into|in|across|over|out\s+on)\s+(?:to\s+)?(?:the\s+)?(?:mud|mud\s*flats?|water|sea|creek|river|shallows)\b/gi,
  /\b(?:wade|wading|swim|swimming)\b/gi,
  /\b(?:walk|go|goes|going|step|wander|stray|head|venture)(?:s|ing|ed|ping)?\s+off\s+(?:the\s+)?(?:path|trail|track)\b/gi,
];
const NEGATION = /\b(?:don'?t|do not|never|avoid|no|not|without|stay off)\b/i;

/** Advice that breaks S-3. Negated mentions ("don't walk onto the mudflats") are fine. */
export function unsafeAdvice(text: string): string[] {
  const out: string[] = [];
  for (const re of UNSAFE)
    for (const m of text.matchAll(re))
      if (!NEGATION.test(text.slice(Math.max(0, m.index - 25), m.index))) out.push(`unsafe advice: "${m[0]}"`);
  return out;
}

/** S-3: coastal text must say "firm ground"; no text may suggest mudflats/water/off-path. */
export function hasSafetyLine(text: string, kind: SpotKind): string[] {
  const out = unsafeAdvice(text);
  if (kind === 'coastal' && !/firm ground/i.test(text)) out.push('coastal spot: must tell them to "stay on firm ground"');
  return out;
}

const normQuote = (s: string) =>
  s.toLowerCase().replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Intent quotes must be the user's own words (spec §3.7). Ignores case, whitespace and punctuation. */
export function quoteIsSubstring(quote: string, utterance: string): boolean {
  const q = normQuote(quote);
  return q.length > 0 && ` ${normQuote(utterance)} `.includes(` ${q} `);
}

/** Species, counts and times in a field note must come from the day's facts (spec §13). */
export function verifyNote(body: string, facts: DayFacts): string[] {
  const fromObs = mentionedBirds((facts.observations ?? []).map((o) => o.text).join(' '));
  return [
    ...numbersInFacts(body, renderDayFacts(facts)),
    ...speciesInFacts(body, [...facts.species.map((s) => s.common_name), ...fromObs]),
    ...unsafeAdvice(body),
  ];
}
