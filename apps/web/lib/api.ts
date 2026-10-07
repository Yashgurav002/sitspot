// Typed client for apps/api (spec §8). Default base is /api on this origin (app/api/[...path]/route.ts proxies it to
// the API), so the session cookie is first-party. NEXT_PUBLIC_API_URL points at a separate API origin
// instead (then the API needs WEB_ORIGIN + COOKIE_CROSS_SITE=1). credentials: 'include' covers both.
import type {
  ConditionsHour, DetectionInput, FieldNote, Forecast, Invitation, InvitationStatus, Preference, Spot, SpotInput, User, Visit,
} from "@sitspot/shared";

/** JSON over the wire: Dates arrive as ISO strings. */
export type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      ...rest,
      credentials: "include",
      headers: { ...(json !== undefined && { "content-type": "application/json" }), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "Can't reach Sitspot right now. Check your connection.");
  }
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      (typeof body === "object" && body && "error" in body && String((body as { error: unknown }).error)) ||
      (res.status === 403 ? "This is a read-only demo." : `Request failed (${res.status})`);
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

const q = encodeURIComponent;

export type Me = { user: Wire<User>; demo: boolean };
export type Conditions = { conditions: Wire<ConditionsHour>[]; forecasts: Wire<Forecast>[] };
export type WSpot = Wire<Spot>;
export type WInvitation = Wire<Invitation>;
export type WNote = Wire<FieldNote>;
export type WVisit = Wire<Visit>;

export const api = {
  login: (passcode: string) => request<unknown>("/auth/login", { method: "POST", json: { passcode } }),
  demo: () => request<unknown>("/auth/demo", { method: "POST" }),
  logout: () => request<unknown>("/auth/logout", { method: "POST" }),
  me: () => request<Me>("/v1/me"),
  updateMe: (p: { quiet_start: string; quiet_end: string; threshold?: number }) =>
    request<unknown>("/v1/me", { method: "PATCH", json: p }),

  spots: () => request<WSpot[]>("/v1/spots"),
  createSpot: (s: SpotInput) => request<WSpot>("/v1/spots", { method: "POST", json: s }),
  updateSpot: (id: string, s: Partial<SpotInput>) => request<WSpot>(`/v1/spots/${q(id)}`, { method: "PATCH", json: s }),
  deleteSpot: (id: string) => request<unknown>(`/v1/spots/${q(id)}`, { method: "DELETE" }),
  conditions: (id: string, hours = 12) => request<Conditions>(`/v1/spots/${q(id)}/conditions?hours=${hours}`),

  invitations: (status?: InvitationStatus) =>
    request<WInvitation[]>(`/v1/invitations${status ? `?status=${q(status)}` : ""}`),
  invitation: (id: string) => request<WInvitation & { spot_name: string | null }>(`/v1/invitations/${q(id)}`),
  respond: (id: string, accepted: boolean) =>
    request<unknown>(`/v1/invitations/${q(id)}/respond`, { method: "POST", json: { accepted } }),

  arrive: (invitationId: string) =>
    request<{ visit: WVisit; visit_token: string }>(`/v1/visits/${q(invitationId)}/arrive`, { method: "POST" }),
  /** Bearer visit token: works even if the session cookie has lapsed mid-visit. Idempotent. */
  detections: (visitId: string, token: string, rows: Wire<DetectionInput>[]) =>
    request<{ inserted: number; received: number }>(`/v1/visits/${q(visitId)}/detections`, {
      method: "POST", json: rows, headers: { authorization: `Bearer ${token}` },
    }),
  observe: (visitId: string, text: string) =>
    request<unknown>(`/v1/visits/${q(visitId)}/observations`, { method: "POST", json: { text } }),
  endVisit: (visitId: string, rating: number | null) =>
    request<{ visit: WVisit }>(`/v1/visits/${q(visitId)}/end`, { method: "POST", json: { rating } }),

  notes: () => request<WNote[]>("/v1/notes"),
  searchNotes: (text: string) => request<WNote[]>(`/v1/notes/search?q=${q(text)}`),

  preferences: () => request<Wire<Preference>[]>("/v1/memory/preferences"),
  savePreference: (key: string, value: unknown, source_utterance: string) =>
    request<unknown>("/v1/memory/preferences", { method: "POST", json: { key, value, source_utterance } }),

  vapidKey: () => request<{ key: string }>("/v1/push/vapid-public-key"),
  subscribePush: (sub: PushSubscriptionJSON) => request<unknown>("/v1/push/subscribe", { method: "POST", json: sub }),
  testPush: () => request<{ sent: boolean }>("/v1/push/test", { method: "POST" }),
};
