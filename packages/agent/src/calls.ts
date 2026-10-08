// The four LLM calls (spec §9.1). Context-first: no tool calling. Each call validates,
// retries once with the problems fed back, then falls back to a deterministic answer.
// None of them throws on model failure.
import type { Llm, Message, Usage } from '@sitspot/llm';
import { z } from 'zod';
import { buildContextBlock, renderDayFacts } from './context.js';
import { type DayFacts, type InvitationFacts, coastalClosed, fmtTime, airLine, poorAir } from './facts.js';
import { CHAT_INSTRUCTIONS, INTENT_INSTRUCTIONS, NOTE_INSTRUCTIONS, SCRIPT_INSTRUCTIONS, SYSTEM_PROMPT, feedback } from './prompts.js';
import { templateChat, templateNote, templateScript } from './templates.js';
import {
  coastalClosedProblems, confidenceBands, hasSafetyLine, mentionsTime, numbersInFacts, pastLowTide, quoteIsSubstring, speciesInFacts, unsafeAdvice, verifyNote,
} from './validate.js';

export interface CallMeta {
  model: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  attempts: number;
  fallback: boolean;
  /** Problems from the last rejected attempt (or the error), for logs/eval. */
  problems: string[];
}

type Attempt<T> = { value?: T; raw: string; problems: string[]; usage: Usage | null; latency_ms: number };

/** Up to 2 attempts. A thrown model error goes straight to fallback: retrying a timeout doubles a live call's wait. */
async function tryTwice<T>(llm: Llm, messages: Message[], once: (m: Message[]) => Promise<Attempt<T>>): Promise<{ value: T | null; meta: CallMeta }> {
  const meta: CallMeta = { model: llm.model, tokens_in: 0, tokens_out: 0, latency_ms: 0, attempts: 0, fallback: false, problems: [] };
  let msgs = messages;
  for (let i = 0; i < 2; i++) {
    meta.attempts++;
    let a: Attempt<T>;
    try {
      a = await once(msgs);
    } catch (e) {
      meta.problems = [`model error: ${(e as Error).message}`];
      break;
    }
    meta.tokens_in += a.usage?.tokens_in ?? 0;
    meta.tokens_out += a.usage?.tokens_out ?? 0;
    meta.latency_ms += a.latency_ms;
    meta.problems = a.problems;
    if (!a.problems.length && a.value !== undefined) return { value: a.value, meta };
    msgs = [...msgs, { role: 'assistant', content: a.raw }, { role: 'user', content: feedback(a.problems) }];
  }
  meta.fallback = true;
  return { value: null, meta };
}

async function jsonAttempt<S, T>(llm: Llm, m: Message[], schema: z.ZodType<S>, check: (v: S) => { value: T; problems: string[] }): Promise<Attempt<T>> {
  const t0 = performance.now();
  const r = await llm.json(m, schema, { temperature: 0.4 });
  if (!r.ok) return { raw: r.raw, problems: [r.error], usage: null, latency_ms: Math.round(performance.now() - t0) };
  return { ...check(r.value), raw: r.raw, usage: r.usage, latency_ms: r.latency_ms };
}

const withContext = (instructions: string, context: string): Message[] => [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: `${instructions}\n\nCONTEXT:\n${context}` },
];

const allowedSpecies = (f: InvitationFacts) => [...f.sightings.map((s) => s.common_name), ...(f.detections ?? []).map((d) => d.common_name)];

// ---------- script ----------

const ScriptOut = z.object({ script: z.string().min(1), reason: z.string().min(1) });
export type ScriptResult = { script: string; reason: string; meta: CallMeta };

