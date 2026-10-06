import * as Sentry from "@sentry/node";
import { describe, expect, it } from "vitest";
import { createLlm } from "@sitspot/llm";
import { activityInterceptor, llmTracer, sentryOptions, withSpan } from "../src/observability";

const SECRET = "call me on +919876543210 about the mudflats";

describe("withSpan with Sentry off (no DSN)", () => {
  it("returns fn's value and propagates errors", async () => {
    expect(Sentry.isEnabled()).toBe(false);
    expect(await withSpan("x", "test", { a: 1 }, (set) => (set({ b: 2 }), 42))).toBe(42);
    await expect(withSpan("x", "test", {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

describe("with Sentry on (fake transport)", () => {
  it("LLM span carries model + tokens and no utterance text; activities get ids", async () => {
    const sent: unknown[] = [];
    Sentry.init({
      ...sentryOptions({ SENTRY_DSN_API: "https://public@o0.ingest.sentry.io/1", NODE_ENV: "test" }, "test"),
      transport: () => ({ send: async (e) => (sent.push(e), {}), flush: async () => true }),
    });
    try {
      expect(await withSpan("ok", "test", {}, () => 7)).toBe(7);
      await expect(withSpan("bad", "test", {}, () => { throw new Error("nope"); })).rejects.toThrow("nope");

      const fakeFetch = (async () =>
        new Response(JSON.stringify({ model: "gemma-x", choices: [{ message: { content: "Sounds lovely." } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }))) as typeof fetch;
      const llm = createLlm({ baseUrl: "http://llm.invalid/v1", model: "gemma-x", fetch: fakeFetch, tracer: llmTracer });
      expect((await llm.chat([{ role: "user", content: SECRET }])).text).toBe("Sounds lovely.");

      const execute = activityInterceptor({ info: { activityType: "deliver", workflowExecution: { workflowId: "inv-wf" }, attempt: 1 } } as never).inbound!.execute!;
      expect(await execute({ args: ["11111111-2222-3333-4444-555555555555"], headers: {} }, async () => "done")).toBe("done");

      await Sentry.flush(2000);
      const wire = JSON.stringify(sent);
      expect(wire).toContain("gemma-x");
      expect(wire).toMatch(/"tokens_in"[^}]*12/);
      expect(wire).toMatch(/"tokens_out"[^}]*3/);
      expect(wire).toContain("gen_ai.chat");
      expect(wire).toContain("11111111-2222-3333-4444-555555555555"); // invitation_id on the activity span
      expect(wire).toContain("temporal.activity");
      expect(wire).not.toContain("+919876543210");
      expect(wire).not.toContain("mudflats");
      expect(wire).not.toContain("Sounds lovely");
    } finally {
      await Sentry.close();
    }
  });
});
