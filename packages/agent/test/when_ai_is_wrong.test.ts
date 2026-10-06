// Hallucinating / broken model outputs must never reach the user.
import { describe, expect, it } from 'vitest';
import { chatTurn, chatTurnStream, checkScript, composeScript, extractIntent, templateChat, templateNote, templateScript, verifyNote, writeNote } from '../src/index.js';
import { creek, fakeLlm, park, visitDay } from './fixtures.js';

const j = (o: unknown) => JSON.stringify(o);
const good = { script: 'Creek edge is good now. Low tide is at 17:20 and falling, and 6 Little Egrets were seen. Leave by 17:05; it stays good until 18:05. Stay on firm ground. Want to go?', reason: 'Falling tide with low at 17:20.' };

describe('composeScript', () => {
  it('accepts a grounded script on the first try', async () => {
    const { llm } = fakeLlm([j(good)]);
    const r = await composeScript(llm, creek);
    expect(r.script).toBe(good.script);
    expect(r.meta).toMatchObject({ attempts: 1, fallback: false, model: 'fake', tokens_in: 10, tokens_out: 5 });
  });

  it('invented species → rejected twice → template', async () => {
    const bad = j({ ...good, script: good.script.replace('Little Egrets', 'Greater Flamingos') });
    const { llm, calls } = fakeLlm([bad, bad]);
    const r = await composeScript(llm, creek);
    expect(r.meta.fallback).toBe(true);
    expect(r.meta.attempts).toBe(2);
    expect(r.script).toBe(templateScript(creek).script);
    expect(r.meta.problems.join()).toContain('greater flamingo');
    // the retry carried the problems back to the model
    expect(calls[1]!.at(-1)!.content).toContain('species "greater flamingo" is not in the facts');
  });

  it('retry fixes it → model output used', async () => {
    const bad = j({ ...good, script: good.script.replace('17:20', '18:40') });
    const { llm } = fakeLlm([bad, j(good)]);
    const r = await composeScript(llm, creek);
    expect(r).toMatchObject({ script: good.script, meta: { attempts: 2, fallback: false, tokens_in: 20 } });
  });

  it('invented numbers → rejected', async () => {
    const bad = j({ ...good, script: good.script.replace('17:20', '18:40'), reason: 'It is 24°C.' });
    const { llm } = fakeLlm([bad, bad]);
    const r = await composeScript(llm, creek);
    expect(r.meta.fallback).toBe(true);
    expect(r.meta.problems).toEqual(['number "18:40" is not in the facts', 'reason: number "24" is not in the facts']);
  });

  it('coastal script without firm-ground line → rejected', async () => {
    const bad = j({ ...good, script: good.script.replace(' Stay on firm ground.', '') });
    const { llm } = fakeLlm([bad, bad]);
    const r = await composeScript(llm, creek);
    expect(r.meta.fallback).toBe(true);
    expect(r.script).toContain('Stay on firm ground.');
  });

  it('tells user to walk on the mudflats → rejected', async () => {
    const bad = j({ ...good, script: good.script.replace('Stay on firm ground.', 'Stay on firm ground, then walk out onto the mudflats.') });
    const { llm } = fakeLlm([bad, bad]);
    const r = await composeScript(llm, creek);
    expect(r.meta.fallback).toBe(true);
    expect(r.script).not.toMatch(/mudflat/i);
  });

  it('vague script with no leave time / end time → rejected', async () => {
    const vague = j({ script: 'Creek edge is a peaceful spot with lovely light. Stay on firm ground. Want to go?', reason: 'It is nice.' });
    const { llm } = fakeLlm([vague, vague]);
    const r = await composeScript(llm, creek);
    expect(r.meta.fallback).toBe(true);
    expect(r.meta.problems).toEqual(['script must say when to leave: "leave by 17:05"', 'script must say how long it stays good: "until 18:05"']);
  });

  it('invalid JSON twice → template', async () => {
    const { llm } = fakeLlm(['Sure! Here is your script: Creek edge is lovely', '{"script": ']);
    const r = await composeScript(llm, creek);
    expect(r.meta).toMatchObject({ attempts: 2, fallback: true });
    expect(r.script).toBe(templateScript(creek).script);
  });

  it('model throws → template, never throws', async () => {
    const { llm } = fakeLlm([new Error('LLM timeout after 30000ms')]);
    const r = await composeScript(llm, park);
    expect(r.meta).toMatchObject({ attempts: 1, fallback: true, problems: ['model error: LLM timeout after 30000ms'] });
    expect(checkScript(r, park)).toEqual([]);
  });

  it('appends "Want to go?" instead of rejecting', async () => {
    const { llm } = fakeLlm([j({ ...good, script: good.script.replace(' Want to go?', '') })]);
    expect((await composeScript(llm, creek)).script).toBe(good.script);
  });
});

