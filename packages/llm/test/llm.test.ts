import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlm, extractJson, llmFromEnv, LlmHttpError, mergeSystemMessages, setLlmTracer, type LlmTracer } from '../src/index.js';

type Handler = (body: any, res: ServerResponse) => void;
let handler: Handler;
const requests: { url: string; body: any; auth?: string }[] = [];
let baseUrl = '';

const reply = (text: string): Handler => (_b, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      model: 'fake',
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );
};

const server = createServer((req: IncomingMessage, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data || '{}');
    requests.push({ url: req.url!, body, auth: req.headers.authorization });
    handler(body, res);
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests.length = 0;
});

describe('extractJson', () => {
  it('handles fences, prose and nested braces in strings', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Sure! {"a":{"b":"x}y"}} trailing {"c":2}')).toBe('{"a":{"b":"x}y"}}');
    expect(extractJson('no json here')).toBeNull();
  });
});

describe('mergeSystemMessages', () => {
  it('folds system into first user message', () => {
    expect(
      mergeSystemMessages([
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
        { role: 'user', content: 'U2' },
      ]),
    ).toEqual([
      { role: 'user', content: 'S\n\nU' },
      { role: 'user', content: 'U2' },
    ]);
  });
});

describe('client against fake server', () => {
  const msgs = [
    { role: 'system' as const, content: 'be calm' },
    { role: 'user' as const, content: 'hi' },
  ];

  it('chat returns text, usage, latency; strips trailing slash; sends key', async () => {
    handler = reply('hello');
    const llm = createLlm({ baseUrl, apiKey: 'k', model: 'llama3.2' });
    const r = await llm.chat(msgs, { temperature: 0.2, maxTokens: 50 });
    expect(r).toMatchObject({ text: 'hello', usage: { tokens_in: 10, tokens_out: 5 }, model: 'fake' });
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    expect(requests[0]!.url).toBe('/v1/chat/completions');
    expect(requests[0]!.auth).toBe('Bearer k');
    expect(requests[0]!.body).toMatchObject({ temperature: 0.2, max_tokens: 50 });
    expect(requests[0]!.body.messages).toHaveLength(2); // non-gemma: system kept
  });

  it('mergeSystem defaults on for gemma models', async () => {
    handler = reply('ok');
    await createLlm({ baseUrl, model: 'gemma-3-27b-it' }).chat(msgs);
    expect(requests[0]!.body.messages).toEqual([{ role: 'user', content: 'be calm\n\nhi' }]);
    await createLlm({ baseUrl, model: 'gemma3:1b', mergeSystem: false }).chat(msgs);
    expect(requests[1]!.body.messages).toHaveLength(2);
  });

  it('chatStream yields deltas and stops at [DONE]', async () => {
    handler = (_b, res) => {
      res.setHeader('content-type', 'text/event-stream');
      const chunk = (c: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
      res.write(': keepalive\n\n' + chunk('Hel'));
      res.write(chunk('lo') + 'data: {"choices":[{"delta":{}}]}\n\n');
      res.end('data: [DONE]\n\n' + chunk('IGNORED'));
    };
    const parts: string[] = [];
    for await (const d of createLlm({ baseUrl, model: 'm' }).chatStream(msgs)) parts.push(d);
    expect(parts).toEqual(['Hel', 'lo']);
    expect(requests[0]!.body.stream).toBe(true);
  });

  const schema = z.object({ script: z.string(), reason: z.string() });

  it('json extracts from fenced output and validates', async () => {
    handler = reply('Here you go:\n```json\n{"script":"Go out","reason":"tide"}\n```');
    const r = await createLlm({ baseUrl, model: 'm' }).json(msgs, schema);
    expect(r).toMatchObject({ ok: true, value: { script: 'Go out', reason: 'tide' } });
    expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('json returns ok:false on zod failure / no json, never throws', async () => {
    handler = reply('{"script": 5}');
    const r = await createLlm({ baseUrl, model: 'm' }).json(msgs, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raw).toBe('{"script": 5}');
    handler = reply('I cannot do that');
    expect((await createLlm({ baseUrl, model: 'm' }).json(msgs, schema)).ok).toBe(false);
  });

  it('json retries once without response_format on 400', async () => {
    handler = (body, res) => {
      if (body.response_format) {
        res.statusCode = 400;
        return res.end('{"error":"JSON mode is not enabled for this model"}');
      }
      reply('{"script":"a","reason":"b"}')(body, res);
    };
    const r = await createLlm({ baseUrl, model: 'm' }).json(msgs, schema);
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.response_format).toBeUndefined();
  });

  it('throws LlmHttpError with status + body on HTTP errors', async () => {
    handler = (_b, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    const err = await createLlm({ baseUrl, model: 'm' }).chat(msgs).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(500);
    expect(err.message).toContain('boom');
    // json does not swallow transport errors
    await expect(createLlm({ baseUrl, model: 'm' }).json(msgs, schema)).rejects.toThrow(/500/);
  });

  it('times out', async () => {
    handler = (b, res) => setTimeout(() => reply('late')(b, res), 500);
    await expect(createLlm({ baseUrl, model: 'm', timeoutMs: 50 }).chat(msgs)).rejects.toThrow(/timeout after 50ms/);
  });

  it('embed returns vectors in index order', async () => {
    handler = (_b, res) =>
      res.end(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }));
    expect(await createLlm({ baseUrl, model: 'e' }).embed(['a', 'b'])).toEqual([[1], [2]]);
    expect(requests[0]).toMatchObject({ url: '/v1/embeddings', body: { model: 'e', input: ['a', 'b'] } });
  });

  it('tracer sees op, model, tokens and errors (global + per-client)', async () => {
    const seen: unknown[] = [];
    const tracer: LlmTracer = (call) => (r) => seen.push({ ...call, ...r, error: r.error ? 'err' : undefined });
    handler = reply('hi');
    await createLlm({ baseUrl, model: 'm', tracer }).chat(msgs);
    handler = (_b, res) => ((res.statusCode = 500), res.end('x'));
    setLlmTracer(tracer);
    try {
      await createLlm({ baseUrl, model: 'g' }).chat(msgs).catch(() => {});
    } finally {
      setLlmTracer(undefined);
    }
    expect(seen).toMatchObject([
      { op: 'chat', model: 'm', tokens_in: 10, tokens_out: 5, latency_ms: expect.any(Number) },
      { op: 'chat', model: 'g', error: 'err' },
    ]);
  });
});

describe('llmFromEnv', () => {
  it('uses defaults and env overrides', () => {
    expect(llmFromEnv('chat', {}).model).toBe('gemma3:1b');
    expect(llmFromEnv('script', {}).model).toBe('gemma3:4b');
    expect(llmFromEnv('note', {}).model).toBe('gemma3:4b');
    expect(llmFromEnv('embed', {}).model).toBe('nomic-embed-text');
    expect(llmFromEnv('chat', { LLM_MODEL_CHAT: 'x' }).model).toBe('x');
  });
});

describe.skipIf(!process.env.LIVE)('LIVE Ollama', () => {
  const env = { ...process.env, LLM_BASE_URL: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1' };
  it('chat + stream + json + embed', async () => {
    const llm = llmFromEnv('chat', env);
    const r = await llm.chat([{ role: 'user', content: 'Say hi in 3 words.' }], { maxTokens: 20 });
    console.log('[live chat]', llm.model, r);
    expect(r.text.length).toBeGreaterThan(0);

    let streamed = '';
    for await (const d of llm.chatStream([{ role: 'user', content: 'Count 1 to 3.' }], { maxTokens: 20 })) streamed += d;
    console.log('[live stream]', streamed);
    expect(streamed.length).toBeGreaterThan(0);

    const j = await llm.json(
      [{ role: 'user', content: 'Return JSON {"bird": string, "count": number} for 6 Little Egrets.' }],
      z.object({ bird: z.string(), count: z.number() }),
    );
    console.log('[live json]', j);
    expect(j.ok).toBe(true);

    const v = await llmFromEnv('embed', env).embed(['egret', 'kingfisher']);
    expect(v).toHaveLength(2);
    expect(v[0]!.length).toBeGreaterThan(100);
  }, 120_000);
});

import { stripThinking, thinkingFilter } from '../src/index';

describe('thinking blocks (Gemma 4)', () => {
  it('strips a leading thought block', () => {
    expect(stripThinking('<thought>plan {"a":1}</thought>\n{"reply":"hi"}')).toBe('{"reply":"hi"}');
    expect(stripThinking('no thoughts here')).toBe('no thoughts here');
  });
  it('filters a thought block split across stream deltas', () => {
    const f = thinkingFilter();
    const out = ['<tho', 'ught>secret', ' stuff</tho', 'ught>\nHel', 'lo'].map(f).join('');
    expect(out).toBe('Hello');
  });
  it('passes through streams without thinking', () => {
    const f = thinkingFilter();
    expect(['<b', 'old> hi'].map(f).join('')).toBe('<bold> hi');
  });
});
