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
  /** Per-client tracer; falls back to the global one from setLlmTracer. */
  tracer?: LlmTracer;
}

/** Observability hook: called when a request starts; the returned fn is called once when it ends.
 *  Gets ids/counts only — never message text. */
export type LlmTracer = (call: { op: 'chat' | 'stream' | 'embed'; model: string }) => (result: {
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
  error?: unknown;
}) => void;

let globalTracer: LlmTracer | undefined;
/** Install a tracer for every client, including ones created before this call. */
export function setLlmTracer(t: LlmTracer | undefined): void {
  globalTracer = t;
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

const THINK = /^\s*<(thought|think)>[\s\S]*?<\/(?:thought|think)>\s*/;

/** Drop a leading <thought>…</thought> / <think>…</think> block (Gemma 4 on AI Studio can't turn thinking off). */
export function stripThinking(text: string): string {
  return text.replace(THINK, '');
}

/** Streaming version: hides a leading thinking block, passes everything else through. */
export function thinkingFilter(): (delta: string) => string {
  let buf = '';
  let state: 'pending' | 'inside' | 'out' = 'pending';
  return (delta) => {
    if (state === 'out') return delta;
    buf += delta;
    if (state === 'pending') {
      const t = buf.trimStart();
      const open = ['<thought>', '<think>'].find((o) => t.startsWith(o));
      if (!open) {
        if (['<thought>', '<think>'].some((o) => o.startsWith(t))) return ''; // could still become a tag
        state = 'out';
        const out = buf;
        buf = '';
        return out;
      }
      state = 'inside';
    }
    const m = buf.match(/<\/(thought|think)>\s*/);
    if (!m || m.index === undefined) return '';
    state = 'out';
    const out = buf.slice(m.index + m[0].length);
    buf = '';
    return out;
  };
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

  /** Run fn under the tracer (if any). fn returns the value plus token counts for the span. */
  async function traced<T>(op: 'chat' | 'stream' | 'embed', fn: () => Promise<{ value: T; usage?: Usage | null }>): Promise<T> {
    const end = (cfg.tracer ?? globalTracer)?.({ op, model: cfg.model });
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      const { value, usage } = await fn();
      end?.({ latency_ms: ms(), ...usage });
      return value;
    } catch (error) {
      end?.({ latency_ms: ms(), error });
      throw error;
    }
  }

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

  const chatRaw = (messages: Message[], opts: ChatOpts, extra?: Record<string, unknown>) =>
    traced('chat', async () => {
      const value = await chatOnce(messages, opts, extra);
      return { value, usage: value.usage };
    });

  async function chatOnce(messages: Message[], opts: ChatOpts, extra?: Record<string, unknown>): Promise<ChatResult> {
    const t0 = performance.now();
    const res = await post('/chat/completions', chatBody(messages, opts, extra));
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: stripThinking(data.choices?.[0]?.message?.content ?? ''),
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
      const end = (cfg.tracer ?? globalTracer)?.({ op: 'stream', model: cfg.model });
      const t0 = performance.now();
      let usage: Usage | undefined;
      let error: unknown;
      try {
        yield* stream();
      } catch (e) {
        error = e;
        throw e;
      } finally {
        end?.({ latency_ms: Math.round(performance.now() - t0), ...usage, ...(error !== undefined && { error }) });
      }

      async function* stream(): AsyncGenerator<string> {
        const res = await post('/chat/completions', chatBody(messages, opts, { stream: true }));
        if (!res.body) return;
        const decoder = new TextDecoder();
        let buf = '';
        const unthink = thinkingFilter();
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
              const parsed = JSON.parse(payload);
              const u = parsed?.usage; // sent by providers that honour stream_options.include_usage
              if (u) usage = { tokens_in: u.prompt_tokens ?? 0, tokens_out: u.completion_tokens ?? 0 };
              const delta = parsed?.choices?.[0]?.delta?.content;
              const out = delta ? unthink(delta as string) : '';
              if (out) yield out;
            } catch {
              // ponytail: skip malformed SSE lines rather than kill the stream
            }
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

    embed: (texts) =>
      traced('embed', async () => {
        const res = await post('/embeddings', { model: cfg.model, input: texts });
        const data = (await res.json()) as {
          data: { index?: number; embedding: number[] }[];
          usage?: { prompt_tokens?: number };
        };
        const value = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
        return { value, usage: data.usage?.prompt_tokens != null ? { tokens_in: data.usage.prompt_tokens, tokens_out: 0 } : null };
      }),
  };
}

export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export type LlmKind = 'chat' | 'script' | 'note' | 'embed';

export function llmFromEnv(kind: LlmKind, env: Record<string, string | undefined> = process.env): Llm {
  const e = (k: string) => env[k]?.trim() || undefined;
  const mainBase = e('LLM_BASE_URL') ?? OLLAMA_BASE_URL;
  const key = e('LLM_API_KEY');
  // Scripts and notes are written ahead of time, so a slow thinking model (Gemma 4) is fine there.
  const slowTimeout = Number(e('LLM_TIMEOUT_MS') ?? 180_000);
  switch (kind) {
    case 'chat': {
      // Voice turns need low latency: CHAT_LLM_BASE_URL can point at local Ollama (no hosted key sent).
      const chatBase = e('CHAT_LLM_BASE_URL');
      return createLlm({ baseUrl: chatBase ?? mainBase, apiKey: chatBase ? undefined : key, model: e('LLM_MODEL_CHAT') ?? 'gemma3:1b' });
    }
    case 'script':
      return createLlm({ baseUrl: mainBase, apiKey: key, model: e('LLM_MODEL_SCRIPT') ?? 'gemma3:4b', timeoutMs: slowTimeout });
    case 'note': {
      // A separate NOTE_LLM_BASE_URL is local Ollama — don't leak the hosted key to it.
      const noteBase = e('NOTE_LLM_BASE_URL');
      return createLlm({
        baseUrl: noteBase ?? mainBase,
        apiKey: noteBase ? undefined : key,
        model: e('LLM_MODEL_NOTE') ?? 'gemma3:4b',
        timeoutMs: slowTimeout,
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