describe('chatTurn', () => {
  const input = { facts: { ...creek, detections: [{ common_name: 'Red-vented Bulbul', confidence: 0.64, time: creek.now }] }, history: [], utterance: 'what is that?' };

  it('trims to 3 sentences and allows detected species', async () => {
    const { llm } = fakeLlm(['That is possibly a Red-vented Bulbul. Fairly confident, not certain. It is common here. Bulbuls love fruit.']);
    const r = await chatTurn(llm, input);
    expect(r.reply).toBe('That is possibly a Red-vented Bulbul. Fairly confident, not certain. It is common here.');
    expect(r.meta.fallback).toBe(false);
  });

  it('invented species twice → safe fallback', async () => {
    const { llm } = fakeLlm(['That is a Black Drongo.', 'Definitely an Asian Koel.']);
    const r = await chatTurn(llm, input);
    expect(r.reply).toBe(templateChat(input.facts));
    expect(r.reply).toMatch(/^I'm not sure/);
    expect(r.meta).toMatchObject({ attempts: 2, fallback: true });
  });

  it('unsafe advice → retried', async () => {
    const { llm } = fakeLlm(['Wade in for a closer look.', 'Stay on firm ground and listen.']);
    const r = await chatTurn(llm, input);
    expect(r.reply).toBe('Stay on firm ground and listen.');
    expect(r.meta.attempts).toBe(2);
  });

  it('numbers the user said are fine to repeat', async () => {
    const { llm } = fakeLlm(['Sure, see you in 40 minutes.']);
    const r = await chatTurn(llm, { ...input, utterance: 'I can be there in 40 minutes' });
    expect(r.meta.fallback).toBe(false);
  });

  it('model throws → fallback, and the stream yields the same text', async () => {
    const { llm } = fakeLlm([new Error('boom')]);
    const gen = chatTurnStream(llm, input);
    let text = '';
    let res = await gen.next();
    while (!res.done) {
      text += res.value;
      res = await gen.next();
    }
    expect(text).toBe(templateChat(input.facts));
    expect(res.value.meta.fallback).toBe(true);
  });
});

describe('extractIntent', () => {
  it('obvious yes skips the model', async () => {
    const { llm, calls } = fakeLlm([]);
    const r = await extractIntent(llm, { utterance: "Yes, let's go!", lastReply: 'Want to go?' });
    expect(r.intent).toEqual({ respond: 'accept' });
    expect(calls).toHaveLength(0);
  });

  it('keeps a preference whose quote is in the utterance', async () => {
    const utterance = "Not today. The creek is too far on weekdays.";
    const { llm } = fakeLlm([j({ save_preference: { key: 'spot_weekends_only', value: 'Creek edge', quote: 'the creek is too far on weekdays' }, respond: 'decline', end_visit: false })]);
    const r = await extractIntent(llm, { utterance, lastReply: 'Want to go?' });
    expect(r.intent).toEqual({ respond: 'decline', save_preference: { key: 'spot_weekends_only', value: 'Creek edge', quote: 'the creek is too far on weekdays' } });
  });

  it('fabricated quote → preference dropped', async () => {
    const { llm } = fakeLlm([j({ save_preference: { key: 'avoid_mornings', value: true, quote: 'I hate mornings' }, respond: null, end_visit: null })]);
    const r = await extractIntent(llm, { utterance: 'How long will it stay good?', lastReply: 'Want to go?' });
    expect(r.intent).toEqual({});
    expect(r.meta.problems[0]).toContain('quote not in utterance');
  });

  it('regex decline wins over a model accept', async () => {
    const { llm } = fakeLlm([j({ respond: 'accept' })]);
    const r = await extractIntent(llm, { utterance: 'Sounds lovely but not today, I have work', lastReply: '' });
    expect(r.intent.respond).toBe('decline');
  });

  it('invalid JSON twice / throws → rules-only intent', async () => {
    const a = await extractIntent(fakeLlm(['nope', 'still nope']).llm, { utterance: 'what a nice evening it is today', lastReply: '' });
    expect(a).toMatchObject({ intent: {}, meta: { fallback: true, attempts: 2 } });
    const b = await extractIntent(fakeLlm([new Error('down')]).llm, { utterance: 'no thanks, I am busy this evening', lastReply: '' });
    expect(b.intent).toEqual({ respond: 'decline' });
  });
});

describe('writeNote', () => {
  it('accepts a verified note', async () => {
    const body = 'We heard 3 Red-vented Bulbuls from 17:29 and 2 Common Kingfishers.';
    const r = await writeNote(fakeLlm([j({ body })]).llm, visitDay);
    expect(r).toMatchObject({ body, meta: { fallback: false } });
  });

  it('invented species / counts → template', async () => {
    const { llm } = fakeLlm([j({ body: 'A Brahminy Kite circled.' }), j({ body: 'We heard 7 Common Kingfishers.' })]);
    const r = await writeNote(llm, visitDay);
    expect(r.body).toBe(templateNote(visitDay));
    expect(verifyNote(r.body, visitDay)).toEqual([]);
    expect(r.meta).toMatchObject({ fallback: true, attempts: 2 });
  });

  it('model throws → template', async () => {
    const r = await writeNote(fakeLlm([new Error('503')]).llm, visitDay);
    expect(r.body).toBe(templateNote(visitDay));
  });
});
