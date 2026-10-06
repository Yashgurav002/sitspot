import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { nextHighTide, nextLowTide, sunTimes, tideTrend } from "@sitspot/data";
import * as q from "@sitspot/db";
import type { Db } from "@sitspot/db";
import {
  DetectionInput, Forecast, InvitationStatus, PreferenceInput, SpotInput, type Invitation,
} from "@sitspot/shared";
import { safeEqual, sign, verify } from "./auth";
import { evaluateForUser } from "./services/evaluate";
import { pullAll } from "./services/pull";

export type Signals = {
  responded?(invitationId: string, accepted: boolean): unknown;
  arrived?(invitationId: string, visitId: string): unknown;
  visitEnded?(invitationId: string, visitId: string, rating: number | null): unknown;
};

export type AppDeps = {
  db: Db;
  env: Record<string, string | undefined>;
  now?: () => Date;
  fetch?: typeof fetch;
  /** Text -> embedding for hybrid note search; keyword-only when absent or failing. */
  embed?: (text: string) => Promise<number[]>;
  /** Temporal signal hooks (wired in T09). Errors are logged, never fail the request. */
  signals?: Signals;
};

export const SESSION_COOKIE = "sitspot_session";
export const DEMO_EMAIL = "demo@sitspot.local";
export const adminEmail = (env: AppDeps["env"]) => env.ADMIN_EMAIL || "me@sitspot.local";

const DAY = 86_400_000;
const SESSION_MS = 30 * DAY;
const VISIT_MS = 3 * 3_600_000;
const MAX_SPOTS = 5;
const MAX_DETECTIONS = 200;

type Env = { Variables: { uid: string; demo: boolean } };

