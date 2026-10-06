import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time string compare (hash first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

export type SessionClaims = { typ: "session"; uid: string; demo: boolean; exp: number };
export type VisitClaims = { typ: "visit"; vid: string; exp: number };
type Claims = SessionClaims | VisitClaims;

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** `base64url(json).base64url(hmac-sha256)`. Not a JWT on purpose: one shape, one algorithm. */
export function sign(claims: Claims, secret: string): string {
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
}

export function verify<T extends Claims["typ"]>(
  token: string | undefined | null,
  typ: T,
  secret: string,
  now: Date,
): Extract<Claims, { typ: T }> | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac || !safeEqual(mac, b64(createHmac("sha256", secret).update(body).digest()))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
    return c.typ === typ && typeof c.exp === "number" && c.exp > now.getTime() ? (c as Extract<Claims, { typ: T }>) : null;
  } catch {
    return null;
  }
}
