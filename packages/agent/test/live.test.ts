// LIVE=1 pnpm --filter @sitspot/agent test   (needs Ollama; LIVE_MODEL defaults to gemma3:1b)
import { createLlm, OLLAMA_BASE_URL } from '@sitspot/llm';
import { describe, expect, it } from 'vitest';
import { checkScript, composeScript, templateScript } from '../src/index.js';
import { creek } from './fixtures.js';

describe.skipIf(!process.env.LIVE)('LIVE Ollama composeScript', () => {
  it('passes validators or falls back', { timeout: 300_000 }, async () => {
    const llm = createLlm({ baseUrl: OLLAMA_BASE_URL, model: process.env.LIVE_MODEL ?? 'gemma3:1b', timeoutMs: 120_000 });
    const r = await composeScript(llm, creek);
    console.log(JSON.stringify(r, null, 2));
    if (r.meta.fallback) expect(r.script).toBe(templateScript(creek).script);
    expect(checkScript(r, creek)).toEqual([]);
  });
});
