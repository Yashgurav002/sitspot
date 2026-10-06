// Grounding validators (spec §9.1, PRD FR-15, S-3, §13). Pure. Each check returns a list of
// problems; [] means the text passes. Problems are fed back to the model on the retry.
import type { SpotKind } from '@sitspot/shared';
import { renderDayFacts } from './context.js';
import { type DayFacts, type InvitationFacts, coastalClosed, confidenceWord, fmtTime } from './facts.js';
import { BIRD_GROUPS, KNOWN_SPECIES } from './species.js';


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
  /\b(?:cross|crosses|crossing|ford|fording)\s+(?:over\s+)?(?:the\s+|a\s+)?(?:mud|mud\s*flats?|water|creek|river|channel|stream|sea)\b/gi,
  /\b(?:walk|go|goes|going|step|wander|stray|head|venture)(?:s|ing|ed|ping)?\s+off\s+(?:the\s+)?(?:path|trail|track)\b/gi,
];
// A negation/hedge only counts if it is in the same clause and at most 4 words before the match
// ("don't walk onto the mud", "not safe to wade", "doesn't mention swimming", "know if you can wade").
const NEG =
  /\b(?:never|avoid|cannot|no need to|stay (?:off|out of|away from)|keep (?:off|out of|away from)|(?:not|un)safe to|too (?:late|dark|dangerous|risky) to|\w+n't|(?:do|does|did|should|must|can|could|would|will|please) not|not|no|whether|(?:know|ask(?:ed|ing)?|wonder(?:ing)?) if)\b(?:\s+\S+){0,4}\s*$/i;
// Phrases that look negative but encourage ("why not swim", "no problem, ...", "nothing wrong with wading").
const NOT_NEG = /\b(?:why not|no problem|not a problem|nothing wrong with|no reason not to|not too (?:late|dark|deep))\b/i;

/** Is the match at `index` negated or hedged within its own clause? */
export function negated(text: string, index: number): boolean {
  const clause = text.slice(Math.max(0, index - 80), index).replace(/[’‘`]/g, "'").split(/[,.;:!?—]/).at(-1)!;
  return NEG.test(clause) && !NOT_NEG.test(clause);
}

/** Advice that breaks S-3. Negated mentions ("don't walk onto the mudflats") are fine. */
export function unsafeAdvice(text: string): string[] {
  const out: string[] = [];
  for (const re of UNSAFE) for (const m of text.matchAll(re)) if (!negated(text, m.index)) out.push(`unsafe advice: "${m[0]}"`);
  return out;
}

const GO =
  /\b(?:yes,? you can|you can (?:still )?(?:go|head|visit)|still (?:go|head|visit)|go ahead|let'?s go|not too late|still time|(?:go|goes|going|head|heading|visit|visiting)(?: (?:out|down|over))? (?:to|for|on|there|now)\b|good (?:idea|time) to|worth (?:it|going|a visit)|looks? (?:quite |really )?good|enjoy (?:your|the) (?:walk|visit|beach|creek|night))/gi;
const CLOSED_OK = /\b(?:too late|too dark|not safe|isn'?t safe|don'?t go|do not go|shouldn'?t go|should not go|head back|leave now|time to leave)\b/i;

/** S-1: when the coast is closed, the text must not encourage going and must say it's too late / head back. */
export function coastalClosedProblems(text: string, f: InvitationFacts): string[] {
  if (!coastalClosed(f)) return [];
  const t = text.replace(/[’‘`]/g, "'");
  const out = [...t.matchAll(GO)].filter((m) => !negated(t, m.index)).map((m) => `too late for the coast: do not encourage going ("${m[0]}")`);
  if (!CLOSED_OK.test(t)) out.push(f.detections ? 'too late for the coast: tell them to head back to firm ground and leave' : "too late for the coast: say it's too late to go now");
  return out;
}

/**
 * Selling a low tide that has already passed is wrong: "low tide at 16:50" at 17:05, or "the low tide makes it great"
 * (eval s08). Past-tense mentions ("low tide was at 16:50", "after low tide") are fine.
 */
export function pastLowTide(text: string, f: InvitationFacts): string[] {
  const lt = f.numbers.tide?.low_time;
  if (!lt || lt >= f.now || !/\blow tide\b/i.test(text)) return [];
  if (/\blow tide (?:was|has passed|passed)\b|\b(?:after|since|past) (?:the )?low tide\b/i.test(text)) return [];
  return [`low tide at ${fmtTime(lt)} has already passed; the tide is ${f.numbers.tide?.trend ?? 'turning'} now`];
}

const MID_RE = /\bfairly (?:confident|certain|sure)\b|\bnot (?:certain|completely sure|fully sure)\b/gi;
const NOT_CONF_RE = /\bnot (?:very |that |too )?(?:confident|certain)\b/gi;
const HIGH_RE = /\b(?:confident|certain)\b/i;
const LOW_RE = /\b(?:possibly|maybe|might be|may be|could be|perhaps|not (?:very |that |too )?(?:confident|certain))\b/i;
const band = (c: number) => (c >= 0.8 ? 'high' : c >= 0.6 ? 'mid' : 'low');

/**
 * §9.3: a reply naming a detected bird must use that detection's band word (≥0.8 "confident",
 * 0.6–0.8 "fairly confident, not certain", <0.6 "possibly"), and must not claim a higher band
 * than any named detection has. Under-claiming ("possibly" for 0.7) is tolerated.
 * On a visit, "confident"/"fairly confident" with no detection to back it (e.g. about an eBird sighting) is rejected too.
 * ponytail: band words are checked per reply, not tied to each bird; fine for ≤3-sentence replies.
 */
export function confidenceBands(text: string, detections: { common_name: string; confidence: number }[] = []): string[] {
  const mentioned = mentionedBirds(text, [...DEFAULT_KNOWN, ...detections.map((d) => d.common_name)]);
  const named = detections.filter((d) => mentioned.some((k) => norm(d.common_name) === k || norm(d.common_name).endsWith(` ${k}`)));
  if (!detections.length) return [];
  const t = text.replace(/[’‘`]/g, "'");
  const has = { mid: t.search(MID_RE) >= 0, high: HIGH_RE.test(t.replace(MID_RE, '').replace(NOT_CONF_RE, '')), low: LOW_RE.test(t) };
  const out = named
    .filter((d) => !has[band(d.confidence)])
    .map((d) => `${d.common_name} is ${d.confidence.toFixed(2)}: say "${confidenceWord(d.confidence)}"`);
  if (has.high && !named.some((d) => band(d.confidence) === 'high')) out.push('"confident" is only for detections ≥0.80');
  if (has.mid && !named.some((d) => d.confidence >= 0.6)) out.push('"fairly confident" is only for detections 0.60–0.80; below 0.60 say "possibly"');
  return [...new Set(out)];
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
