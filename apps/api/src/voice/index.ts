// Voice routes. `voicePublic` is mounted before the /v1 session guard (ElevenLabs calls it);
// `voiceSession` after it (the web app calls it with a session cookie).
import { Hono } from "hono";
import * as q from "@sitspot/db";
import type { Db } from "@sitspot/db";
import type { Llm } from "@sitspot/llm";
import type { Invitation } from "@sitspot/shared";
import { safeEqual } from "../auth";
import { ELEVENLABS_API } from "../delivery/call";
import type { PushSender } from "../delivery/push";
import { chatCompletions } from "./llm";
import { postCall } from "./webhook";

export { buildInvitationFacts } from "./facts";

export type VoiceDeps = {
  db: Db;
  env: Record<string, string | undefined>;
  now: () => Date;
  llm: Llm;
  fetch?: typeof fetch;
  push?: PushSender;
  /** Same effect as POST /v1/invitations/:id/respond (status + responded signal). */
  respond: (inv: Invitation, accepted: boolean) => Promise<unknown>;
  /** The single owner's user id: fallback when a call carries no invitation id. */
  ownerId: () => Promise<string>;
  log: (r: Parameters<typeof q.logAgentRun>[1]) => Promise<unknown>;
};

export function voicePublic(d: VoiceDeps) {
  const app = new Hono();
  const llm = async (c: Parameters<typeof chatCompletions>[0]) => {
    const want = d.env.VOICE_SHARED_SECRET;
    if (!want) return c.json({ error: "VOICE_SHARED_SECRET not configured" }, 503);
    // X-Voice-Secret, or the custom LLM's API-key secret (sent as Authorization: Bearer).
    const got = c.req.header("x-voice-secret") ?? c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!safeEqual(got, want)) return c.json({ error: "unauthorized" }, 401);
    return chatCompletions(c, d);
  };
  app.post("/llm/chat/completions", llm);
  app.post("/llm/v1/chat/completions", llm); // in case the server URL is entered without /v1 and ElevenLabs appends it
  app.post("/webhooks/post-call", (c) => postCall(c, d));
  return app;
}

export function voiceSession(d: VoiceDeps) {
  const app = new Hono<{ Variables: { uid: string } }>();
  app.get("/session/:invitationId", async (c) => {
    const invId = c.req.param("invitationId");
    const inv = /^[0-9a-f-]{36}$/i.test(invId) ? await q.getInvitation(d.db, invId) : null;
    if (!inv || inv.user_id !== c.var.uid) return c.json({ error: "not found" }, 404);
    const { ELEVENLABS_API_KEY: key, ELEVENLABS_AGENT_ID: agent_id } = d.env;
    if (!key || !agent_id) return c.json({ agent_id: null, signed_url: null, script: inv.script });
    try {
      const res = await (d.fetch ?? fetch)(`${ELEVENLABS_API}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agent_id)}`, {
        headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { signed_url } = (await res.json()) as { signed_url?: string };
      return c.json({ agent_id, signed_url: signed_url ?? null, script: inv.script });
    } catch (e) {
      console.warn("[voice] signed url failed:", (e as Error).message);
      return c.json({ agent_id, signed_url: null, script: inv.script });
    }
  });
  return app;
}
