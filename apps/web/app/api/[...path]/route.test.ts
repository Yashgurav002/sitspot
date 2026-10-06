import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it("forwards path, method, body, cookies and forwarded headers; returns Set-Cookie and streams the body", async () => {
  vi.stubEnv("API_INTERNAL_URL", "https://tunnel.example/");
  vi.stubEnv("PROXY_SECRET", "px");
  let seen: { url: string; init: RequestInit } | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    seen = { url, init };
    const h = new Headers({ "content-type": "text/event-stream", "content-encoding": "gzip" });
    h.append("set-cookie", "a=1; Path=/; HttpOnly");
    h.append("set-cookie", "b=2; Path=/");
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: 1\n\n")); c.close(); } }), { status: 201, headers: h });
  }));
  const { POST } = await import("./route");
  const res = await POST(new Request("http://web.example/api/auth/login?x=1", {
    method: "POST", body: '{"passcode":"p"}',
    headers: { "content-type": "application/json", cookie: "s=1", "x-forwarded-for": "1.1.1.1, 2.2.2.2",
      "x-forwarded-proto": "https", "x-sitspot-client-ip": "spoof", "accept-encoding": "gzip", expect: "100-continue" },
  }));
  expect(seen!.url).toBe("https://tunnel.example/auth/login?x=1");
  const h = seen!.init.headers as Headers;
  expect(seen!.init.method).toBe("POST");
  expect(new TextDecoder().decode(seen!.init.body as ArrayBuffer)).toBe('{"passcode":"p"}');
  expect(h.get("cookie")).toBe("s=1");
  expect(h.get("x-forwarded-proto")).toBe("https");
  expect(h.get("x-forwarded-for")).toBe("1.1.1.1, 2.2.2.2");
  expect(h.get("x-sitspot-client-ip")).toBe("2.2.2.2"); // last hop, never the client's own header
  expect(h.get("x-sitspot-proxy-secret")).toBe("px");
  expect(h.get("ngrok-skip-browser-warning")).toBe("1");
  expect(h.get("accept-encoding")).toBeNull();
  expect(h.get("expect")).toBeNull();
  expect(res.status).toBe(201);
  expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/; HttpOnly", "b=2; Path=/"]);
  expect(res.headers.get("content-encoding")).toBeNull();
  expect(await res.text()).toBe("data: 1\n\n");
});

it("502 when the API is unreachable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
  const { GET } = await import("./route");
  expect((await GET(new Request("http://web.example/api/health"))).status).toBe(502);
});
