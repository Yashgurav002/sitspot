// Benchmark 5 (LLM part only): chat latency on local Ollama, gemma3:1b vs gemma3:4b, 20 turns each.
//   tsx agent/latency.ts   -> agent/latency_raw.csv
// Per turn: (1) model TTFT/total via llm.chatStream on the exact chatTurn prompt; (2) what the voice endpoint
// delivers: chatTurnStream time-to-first-chunk and total (it validates the full reply before yielding).
import { writeFileSync } from 'node:fs';
import { buildContextBlock, CHAT_INSTRUCTIONS, chatTurnStream, SYSTEM_PROMPT, templateScript } from '@sitspot/agent';
import { createLlm, OLLAMA_BASE_URL, type Message } from '@sitspot/llm';
import { CHAT_CASES } from './cases.js';

const MODELS = ['gemma3:1b', 'gemma3:4b'];
const cases = CHAT_CASES.slice(0, 20);
const rows = ['model,case,model_ttft_ms,model_total_ms,pipeline_first_chunk_ms,pipeline_total_ms,fallback'];

for (const model of MODELS) {
  const llm = createLlm({ baseUrl: OLLAMA_BASE_URL, model, timeoutMs: 180_000 });
  const t = performance.now();
  await llm.chat([{ role: 'user', content: 'Say ok.' }], { maxTokens: 5 }); // load model; excluded
  console.log(model, 'warm-up (load) ms', Math.round(performance.now() - t));
  for (const k of cases) {
    const history: Message[] = k.onCall ? [{ role: 'assistant', content: templateScript(k.facts).script }] : [];
    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${CHAT_INSTRUCTIONS}\n\nCONTEXT:\n${buildContextBlock(k.facts)}` },
      ...history,
      { role: 'user', content: k.utterance },
    ];
    let t0 = performance.now();
    let ttft = -1;
    for await (const _ of llm.chatStream(messages, { temperature: 0.5, maxTokens: 200 })) if (ttft < 0) ttft = performance.now() - t0;
    const mTotal = performance.now() - t0;

    t0 = performance.now();
    let first = -1;
    const gen = chatTurnStream(llm, { facts: k.facts, history, utterance: k.utterance });
    let r = await gen.next();
    while (!r.done) {
      if (first < 0) first = performance.now() - t0;
      r = await gen.next();
    }
    const pTotal = performance.now() - t0;
    const row = [model, k.id, Math.round(ttft), Math.round(mTotal), Math.round(first), Math.round(pTotal), r.value.meta.fallback].join(',');
    rows.push(row);
    console.log(row);
  }
}
writeFileSync(new URL('./latency_raw.csv', import.meta.url), rows.join('\n') + '\n');
