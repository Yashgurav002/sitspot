// Web Push fallback (spec §15.3, FR-21). Tapping opens /call/<invitationId> in the web app.
import webpush from "web-push";
import * as q from "@sitspot/db";
import type { Db } from "@sitspot/db";

type Env = Record<string, string | undefined>;
export type PushMessage = { title: string; body: string; url: string };
/** Same shape as web-push's sendNotification; injectable for tests. */
export type PushSender = (sub: webpush.PushSubscription, payload: string, opts: webpush.RequestOptions) => Promise<unknown>;

export const pushConfigured = (env: Env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

/**
 * true = delivered to the push service; false = not possible (no VAPID keys, no subscription,
 * or the subscription is gone — then it is cleared). Throws on transient errors.
 */
export async function sendPush(db: Db, env: Env, userId: string, msg: PushMessage, send: PushSender = webpush.sendNotification): Promise<boolean> {
  if (!pushConfigured(env)) return false;
  const sub = (await q.getPushSubscription(db, userId)) as webpush.PushSubscription | null;
  if (!sub?.endpoint) return false;
  try {
    await send(sub, JSON.stringify(msg), {
      TTL: 15 * 60, // an invitation older than the response window is useless
      urgency: "high",
      vapidDetails: { subject: env.VAPID_SUBJECT || "mailto:admin@sitspot.local", publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
    });
    return true;
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await q.setPushSubscription(db, userId, null);
      return false;
    }
    throw e;
  }
}
