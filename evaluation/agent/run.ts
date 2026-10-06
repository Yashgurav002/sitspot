// Agent eval runner. Writes raw records; agent/report.ts turns them into agent_results.md.
//   tsx agent/run.ts chat     -> 40 chatTurn cases on CHAT model (Ollama gemma3:1b)   -> agent/chat_raw.jsonl
//   tsx agent/run.ts script   -> 10 composeScript cases on SCRIPT model (AI Studio)   -> agent/script_raw.jsonl
import { appendFileSync, writeFileSync } from 'node:fs';
import { chatTurn, composeScript, templateScript } from '@sitspot/agent';
import { llmFromEnv, type Llm } from '@sitspot/llm';
import { CHAT_CASES, SCRIPT_CASES } from './cases.js';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const mode = process.argv[2];

/** Wrap an Llm so every raw model output (before validators/truncation) is recorded. */
function recording(llm: Llm) {
  const log: string[] = [];
  const wrapped: Llm = {
    ...llm,
    model: llm.model,
    chat: async (m, o) => {
      const r = await llm.chat(m, o);
      log.push(r.text);
      return r;
    },
    json: async (m, s, o) => {
      const r = await llm.json(m, s, o);
      log.push(r.raw);
      return r;
    },
  };
  return { llm: wrapped, log };
}

if (mode === 'chat') {
  const out = new URL('./chat_raw.jsonl', import.meta.url);
  writeFileSync(out, '');
  const base = llmFromEnv('chat');
  for (const k of CHAT_CASES) {
    const { llm, log } = recording(base);
    const history = k.onCall ? [{ role: 'assistant' as const, content: templateScript(k.facts).script }] : [];
    const t0 = performance.now();
    const r = await chatTurn(llm, { facts: k.facts, history, utterance: k.utterance });
    const wall_ms = Math.round(performance.now() - t0);
    const rec = { id: k.id, tag: k.tag, model: base.model, utterance: k.utterance, raw: log, final: r.reply, fallback: r.meta.fallback, attempts: r.meta.attempts, problems: r.meta.problems, wall_ms };
    appendFileSync(out, JSON.stringify(rec) + '\n');
    console.log(k.id, wall_ms, 'ms', r.meta.fallback ? 'FALLBACK' : 'ok', '|', r.reply);
  }
} else if (mode === 'script') {
  const out = new URL('./script_raw.jsonl', import.meta.url);
  writeFileSync(out, '');
  const base = llmFromEnv('script');
  for (const k of SCRIPT_CASES) {
    const { llm, log } = recording(base);
    const t0 = performance.now();
    const r = await composeScript(llm, k.facts);
    const wall_ms = Math.round(performance.now() - t0);
    const rec = { id: k.id, tag: `script-${k.facts.spot.kind}`, model: base.model, raw: log, final: r.script, reason: r.reason, fallback: r.meta.fallback, attempts: r.meta.attempts, problems: r.meta.problems, wall_ms };
    appendFileSync(out, JSON.stringify(rec) + '\n');
    console.log(k.id, wall_ms, 'ms', r.meta.fallback ? 'FALLBACK' : 'ok', '|', r.meta.problems.join('; '), '|', r.script);
  }
} else {
  console.error('usage: tsx agent/run.ts chat|script');
  process.exit(1);
}
