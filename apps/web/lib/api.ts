// Typed client for apps/api (spec §8). Cookie session lives on the API origin, so every call
// runs in the browser with credentials: 'include'.
import type {
  ConditionsHour, FieldNote, Forecast, Invitation, InvitationStatus, Preference, Spot, SpotInput, User,
} from "@sitspot/shared";

/** JSON over the wire: Dates arrive as ISO strings. */
export type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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
  invitation: (id: string) => request<WInvitation>(`/v1/invitations/${q(id)}`),
  respond: (id: string, accepted: boolean) =>
    request<unknown>(`/v1/invitations/${q(id)}/respond`, { method: "POST", json: { accepted } }),

  notes: () => request<WNote[]>("/v1/notes"),
  searchNotes: (text: string) => request<WNote[]>(`/v1/notes/search?q=${q(text)}`),

  preferences: () => request<Wire<Preference>[]>("/v1/memory/preferences"),
  savePreference: (key: string, value: unknown, source_utterance: string) =>
    request<unknown>("/v1/memory/preferences", { method: "POST", json: { key, value, source_utterance } }),

  vapidKey: () => request<{ key: string }>("/v1/push/vapid-public-key"),
  subscribePush: (sub: PushSubscriptionJSON) => request<unknown>("/v1/push/subscribe", { method: "POST", json: sub }),
};
