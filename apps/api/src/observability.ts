// Sentry helpers (spec §17.4). Every export is a passthrough until instrument.ts has called Sentry.init
// (i.e. SENTRY_DSN_API set). Attributes are ids, counts, models and latencies only — never phone
// numbers, transcripts, utterances, or coordinates.
import * as Sentry from "@sentry/node";
import type { Hono, MiddlewareHandler } from "hono";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import type { LlmTracer } from "@sitspot/llm";

type Attrs = Record<string, string | number | boolean | undefined>;
const clean = (a: Attrs) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;

export const sentryEnabled = () => Sentry.isEnabled();

/** Run fn inside a span. `set` adds attributes known only after the work (counts, channel). */
export async function withSpan<T>(name: string, op: string, attrs: Attrs, fn: (set: (a: Attrs) => void) => T | Promise<T>): Promise<T> {
  if (!Sentry.isEnabled()) return fn(() => {});
  return Sentry.startSpan({ name, op, attributes: clean(attrs) }, (span) => fn((a) => span.setAttributes(clean(a))));
}

/** One span per LLM request: op gen_ai.chat / gen_ai.embeddings, name "<op> <model>". */
export const llmTracer: LlmTracer = ({ op, model }) => {
  const span = Sentry.startInactiveSpan({
    name: `${op === "embed" ? "embeddings" : "chat"} ${model}`,
    op: op === "embed" ? "gen_ai.embeddings" : "gen_ai.chat",
    attributes: { model, "gen_ai.request.model": model, "gen_ai.operation.name": op, stream: op === "stream" },
  });
  return ({ latency_ms, tokens_in, tokens_out, error }) => {
    span.setAttributes(clean({
      latency_ms, tokens_in, tokens_out, "gen_ai.usage.input_tokens": tokens_in, "gen_ai.usage.output_tokens": tokens_out,
    }));
    if (error) {
      span.setStatus({ code: 2, message: "internal_error" });
      Sentry.captureException(error, { tags: { component: "llm", model } });
    }
    span.end();
  };
};

/** Request spans named by route + 5xx capture. Null when disabled. */
export const honoSentry = (app: Hono<any>): MiddlewareHandler | null => (Sentry.isEnabled() ? Sentry.honoMiddleware(app) : null);

// Activities whose first arg is a user id; the rest take an invitation id.
const USER_ARG = new Set(["evaluateWindows", "createInvitation", "reflect"]);

/** Temporal activity interceptor: one span per activity execution, failures captured with ids. */
export const activityInterceptor: ActivityInterceptorsFactory = (ctx) => ({
  inbound: {
    execute: (input, next) => {
      const name = ctx.info.activityType;
      const [first, second] = input.args as [unknown, { spot_id?: unknown } | undefined];
      const id = typeof first === "string" ? first : undefined;
      const attrs = clean({
        "temporal.activity": name,
        "temporal.workflow_id": ctx.info.workflowExecution?.workflowId,
        "temporal.attempt": ctx.info.attempt,
        ...(USER_ARG.has(name) ? { user_id: id } : { invitation_id: id }),
        spot_id: typeof second?.spot_id === "string" ? second.spot_id : undefined,
      });
      return withSpan(`activity ${name}`, "temporal.activity", attrs, async () => {
        try {
          return await next(input);
        } catch (e) {
          Sentry.captureException(e, { tags: { component: "temporal", activity: name }, contexts: { activity: attrs } });
          throw e;
        }
      });
    },
  },
});

const noQuery = (u: unknown) => (typeof u === "string" ? u.split("?")[0] : u);
const URL_ATTRS = ["url.full", "http.url", "http.target", "url.path", "url"];

/** Sentry.init options. Collect no bodies/headers/cookies/query strings/locals: note searches (?q=),
 *  Open-Meteo/eBird coordinates, phone numbers and transcripts never leave the process. */
export function sentryOptions(env: Record<string, string | undefined>, release?: string): Sentry.NodeOptions {
  return {
    dsn: env.SENTRY_DSN_API,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || "development",
    release,
    tracesSampleRate: 1.0, // hackathon: keep every trace
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      genAI: { inputs: false, outputs: false }, databaseQueryData: false, stackFrameVariables: false,
    },
    // Belt and braces: strip any query string that still made it into a span (v11 streams StreamedSpanJSON).
    beforeSendSpan(span) {
      span.name = noQuery(span.name) as string;
      for (const k of URL_ATTRS) if (typeof span.attributes[k] === "string") span.attributes[k] = noQuery(span.attributes[k]);
      for (const k of ["url.query", "http.query"]) delete span.attributes[k];
      return span;
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.query_string;
        delete event.request.data;
        delete event.request.cookies;
        event.request.url = noQuery(event.request.url) as string | undefined;
      }
      return event;
    },
    beforeBreadcrumb(b) {
      if (b.category === "console") return null; // log lines can quote provider errors (phone numbers)
      if (b.data?.url) b.data.url = noQuery(b.data.url);
      return b;
    },
  };
}
