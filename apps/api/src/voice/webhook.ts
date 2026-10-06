// ElevenLabs post-call webhook (FR-23). HMAC: header `ElevenLabs-Signature: t=<unix>,v0=<hex sha256(secret, "<t>.<raw body>")>`.
import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { firstSentences, quickRespond } from "@sitspot/agent";
import * as q from "@sitspot/db";
import { safeEqual } from "../auth";
import { sendPush } from "../delivery/push";
import type { VoiceDeps } from "./index";

const TOLERANCE_S = 30 * 60;

export function verifySignature(raw: string, header: string | undefined, secret: string, now: Date): boolean {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.trim().split(/=(.*)/s).slice(0, 2)));
  const t = Number(parts.t);
  if (!parts.v0 || !Number.isFinite(t) || Math.abs(now.getTime() / 1000 - t) > TOLERANCE_S) return false;
  return safeEqual(parts.v0, createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex"));
}

type Payload = {
  type?: string;
  data?: {
    conversation_id?: string;
    status?: string;
    failure_reason?: string;
    transcript?: { role?: string; message?: string | null }[];
    metadata?: { call_duration_secs?: number };
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
  };
};

const UNANSWERED = new Set(["pending", "sent"]);

export async function postCall(c: Context, d: VoiceDeps) {
  const secret = d.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "ELEVENLABS_WEBHOOK_SECRET not configured" }, 503);
  const raw = await c.req.text();
  if (!verifySignature(raw, c.req.header("elevenlabs-signature"), secret, d.now())) return c.json({ error: "invalid signature" }, 401);
  let p: Payload;
  try {
    p = JSON.parse(raw) as Payload;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const data = p.data ?? {};
  const invId = data.conversation_initiation_client_data?.dynamic_variables?.invitation_id;
  const inv = typeof invId === "string" && /^[0-9a-f-]{36}$/i.test(invId) ? await q.getInvitation(d.db, invId) : null;
  console.log(`[voice] webhook ${p.type} conversation=${data.conversation_id} invitation=${inv?.id ?? "?"} ${data.failure_reason ?? data.status ?? ""}`);
  if (!inv) return c.json({ ok: true, handled: false });

  if (p.type === "post_call_transcription") {
    await d.log({
      invitation_id: inv.id, kind: "call", model: "elevenlabs", trace_id: data.conversation_id ?? null,
      latency_ms: data.metadata?.call_duration_secs != null ? Math.round(data.metadata.call_duration_secs * 1000) : null,
    });
    // Safety net: the live endpoint normally records the answer; if it didn't, take the user's last clear yes/no.
    if (UNANSWERED.has(inv.status)) {
      const answer = (data.transcript ?? []).filter((t) => t.role === "user").map((t) => quickRespond(t.message ?? "")).filter(Boolean).at(-1);
      if (answer) await d.respond(inv, answer === "accept");
    }
    // No answer at all → the workflow's 15-min timeout marks it no_answer.
  } else if (p.type === "call_initiation_failure" && UNANSWERED.has(inv.status)) {
    // Busy / no-answer / unknown: fall back to push so the invitation still reaches the user.
    try {
      await sendPush(d.db, d.env, inv.user_id, { title: "Sitspot", body: firstSentences(inv.script ?? "", 1) || "Time to go outside?", url: `/call/${inv.id}` }, d.push);
    } catch (e) {
      console.warn("[voice] push fallback failed:", (e as Error).message);
    }
  }
  return c.json({ ok: true, handled: true });
}
