import type { ZodType } from 'zod';

export type Role = 'system' | 'user' | 'assistant';
export interface Message {
  role: Role;
  content: string;
}
export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
}
export interface Usage {
  tokens_in: number;
  tokens_out: number;
}
export interface ChatResult {
  text: string;
  usage: Usage | null;
  latency_ms: number;
  model: string;
}
export type JsonResult<T> =
  | { ok: true; value: T; raw: string; usage: Usage | null; latency_ms: number }
  | { ok: false; error: string; raw: string };

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** Fold system messages into the first user message. Default: true when model name contains "gemma". */
  mergeSystem?: boolean;
  fetch?: typeof fetch;
}

export interface Llm {
  readonly model: string;
  chat(messages: Message[], opts?: ChatOpts): Promise<ChatResult>;
  chatStream(messages: Message[], opts?: ChatOpts): AsyncIterable<string>;
  json<T>(messages: Message[], schema: ZodType<T>, opts?: ChatOpts): Promise<JsonResult<T>>;
  embed(texts: string[]): Promise<number[][]>;
}

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`LLM HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }
}

export function mergeSystemMessages(messages: Message[]): Message[] {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content);
  if (!sys.length) return messages;
  const rest = messages.filter((m) => m.role !== 'system');
  const i = rest.findIndex((m) => m.role === 'user');
  const prefix = sys.join('\n\n');
  if (i === -1) return [{ role: 'user', content: prefix }, ...rest];
  return rest.map((m, j) => (j === i ? { role: 'user', content: `${prefix}\n\n${m.content}` } : m));
}

/** First balanced {...} in text (handles ```json fences and prose around it). */
export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = fenced?.[1]?.includes('{') ? fenced[1] : text;
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export function createLlm(cfg: LlmConfig): Llm {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? 30000;
  const doFetch = cfg.fetch ?? fetch;
  const merge = cfg.mergeSystem ?? /gemma/i.test(cfg.model);

  async function post(path: string, body: unknown): Promise<Response> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
        throw new Error(`LLM timeout after ${timeoutMs}ms: ${url}`);
      throw e;
    }
    if (!res.ok) throw new LlmHttpError(res.status, await res.text().catch(() => ''), url);
    return res;
  }

  function chatBody(messages: Message[], opts: ChatOpts, extra: Record<string, unknown> = {}) {
    return {
      model: cfg.model,
      messages: merge ? mergeSystemMessages(messages) : messages,
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
      ...extra,
    };
  }

  async function chatRaw(messages: Message[], opts: ChatOpts, extra?: Record<string, unknown>): Promise<ChatResult> {
    const t0 = performance.now();
    const res = await post('/chat/completions', chatBody(messages, opts, extra));
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: data.usage
        ? { tokens_in: data.usage.prompt_tokens ?? 0, tokens_out: data.usage.completion_tokens ?? 0 }
        : null,
      latency_ms: Math.round(performance.now() - t0),
      model: data.model ?? cfg.model,
    };
  }

  return {
    model: cfg.model,

    chat: (messages, opts = {}) => chatRaw(messages, opts),

    async *chatStream(messages, opts = {}) {
      const res = await post('/chat/completions', chatBody(messages, opts, { stream: true }));
      if (!res.body) return;
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
            if (delta) yield delta as string;
          } catch {
            // ponytail: skip malformed SSE lines rather than kill the stream
          }
        }
      }
    },

    async json(messages, schema, opts = {}) {
      let r: ChatResult;
      try {
        r = await chatRaw(messages, opts, { response_format: { type: 'json_object' } });
      } catch (e) {
        if (!(e instanceof LlmHttpError && e.status === 400)) throw e;
        r = await chatRaw(messages, opts); // provider rejected response_format (e.g. Gemma on AI Studio)
      }
      const raw = r.text;
      const found = extractJson(raw);
      if (!found) return { ok: false, error: 'no JSON object in output', raw };
      let parsed: unknown;
      try {
        parsed = JSON.parse(found);
      } catch (e) {
        return { ok: false, error: `invalid JSON: ${(e as Error).message}`, raw };
      }
      const v = schema.safeParse(parsed);
      if (!v.success) return { ok: false, error: v.error.message, raw };
      return { ok: true, value: v.data, raw, usage: r.usage, latency_ms: r.latency_ms };
    },

    async embed(texts) {
      const res = await post('/embeddings', { model: cfg.model, input: texts });
      const data = (await res.json()) as { data: { index?: number; embedding: number[] }[] };
      return [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
    },
  };
}

export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export type LlmKind = 'chat' | 'script' | 'note' | 'embed';

export function llmFromEnv(kind: LlmKind, env: Record<string, string | undefined> = process.env): Llm {
  const e = (k: string) => env[k]?.trim() || undefined;
  const mainBase = e('LLM_BASE_URL') ?? OLLAMA_BASE_URL;
  const key = e('LLM_API_KEY');
  switch (kind) {
    case 'chat':
      return createLlm({ baseUrl: mainBase, apiKey: key, model: e('LLM_MODEL_CHAT') ?? 'gemma3:1b' });
    case 'script':
      return createLlm({ baseUrl: mainBase, apiKey: key, model: e('LLM_MODEL_SCRIPT') ?? 'gemma3:4b' });
    case 'note': {
      // A separate NOTE_LLM_BASE_URL is local Ollama — don't leak the hosted key to it.
      const noteBase = e('NOTE_LLM_BASE_URL');
      return createLlm({
        baseUrl: noteBase ?? mainBase,
        apiKey: noteBase ? undefined : key,
        model: e('LLM_MODEL_NOTE') ?? 'gemma3:4b',
      });
    }
    case 'embed': {
      const embedBase = e('EMBED_BASE_URL') ?? OLLAMA_BASE_URL;
      return createLlm({
        baseUrl: embedBase,
        apiKey: embedBase === mainBase ? key : undefined,
        model: e('EMBED_MODEL') ?? 'nomic-embed-text',
      });
    }
  }
}