/** Problems with a script/reason pair, against the context block. Exported for eval. */
export function checkScript(out: { script: string; reason: string }, facts: InvitationFacts, context = buildContextBlock(facts)): string[] {
  const allowed = allowedSpecies(facts);
  return [
    ...numbersInFacts(out.script, context),
    ...speciesInFacts(out.script, allowed),
    ...hasSafetyLine(out.script, facts.spot.kind),
    ...coastalClosedProblems(out.script, facts),
    ...(poorAir(facts) && !(/\bair\b/i.test(out.script) && /\b(short|easy|gentle)\b/i.test(out.script))
      ? [`AQI ${Math.round(facts.numbers.us_aqi!)} is poor: the script must say "${airLine(facts.numbers.us_aqi!)}"`]
      : []),
    ...pastLowTide(out.script, facts),
    ...pastLowTide(out.reason, facts).map((p) => `reason: ${p}`),
    ...(mentionsTime(out.script, facts.leave_by) ? [] : [`script must say when to leave: "leave by ${fmtTime(facts.leave_by)}"`]),
    ...(mentionsTime(out.script, facts.window_end) ? [] : [`script must say how long it stays good: "until ${fmtTime(facts.window_end)}"`]),
    ...numbersInFacts(out.reason, context).map((p) => `reason: ${p}`),
    ...speciesInFacts(out.reason, allowed).map((p) => `reason: ${p}`),
    ...unsafeAdvice(out.reason).map((p) => `reason: ${p}`),
  ];
}

export async function composeScript(llm: Llm, facts: InvitationFacts): Promise<ScriptResult> {
  // S-1 defence in depth: policy never schedules this, but if it does, no model call and no "Want to go?".
  if (coastalClosed(facts))
    return { ...templateScript(facts), meta: { model: llm.model, tokens_in: 0, tokens_out: 0, latency_ms: 0, attempts: 0, fallback: true, problems: ['coastal spot after sunset − 30 min (S-1)'] } };
  const context = buildContextBlock(facts);
  const { value, meta } = await tryTwice(llm, withContext(SCRIPT_INSTRUCTIONS, context), (m) =>
    jsonAttempt(llm, m, ScriptOut, (v) => {
      // "Want to go?" is fixed wording — append rather than reject.
      const out = { script: /want to go\?\s*$/i.test(v.script.trim()) ? v.script.trim() : `${v.script.trim()} Want to go?`, reason: v.reason.trim() };
      return { value: out, problems: checkScript(out, facts, context) };
    }),
  );
  return { ...(value ?? templateScript(facts)), meta };
}

// ---------- chat ----------

/** First n sentences. */
export function firstSentences(text: string, n = 3): string {
  // A "." inside a number ("0.71") does not end a sentence.
  const parts = text.replace(/\s+/g, ' ').trim().match(/(?:[^.!?]|\.(?=\d))+(?:[.!?]+|$)/g) ?? [];
  return parts.slice(0, n).join('').trim();
}

export interface ChatInput {
  facts: InvitationFacts;
  history: Message[];
  utterance: string;
}
export type ChatResult = { reply: string; meta: CallMeta };

export async function chatTurn(llm: Llm, { facts, history, utterance }: ChatInput): Promise<ChatResult> {
  const context = buildContextBlock(facts);
  // Numbers the user or earlier turns said are fair to repeat.
  const grounding = [context, ...history.map((h) => h.content), utterance].join('\n');
  const messages: Message[] = [...withContext(CHAT_INSTRUCTIONS, context), ...history.slice(-8), { role: 'user', content: utterance }];
  const { value, meta } = await tryTwice(llm, messages, async (m) => {
    const r = await llm.chat(m, { temperature: 0.5, maxTokens: 200 });
    const reply = firstSentences(r.text);
    const problems = reply
      ? [
          ...speciesInFacts(reply, allowedSpecies(facts)),
          ...unsafeAdvice(reply),
          ...numbersInFacts(reply, grounding),
          ...confidenceBands(reply, facts.detections),
          ...coastalClosedProblems(reply, facts),
          ...pastLowTide(reply, facts),
        ]
      : ['empty reply'];
    return { value: reply, raw: r.text, problems, usage: r.usage, latency_ms: r.latency_ms };
  });
  return { reply: value ?? templateChat(facts), meta };
}

