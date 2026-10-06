// Same-origin proxy: /api/<path> -> ${API_INTERNAL_URL}/<path> (the Hono API). The browser only ever talks to
// this origin, so the session cookie is first-party. Works with `next start` on the laptop (upstream localhost)
// and on Vercel (upstream = the ngrok URL). Streams the response (voice SSE) instead of buffering it.
export const dynamic = "force-dynamic";
export const maxDuration = 300; // /cron/pull and slow LLM turns

const UPSTREAM = (process.env.API_INTERNAL_URL || "http://localhost:8787").replace(/\/+$/, "");
// Optional shared secret with the API: lets it trust x-sitspot-client-ip for the login rate limit when another
// proxy (ngrok in front of the API) sits between us and it.
const PROXY_SECRET = process.env.PROXY_SECRET;

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
  "content-length", "accept-encoding", "forwarded", "expect"]); // undici rejects Expect (curl sends it for >1 MB)
const RES_DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!HOP.has(k) && !k.startsWith("x-forwarded-") && !k.startsWith("x-sitspot-") && !k.startsWith("x-vercel-")) headers.set(k, v);
  });
  const xff = req.headers.get("x-forwarded-for");
  const clientIp = xff?.split(",").at(-1)?.trim();
  if (xff) headers.set("x-forwarded-for", xff);
  headers.set("x-forwarded-proto", req.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1));
  headers.set("x-forwarded-host", req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host);
  headers.set("ngrok-skip-browser-warning", "1"); // ngrok free plan's interstitial
  if (PROXY_SECRET && clientIp) {
    headers.set("x-sitspot-proxy-secret", PROXY_SECRET);
    headers.set("x-sitspot-client-ip", clientIp);
  }

  let res: Response;
  try {
    res = await fetch(UPSTREAM + (url.pathname.slice("/api".length) || "/") + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
      signal: req.signal, // client gone -> stop the upstream call
      cache: "no-store",
    });
  } catch (e) {
    console.error("[api proxy]", req.method, url.pathname, (e as Error).message, (e as Error).cause ?? "");
    return Response.json({ error: "Sitspot API is unreachable (is the laptop on?)" }, { status: 502 });
  }
  const out = new Headers(res.headers); // keeps every Set-Cookie
  for (const k of RES_DROP) out.delete(k); // fetch already decoded the body
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as OPTIONS, proxy as HEAD };
