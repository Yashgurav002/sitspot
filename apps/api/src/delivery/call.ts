// ElevenLabs Agents outbound phone call over Twilio (spec §15.2, FR-22). See voice/README.md.
type Env = Record<string, string | undefined>;

export const ELEVENLABS_API = "https://api.elevenlabs.io";

export const callConfigured = (env: Env) =>
  Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID && env.ELEVENLABS_PHONE_NUMBER_ID && env.MY_PHONE_E164);

/** Starts the call; resolves once ElevenLabs accepted it (not when answered). Throws on any failure. */
export async function placeCall(
  env: Env,
  { to, invitationId, script, fetch: f = fetch }: { to: string; invitationId: string; script: string; fetch?: typeof fetch },
): Promise<{ call_id: string }> {
  const res = await f(`${ELEVENLABS_API}/v1/convai/twilio/outbound-call`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: to,
      conversation_initiation_client_data: {
        // {{script}} is the agent's first message; {{invitation_id}} can go in its system prompt.
        dynamic_variables: { invitation_id: invitationId, script },
        // Arrives at our custom LLM as body.elevenlabs_extra_body.
        custom_llm_extra_body: { invitation_id: invitationId },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; conversation_id?: string | null; callSid?: string | null };
  if (!res.ok || data.success === false) throw new Error(`outbound call failed (${res.status}): ${data.message ?? "unknown"}`);
  const call_id = data.conversation_id ?? data.callSid;
  if (!call_id) throw new Error("outbound call: no conversation_id in response");
  return { call_id };
}