/**
 * Streaming shape for the voice SSE endpoint. Validation needs the whole reply, so this
 * generates fully, validates, then yields word chunks; the generator returns the result.
 * ponytail: correctness over latency — first token waits for the full reply. Stream-then-retract
 * is impossible on a phone call; if latency hurts, validate per sentence and flush sentence by sentence.
 */
export async function* chatTurnStream(llm: Llm, input: ChatInput): AsyncGenerator<string, ChatResult> {
  const r = await chatTurn(llm, input);
  for (const chunk of r.reply.match(/\S+\s*/g) ?? []) yield chunk;
  return r;
}

// ---------- intent ----------

export interface Intent {
  save_preference?: { key: string; value: unknown; quote: string };
  respond?: 'accept' | 'decline';
  end_visit?: boolean;
}
export type IntentResult = { intent: Intent; meta: CallMeta };

const IntentOut = z.object({
  save_preference: z.object({ key: z.string().min(1), value: z.unknown(), quote: z.string() }).nullish(),
  respond: z.enum(['accept', 'decline']).nullish(),
  end_visit: z.boolean().nullish(),
});

const DECLINE = /^\s*(?:no|nope|nah)\b|\b(?:not today|not now|no thanks|no thank you|i'?ll pass|maybe later|another time|can'?t make it)\b/i;
const ACCEPT = /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|alright|definitely|absolutely)\b|\b(?:let'?s go|i'?m in|on my way|sounds good|count me in)\b/i;

/** Cheap regex pass for obvious yes/no. Decline wins ("no, not today, sure" is a no). */
export function quickRespond(utterance: string): 'accept' | 'decline' | undefined {
  if (DECLINE.test(utterance)) return 'decline';
  if (ACCEPT.test(utterance)) return 'accept';
  return undefined;
}

export async function extractIntent(llm: Llm, { utterance, lastReply }: { utterance: string; lastReply: string }): Promise<IntentResult> {
  const quick = quickRespond(utterance);
  const skipped: CallMeta = { model: 'rules', tokens_in: 0, tokens_out: 0, latency_ms: 0, attempts: 0, fallback: false, problems: [] };
  // Short obvious answers ("yes, let's go") carry no preference — skip the model.
  if (quick && utterance.trim().split(/\s+/).length <= 4) return { intent: { respond: quick }, meta: skipped };

  const messages: Message[] = [
    { role: 'system', content: INTENT_INSTRUCTIONS },
    { role: 'user', content: `ASSISTANT'S LAST REPLY: ${lastReply}\nUTTERANCE: ${utterance}` },
  ];
  const { value, meta } = await tryTwice(llm, messages, (m) => jsonAttempt(llm, m, IntentOut, (v) => ({ value: v, problems: [] })));
  const intent: Intent = {};
  const respond = quick ?? value?.respond ?? undefined;
  if (respond) intent.respond = respond;
  if (value?.end_visit) intent.end_visit = true;
  const p = value?.save_preference;
  if (p) {
    if (quoteIsSubstring(p.quote, utterance)) intent.save_preference = { key: p.key, value: p.value, quote: p.quote };
    else meta.problems.push(`dropped preference "${p.key}": quote not in utterance`);
  }
  return { intent, meta };
}

// ---------- note ----------

const NoteOut = z.object({ body: z.string().min(1) });
export type NoteResult = { body: string; meta: CallMeta };

export async function writeNote(llm: Llm, dayFacts: DayFacts): Promise<NoteResult> {
  const messages: Message[] = [
    { role: 'system', content: NOTE_INSTRUCTIONS },
    { role: 'user', content: `FACTS:
${renderDayFacts(dayFacts)}` },
  ];
  const { value, meta } = await tryTwice(llm, messages, (m) =>
    jsonAttempt(llm, m, NoteOut, (v) => ({ value: v.body.trim(), problems: verifyNote(v.body, dayFacts) })),
  );
  return { body: value ?? templateNote(dayFacts), meta };
}