const DEMO_RO = "This is a read-only demo.";
const bad = (message: string) => new HTTPException(400, { message });
const notFound = () => new HTTPException(404, { message: "not found" });
const Uuid = z.string().uuid();
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "expected HH:MM");

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw bad("invalid JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw bad(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

/** Path id must be a uuid, else 404 (avoids a Postgres cast error). */
const id = (c: Context, name = "id") => {
  const v = c.req.param(name);
  if (!v || !Uuid.safeParse(v).success) throw notFound();
  return v;
};

/** Integer query param clamped to [lo, hi]. */
const intQuery = (c: Context, name: string, def: number, lo: number, hi: number) => {
  const n = Number(c.req.query(name) ?? def);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};

export function createApp(deps: AppDeps) {
  const { db, env } = deps;
  const now = deps.now ?? (() => new Date());
  const secret = env.SESSION_SECRET || env.CRON_SECRET || randomBytes(32).toString("hex");
  if (!env.SESSION_SECRET && !env.CRON_SECRET) console.warn("[api] no SESSION_SECRET/CRON_SECRET: sessions reset on restart");

  const signal = async (name: keyof Signals, ...args: unknown[]) => {
    const fn = deps.signals?.[name] as ((...a: unknown[]) => unknown) | undefined;
    if (!fn) return;
    try {
      await fn(...args);
    } catch (e) {
      console.error(`[api] signal ${name} failed:`, (e as Error).message);
    }
  };

  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message || "error" }, err.status);
    console.error("[api]", err);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.use("*", cors({
    origin: env.WEB_ORIGIN || "http://localhost:3000",
    credentials: true,
    allowHeaders: ["content-type", "authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }));

  // ---------- health ----------
  app.get("/health", async (c) => {
    let dbUp = true;
    try {
      await db.query("select 1");
    } catch {
      dbUp = false;
    }
    return c.json({
      ok: dbUp,
      db: dbUp ? "up" : "down",
      llm: env.LLM_BASE_URL && env.LLM_MODEL_CHAT ? "configured" : "missing",
      temporal: "unknown",
    });
  });

  // ---------- auth ----------
  // COOKIE_CROSS_SITE=1 (web and API on different sites): SameSite=None needs Secure.
  const crossSite = env.COOKIE_CROSS_SITE === "1";
  const cookieOpts = (c: Context) => ({
    httpOnly: true,
    path: "/",
    sameSite: crossSite ? ("None" as const) : ("Lax" as const),
    secure: crossSite || new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
  });
  const startSession = (c: Context, uid: string, demo: boolean) => {
    setCookie(c, SESSION_COOKIE, sign({ typ: "session", uid, demo, exp: now().getTime() + SESSION_MS }, secret), {
      ...cookieOpts(c), maxAge: SESSION_MS / 1000,
    });
  };

  app.post("/auth/login", async (c) => {
    const { passcode } = await body(c, z.object({ passcode: z.string().min(1).max(200) }));
    if (!env.ADMIN_PASSCODE) throw new HTTPException(503, { message: "ADMIN_PASSCODE not configured" });
    if (!safeEqual(passcode, env.ADMIN_PASSCODE)) throw new HTTPException(401, { message: "Wrong passcode" });
    const user = await q.ensureUser(db, adminEmail(env));
    startSession(c, user.id, false);
    return c.json({ user, demo: false });
  });

  app.post("/auth/demo", async (c) => {
    const user = await q.ensureUser(db, DEMO_EMAIL);
    startSession(c, user.id, true);
    return c.json({ user, demo: true });
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, cookieOpts(c));
    return c.json({ ok: true });
  });

  const session = (c: Context) => verify(getCookie(c, SESSION_COOKIE), "session", secret, now());

  // Visit ownership: visit -> invitation -> user.
  const ownedVisit = async (visitId: string, uid: string) => {
    const visit = await q.getVisit(db, visitId);
    const inv = visit?.invitation_id ? await q.getInvitation(db, visit.invitation_id) : null;
    if (!visit || !inv || inv.user_id !== uid) throw notFound();
    return { visit, inv };
  };

  // Detections: registered before the /v1 session guard so a visit token alone is enough.
  app.post(
    "/v1/visits/:id/detections",
    bodyLimit({ maxSize: 64 * 1024, onError: () => { throw new HTTPException(413, { message: "payload too large" }); } }),
    async (c) => {
      const visitId = id(c);
      const s = session(c);
      const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (s) {
        if (s.demo) throw new HTTPException(403, { message: DEMO_RO });
        await ownedVisit(visitId, s.uid);
      } else if (bearer) {
        const t = verify(bearer, "visit", secret, now());
        if (!t) throw new HTTPException(401, { message: "invalid visit token" });
        if (t.vid !== visitId) throw new HTTPException(403, { message: "token is for another visit" });
        if (!(await q.getVisit(db, visitId))) throw notFound();
      } else {
        throw new HTTPException(401, { message: "unauthorized" });
      }
      const rows = await body(c, z.array(DetectionInput.strict()).max(MAX_DETECTIONS));
      return c.json({ inserted: await q.insertDetections(db, visitId, rows), received: rows.length });
    },
  );

  app.use("/v1/*", async (c, next) => {
    const s = session(c);
    if (!s) throw new HTTPException(401, { message: "unauthorized" });
    if (s.demo && c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS")
      throw new HTTPException(403, { message: DEMO_RO });
    c.set("uid", s.uid);
    c.set("demo", s.demo);
    await next();
  });

  // ---------- me ----------
  app.get("/v1/me", async (c) => {
    const user = await q.getUser(db, c.var.uid);
    if (!user) throw new HTTPException(401, { message: "unauthorized" });
    return c.json({ user, demo: c.var.demo });
  });

  app.patch("/v1/me", async (c) => {
    const p = await body(c, z.object({ quiet_start: Clock.optional(), quiet_end: Clock.optional(), threshold: z.number().min(0).max(1).optional() }));
    return c.json({ user: await q.updateUserSettings(db, c.var.uid, p), demo: false });
  });

  // ---------- spots ----------
  const ownedSpot = async (c: Context<Env>) => {
    const spot = await q.getSpot(db, id(c));
    if (!spot || spot.user_id !== c.var.uid) throw notFound();
    return spot;
  };

  app.get("/v1/spots", async (c) => c.json(await q.listSpots(db, c.var.uid)));

  app.post("/v1/spots", async (c) => {
    const input = await body(c, SpotInput);
    if ((await q.listSpots(db, c.var.uid)).length >= MAX_SPOTS) throw bad(`at most ${MAX_SPOTS} spots`);
    return c.json(await q.createSpot(db, c.var.uid, input), 201);
  });

  const SpotPatch = SpotInput.extend({ travel_min: z.number().int().min(0).max(180) }).partial();
  app.patch("/v1/spots/:id", async (c) => {
    const spot = await ownedSpot(c);
    return c.json(await q.updateSpot(db, spot.id, await body(c, SpotPatch)));
  });

  app.delete("/v1/spots/:id", async (c) => {
    const spot = await ownedSpot(c);
    await q.deleteSpot(db, spot.id);
    return c.body(null, 204);
  });

  app.get("/v1/spots/:id/conditions", async (c) => {
    const spot = await ownedSpot(c);
    const t = now();
    const hours = intQuery(c, "hours", 12, 1, 48);
    const from = new Date(Math.floor(t.getTime() / 3_600_000) * 3_600_000);
    const to = new Date(from.getTime() + hours * 3_600_000);
    let tide = null;
    if (spot.kind === "coastal") {
      const series = await q.getConditions(db, spot.id, new Date(t.getTime() - 3_600_000), new Date(t.getTime() + 48 * 3_600_000));
      if (series.some((r) => r.tide_m != null))
        tide = { next_low: nextLowTide(series, t), next_high: nextHighTide(series, t), trend: tideTrend(series, t) };
    }
    return c.json({
      conditions: await q.getConditions(db, spot.id, from, to),
      forecasts: await q.latestForecasts(db, spot.id, from, to),
      sun: sunTimes(t, spot.lat, spot.lon),
      tide,
    });
  });

  app.get("/v1/spots/:id/sightings", async (c) => {
    const spot = await ownedSpot(c);
    const days = intQuery(c, "days", 7, 1, 30);
    return c.json({ sightings: await q.recentSightingsNear(db, spot.lat, spot.lon, 5, new Date(now().getTime() - days * DAY)) });
  });

  // ---------- decision ----------
  app.get("/v1/candidates", async (c) => {
    const r = await evaluateForUser(db, c.var.uid, now());
    const names = new Map((await q.listSpots(db, c.var.uid)).map((s) => [s.id, s.name]));
    const named = <T extends { spot_id: string }>(x: T) => ({ ...x, spot_name: names.get(x.spot_id) ?? null });
    return c.json({ threshold: r.threshold, pick: r.pick && named(r.pick), candidates: r.candidates.map(named) });
  });

  // ---------- invitations ----------
  const ownedInvitation = async (invId: string, uid: string) => {
    const inv = await q.getInvitation(db, invId);
    if (!inv || inv.user_id !== uid) throw notFound();
    return inv;
  };
  const withSpot = async (inv: Invitation) => ({ ...inv, spot_name: (await q.getSpot(db, inv.spot_id))?.name ?? null });

  app.get("/v1/invitations", async (c) => {
    const st = c.req.query("status");
    const status = st ? InvitationStatus.safeParse(st) : null;
    if (status && !status.success) throw bad("invalid status");
    return c.json(await q.listInvitations(db, c.var.uid, status?.data));
  });

  app.get("/v1/invitations/:id", async (c) => c.json(await withSpot(await ownedInvitation(id(c), c.var.uid))));

  const CLOSED = new Set(["arrived", "completed", "missed", "cancelled"]);
  app.post("/v1/invitations/:id/respond", async (c) => {
    const inv = await ownedInvitation(id(c), c.var.uid);
    const { accepted } = await body(c, z.object({ accepted: z.boolean() }));
    if (CLOSED.has(inv.status)) throw new HTTPException(409, { message: `invitation is ${inv.status}` });
    const updated = await q.setInvitationStatus(db, inv.id, accepted ? "accepted" : "declined", { responded_at: now() });
    await signal("responded", inv.id, accepted);
    return c.json({ invitation: updated });
  });

  // ---------- visits ----------
  const visitToken = (vid: string) => sign({ typ: "visit", vid, exp: now().getTime() + VISIT_MS }, secret);

  app.post("/v1/visits/:invitationId/arrive", async (c) => {
    const inv = await ownedInvitation(id(c, "invitationId"), c.var.uid);
    const existing = await q.getVisitByInvitation(db, inv.id);
    if (existing) return c.json({ visit: existing, visit_token: visitToken(existing.id) }); // idempotent re-tap
    if (!["pending", "sent", "accepted", "no_answer"].includes(inv.status))
      throw new HTTPException(409, { message: `invitation is ${inv.status}` });
    const visit = await q.createVisit(db, inv.id);
    await q.setInvitationStatus(db, inv.id, "arrived");
    await signal("arrived", inv.id, visit.id);
    return c.json({ visit, visit_token: visitToken(visit.id) }, 201);
  });

  app.post("/v1/visits/:id/observations", async (c) => {
    const { visit } = await ownedVisit(id(c), c.var.uid);
    const { text } = await body(c, z.object({ text: z.string().trim().min(1).max(2000) }));
    let embedding: number[] | null = null;
    try {
      embedding = deps.embed ? await deps.embed(text) : null;
    } catch {
      /* store without embedding */
    }
    return c.json({ observation: await q.addObservation(db, { visit_id: visit.id, user_id: c.var.uid, text, embedding }) }, 201);
  });

  app.post("/v1/visits/:id/end", async (c) => {
    const { visit, inv } = await ownedVisit(id(c), c.var.uid);
    const { rating } = await body(c, z.object({ rating: z.number().int().min(1).max(5).nullable() }));
    if (visit.ended_at) return c.json({ visit });
    const ended = await q.endVisit(db, visit.id, rating);
    await q.setInvitationStatus(db, inv.id, "completed");
    await signal("visitEnded", inv.id, visit.id, rating);
    return c.json({ visit: ended });
  });

  app.get("/v1/visits/:id", async (c) => {
    const { visit } = await ownedVisit(id(c), c.var.uid);
    return c.json({ visit, detections: await q.listDetections(db, visit.id), observations: await q.listObservations(db, visit.id) });
  });

  // ---------- notes ----------
  app.get("/v1/notes", async (c) => {
    const date = c.req.query("date");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad("date must be YYYY-MM-DD");
    return c.json(await q.getNotes(db, c.var.uid, date));
  });

  app.get("/v1/notes/search", async (c) => {
    const text = (c.req.query("q") ?? "").trim();
    if (!text) throw bad("q required");
    let embedding: number[] | null = null;
    try {
      embedding = deps.embed ? await deps.embed(text) : null;
    } catch {
      /* keyword-only */
    }
    c.header("x-search-mode", embedding ? "hybrid" : "keyword");
    return c.json(await q.searchNotes(db, c.var.uid, text, embedding));
  });

  // ---------- preferences ----------
  app.get("/v1/memory/preferences", async (c) => c.json(await q.listPreferences(db, c.var.uid)));

  app.post("/v1/memory/preferences", async (c) => {
    const p = await body(c, PreferenceInput.extend({ source_utterance: z.string().trim().min(1, "source_utterance required") }));
    return c.json({ preference: await q.addPreference(db, c.var.uid, p) }, 201);
  });

  app.delete("/v1/memory/preferences/:id", async (c) => {
    const pid = id(c);
    if (!(await q.listPreferences(db, c.var.uid)).some((p) => p.id === pid)) throw notFound();
    await q.deletePreference(db, pid);
    return c.body(null, 204);
  });

  // ---------- push ----------
  app.post("/v1/push/subscribe", async (c) => {
    const sub = await body(c, z.object({
      endpoint: z.string().url(),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
    }));
    await q.setPushSubscription(db, c.var.uid, sub);
    return c.json({ ok: true });
  });

  app.get("/v1/push/vapid-public-key", (c) => c.json({ key: env.VAPID_PUBLIC_KEY || null }));

  // ---------- cron ----------
  app.use("/cron/*", async (c, next) => {
    if (!env.CRON_SECRET) throw new HTTPException(503, { message: "CRON_SECRET not configured" });
    if (!safeEqual(c.req.header("x-cron-secret") ?? "", env.CRON_SECRET)) throw new HTTPException(401, { message: "unauthorized" });
    await next();
  });

  app.post("/cron/pull", async (c) =>
    c.json(await pullAll(db, { fetch: deps.fetch, now: now(), ebirdKey: env.EBIRD_API_KEY || null })));

  app.post("/cron/forecast-ingest", bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
    const rows = await body(c, z.array(Forecast).max(50_000));
    const known = new Set((await q.listAllSpots(db)).map((s) => s.id));
    const ok = rows.filter((r) => known.has(r.spot_id));
    await q.upsertForecasts(db, ok);
    return c.json({ inserted: ok.length, skipped_unknown_spot: rows.length - ok.length });
  });

  return app;
}
