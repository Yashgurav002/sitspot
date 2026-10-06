// deliver(inv, script): phone call when configured, else/on failure Web Push, else 'none'. Never throws.
// Does not touch invitation status: the workflow records channel/call_id from the result.
import { firstSentences } from "@sitspot/agent";
import type { Db } from "@sitspot/db";
import type { Invitation } from "@sitspot/shared";
import { callConfigured, placeCall } from "./call";
import { sendPush, type PushSender } from "./push";
import { withSpan } from "../observability";

export { placeCall, callConfigured } from "./call";
export { sendPush, pushConfigured, type PushSender, type PushMessage } from "./push";

export type DeliveryResult =
  | { channel: "call"; call_id: string }
  | { channel: "push"; call_error?: string }
  | { channel: "none"; error: string };

export type Deliver = (inv: Pick<Invitation, "id" | "user_id">, script: string) => Promise<DeliveryResult>;

export function createDeliver({ db, env, fetch: f, push }: {
  db: Db;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Injectable web-push sender (tests). */
  push?: PushSender;
}): Deliver {
  return (inv, script) =>
    withSpan("deliver", "delivery", { invitation_id: inv.id }, async (set) => {
      const r = await deliverOnce(inv, script);
      set({ channel: r.channel, call_failed: "call_error" in r && !!r.call_error });
      return r;
    });

  async function deliverOnce(...[inv, script]: Parameters<Deliver>): Promise<DeliveryResult> {
    let call_error: string | undefined;
    if (callConfigured(env)) {
      try {
        return { channel: "call", ...(await placeCall(env, { to: env.MY_PHONE_E164!, invitationId: inv.id, script, fetch: f })) };
      } catch (e) {
        call_error = (e as Error).message;
        console.warn(`[deliver] call failed for ${inv.id}, falling back to push: ${call_error}`);
      }
    }
    try {
      const msg = { title: "Sitspot", body: firstSentences(script, 1) || "Time to go outside?", url: `/call/${inv.id}` };
      if (await sendPush(db, env, inv.user_id, msg, push)) return call_error ? { channel: "push", call_error } : { channel: "push" };
      const error = `${call_error ? `call failed (${call_error}); ` : ""}push unavailable (no VAPID keys or no subscription)`;
      console.warn(`[deliver] nothing delivered for ${inv.id}: ${error}`);
      return { channel: "none", error };
    } catch (e) {
      const error = `push failed: ${(e as Error).message}`;
      console.warn(`[deliver] nothing delivered for ${inv.id}: ${error}`);
      return { channel: "none", error };
    }
  }
}
