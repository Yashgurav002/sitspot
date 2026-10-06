// Activity interface shared by the workflows (proxy) and apps/api/src/activities.ts (implementation).
// Everything crossing this boundary is JSON: dates are ISO strings.

export type InvitationStatus =
  | "pending" | "sent" | "accepted" | "declined" | "no_answer"
  | "arrived" | "completed" | "missed" | "cancelled";

/** Serializable policy pick (Candidate with ISO dates). */
export type PickDTO = {
  spot_id: string;
  window_start: string;
  window_end: string;
  send_at: string;
  score: number;
  factors: Record<string, unknown>;
  reason: string;
};

export type InvitationArgs = { invitationId: string; sendAt: string; windowEnd: string };

export interface Activities {
  /** Policy pick for the next 6 h, or null. */
  evaluateWindows(userId: string): Promise<PickDTO | null>;
  /** Idempotent on (user, spot, window_start): returns the existing row if present. */
  createInvitation(userId: string, pick: PickDTO, workflowId: string): Promise<{ invitationId: string; created: boolean }>;
  /** Nightly reflection (T13 fills in threshold nudge / accept factors). */
  reflect(userId: string): Promise<void>;
  /** Re-score this spot/window with fresh conditions. */
  recheckWindow(invitationId: string): Promise<{ ok: boolean; reason: string }>;
  /** Build facts → LLM script (template fallback) → save on the row → log agent_run. */
  composeScript(invitationId: string): Promise<{ script: string; fallback: boolean }>;
  /** Call (fallback push); marks the row 'sent'. Never re-delivers a row that is past 'pending'. */
  deliver(invitationId: string): Promise<{ channel: "call" | "push" | "none"; call_id?: string }>;
  setStatus(invitationId: string, status: InvitationStatus): Promise<void>;
  /** Visit facts → field note. Idempotent per invitation. */
  compileVisit(invitationId: string): Promise<{ noteId: string | null }>;
}
