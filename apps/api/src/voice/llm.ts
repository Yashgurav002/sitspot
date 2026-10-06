// ElevenLabs custom-LLM endpoint (spec §9.4, FR-17): OpenAI chat.completions in, OpenAI SSE chunks out.
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { chatTurnStream, extractIntent, type ChatResult, type InvitationFacts } from "@sitspot/agent";
import * as q from "@sitspot/db";
import type { Message } from "@sitspot/llm";
import type { Invitation } from "@sitspot/shared";
import { parsePreferenceValue } from "../services/memory";
import { buildInvitationFacts } from "./facts";
import type { VoiceDeps } from "./index";

type OaiMessage = { role?: string; content?: unknown };
type OaiRequest = {
  messages?: OaiMessage[];
  stream?: boolean;
  model?: string;
  elevenlabs_extra_body?: { invitation_id?: unknown; visit_id?: unknown } | null;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NO_INVITATION = "I don't have an open invitation right now, so I can't say much. I'll call when a good window comes up.";
const OPEN = new Set(["pending", "sent", "accepted", "declined", "no_answer", "arrived"]);

/** OpenAI content may be a string or an array of {type:'text', text} parts. */
const text = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "";

const idFrom = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v.match(UUID)![0] : null);
/** `invitation_id: <uuid>` in a system prompt that used {{invitation_id}}. */
const idInPrompt = (prompts: string, key: string) => idFrom(prompts.match(new RegExp(`${key}\\W{0,5}(${UUID.source})`, "i"))?.[1]);

/** Which invitation/visit this call is about: extra body → system prompt → the owner's open invitation. */
async function resolveTarget(d: VoiceDeps, body: OaiRequest): Promise<{ inv: Invitation; visitId: string | null } | null> {
  const prompts = (body.messages ?? []).filter((m) => m.role === "system").map((m) => text(m.content)).join("\n");
  const extra = body.elevenlabs_extra_body ?? {};
  const invId = idFrom(extra.invitation_id) ?? idInPrompt(prompts, "invitation_id");
  let visitId = idFrom(extra.visit_id) ?? idInPrompt(prompts, "visit_id");
  let inv = invId ? await q.getInvitation(d.db, invId) : null;
  if (!inv) inv = await q.openInvitation(d.db, await d.ownerId());
  if (!inv) return null;
  if (!visitId && inv.status === "arrived") {
    const v = await q.getVisitByInvitation(d.db, inv.id);
    if (v && !v.ended_at) visitId = v.id;
  }
  return { inv, visitId };
}

async function applyIntent(d: VoiceDeps, inv: Invitation, utterance: string, lastReply: string) {
  const { intent, meta } = await extractIntent(d.llm, { utterance, lastReply });
  await d.log({ invitation_id: inv.id, kind: "intent", model: meta.model, tokens_in: meta.tokens_in, tokens_out: meta.tokens_out, latency_ms: meta.latency_ms });
  if (intent.respond && OPEN.has(inv.status) && inv.status !== "arrived") {
    const target = intent.respond === "accept" ? "accepted" : "declined";
    if (inv.status !== target) await d.respond(inv, intent.respond === "accept");
  }
  if (intent.save_preference) {
    const p = intent.save_preference;
    const v = parsePreferenceValue(p.key, p.value);
    if (!v.ok) console.warn(`[voice] dropped preference: ${v.error}`);
    else await q.addPreference(d.db, inv.user_id, { key: p.key, value: v.value, source_utterance: p.quote });
  }
}

/** Reply chunks + a promise that settles after side effects (intent, logging). Never rejects. */
async function turn(d: VoiceDeps, body: OaiRequest): Promise<{ chunks: AsyncIterable<string>; done: Promise<void> }> {
  const target = await resolveTarget(d, body);
  const convo = (body.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): Message => ({ role: m.role as "user" | "assistant", content: text(m.content) }))
    .filter((m) => m.content.trim());
  const lastUser = convo.findLastIndex((m) => m.role === "user");
  const once = (s: string) => ({ chunks: (async function* () { yield s; })(), done: Promise.resolve() });

  if (!target) return once(NO_INVITATION);
  const { inv, visitId } = target;
  // Agent's opening turn (no user speech yet): the stored script.
  if (lastUser === -1) return once(inv.script ?? NO_INVITATION);

  const utterance = convo[lastUser]!.content;
  const history = convo.slice(0, lastUser);
  const lastReply = history.findLast((m) => m.role === "assistant")?.content ?? inv.script ?? "";
  const facts: InvitationFacts | null = await buildInvitationFacts(d.db, inv.id, d.now(), visitId);
  if (!facts) return once(NO_INVITATION);

  const intentDone = applyIntent(d, inv, utterance, lastReply).catch((e) => console.error("[voice] intent failed:", (e as Error).message));
  const gen = chatTurnStream(d.llm, { facts, history, utterance });
  let result: ChatResult | undefined;
  let finish!: () => void;
  const streamed = new Promise<void>((r) => (finish = r));
  const chunks = (async function* () {
    try {
      for (let n = await gen.next(); ; n = await gen.next()) {
        if (n.done) { result = n.value; break; }
        yield n.value;
      }
    } finally {
      finish();
    }
  })();
  const done = Promise.all([intentDone, streamed]).then(async () => {
    const m = result?.meta;
    if (m) await d.log({ invitation_id: inv.id, kind: "chat", model: m.model, tokens_in: m.tokens_in, tokens_out: m.tokens_out, latency_ms: m.latency_ms });
  }).catch((e) => console.error("[voice] log failed:", (e as Error).message));
  return { chunks, done };
}

export async function chatCompletions(c: Context, d: VoiceDeps) {
  let body: OaiRequest;
  try {
    body = (await c.req.json()) as OaiRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || d.llm.model;
  const { chunks, done } = await turn(d, body);

  if (!body.stream) {
    let content = "";
    for await (const s of chunks) content += s;
    await done;
    return c.json({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
  }

  const chunk = (delta: Record<string, string>, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-cache");
  return stream(c, async (s) => {
    await s.write(chunk({ role: "assistant", content: "" }));
    for await (const t of chunks) await s.write(chunk({ content: t }));
    await done; // intent applied before the stream ends: [DONE] means the turn is fully handled
    await s.write(chunk({}, "stop"));
    await s.write("data: [DONE]\n\n");
  }, async (err, s) => {
    console.error("[voice] stream error:", err.message);
    await s.write("data: [DONE]\n\n");
  });
}
