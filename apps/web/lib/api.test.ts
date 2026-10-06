import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, request } from "./api";

function mockFetch(status: number, body: string) {
  const fn = vi.fn(async () => new Response(body || null, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("sends JSON with credentials and parses the reply", async () => {
    const fn = mockFetch(200, '{"ok":true}');
    await expect(request("/x", { method: "POST", json: { a: 1 } })).resolves.toEqual({ ok: true });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/x");
    expect(init.credentials).toBe("include");
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("returns undefined for empty 204", async () => {
    mockFetch(204, "");
    await expect(request("/x")).resolves.toBeUndefined();
  });

  it("uses the server's error message", async () => {
    mockFetch(400, '{"error":"name required"}');
    await expect(request("/x")).rejects.toMatchObject({ status: 400, message: "name required" });
  });

  it("explains 403 as read-only demo", async () => {
    mockFetch(403, "");
    await expect(request("/x")).rejects.toMatchObject({ status: 403, message: "This is a read-only demo." });
  });

  it("keeps 401 status for the login redirect", async () => {
    mockFetch(401, "nope");
    const err = (await request("/x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it("turns network failure into status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("failed"))));
    await expect(request("/x")).rejects.toMatchObject({ status: 0 });
  });

  it("encodes search queries", async () => {
    const fn = mockFetch(200, "[]");
    await api.searchNotes("egrets & tide");
    expect((fn.mock.calls[0] as unknown as [string])[0]).toBe("/api/v1/notes/search?q=egrets%20%26%20tide");
  });
});
