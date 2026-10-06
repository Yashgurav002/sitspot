import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import * as q from "@sitspot/db";
import type { Db } from "@sitspot/db";
import { InvitationStatus } from "@sitspot/shared";
import { safeEqual, verify } from "../auth";
import { evaluateForUser } from "../services/evaluate";

export type McpDeps = {
  db: Db;
  env: Record<string, string | undefined>;
  now: () => Date;
  secret: string;
  sessionCookie: string;
  adminEmail: string;
  embed?: (text: string) => Promise<number[]>;
};

const HOUR = 3_600_000;
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const RO = { readOnlyHint: true };

/** Session cookie (its user) or `Bearer MCP_TOKEN` (admin user); null = unauthorized. */
async function resolveUser(c: Context, d: McpDeps): Promise<string | null> {
  const s = verify(getCookie(c, d.sessionCookie), "session", d.secret, d.now());
  if (s) return s.uid;
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer && d.env.MCP_TOKEN && safeEqual(bearer, d.env.MCP_TOKEN)) return (await q.ensureUser(d.db, d.adminEmail)).id;
  return null;
}

function buildServer(d: McpDeps, uid: string): McpServer {
  const { db } = d;
  const server = new McpServer({ name: "sitspot", version: "0.1.0" });

  server.registerTool("list_spots", { description: "List the user's sit spots.", annotations: RO }, async () =>
    json(await q.listSpots(db, uid)));

  server.registerTool("get_conditions", {
    description: "Hourly conditions and latest TabPFN forecasts for one spot, from the current hour.",
    inputSchema: { spot_id: z.string().uuid(), hours: z.number().int().min(1).max(48).optional() },
    annotations: RO,
  }, async ({ spot_id, hours }) => {
    const spot = await q.getSpot(db, spot_id);
    if (!spot || spot.user_id !== uid) return { ...json({ error: "spot not found" }), isError: true };
    const from = new Date(Math.floor(d.now().getTime() / HOUR) * HOUR);
    const to = new Date(from.getTime() + (hours ?? 12) * HOUR);
    return json({ spot, conditions: await q.getConditions(db, spot.id, from, to), forecasts: await q.latestForecasts(db, spot.id, from, to) });
  });

  server.registerTool("get_candidates", { description: "Scored candidate windows for the next hours and the current pick.", annotations: RO }, async () =>
    json(await evaluateForUser(db, uid, d.now())));

  server.registerTool("list_invitations", {
    description: "The user's invitations, newest first, optionally filtered by status.",
    inputSchema: { status: InvitationStatus.optional() },
    annotations: RO,
  }, async ({ status }) => json(await q.listInvitations(db, uid, status)));

  server.registerTool("search_notes", {
    description: "Search the user's field notes (hybrid when embeddings are available, else keyword).",
    inputSchema: { q: z.string().trim().min(1).max(500) },
    annotations: RO,
  }, async ({ q: text }) => {
    let embedding: number[] | null = null;
    try {
      embedding = d.embed ? await d.embed(text) : null;
    } catch {
      /* keyword-only */
    }
    return json(await q.searchNotes(db, uid, text, embedding));
  });

  return server;
}

/** Stateless Streamable HTTP: fresh server + transport per request, JSON responses (no SSE). */
export function mcpHandler(d: McpDeps) {
  return async (c: Context) => {
    const uid = await resolveUser(c, d);
    if (!uid) return c.json({ error: "unauthorized" }, 401);
    const server = buildServer(d, uid);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  };
}
