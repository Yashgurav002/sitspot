// ElevenLabs Agents outbound phone call over Twilio (spec §15.2, FR-22). See voice/README.md.
type Env = Record<string, string | undefined>;

export const ELEVENLABS_API = "https://api.elevenlabs.io";

/**
 * Twilio-direct mode: we place the call through Twilio's REST API and Twilio fetches the TwiML from
 * our public URL, which hands the audio to the ElevenLabs agent (register-call). Needed on new Twilio
 * trials, which reject ElevenLabs' own outbound-call API ("trial accounts have limited parameter
 * access") and only allow calls from the console's shared trial number with a `Url`.
 */
export const twilioDirect = (env: Env) =>
  Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER && env.PUBLIC_API_URL && env.VOICE_SHARED_SECRET);

export const callConfigured = (env: Env) =>
  Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID && env.MY_PHONE_E164 && (twilioDirect(env) || env.ELEVENLABS_PHONE_NUMBER_ID));

/** TwiML that streams the call to the ElevenLabs agent, with the invitation's script as first message. */
export async function registerCall(
  env: Env,
  { to, invitationId, script, fetch: f = fetch }: { to: string; invitationId: string; script: string; fetch?: typeof fetch },
): Promise<string> {
  const res = await f(`${ELEVENLABS_API}/v1/convai/twilio/register-call`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_AGENT_ID,
      from_number: env.TWILIO_FROM_NUMBER,
      to_number: to,
      direction: "outbound",
      conversation_initiation_client_data: {
        dynamic_variables: { invitation_id: invitationId, script },
        custom_llm_extra_body: { invitation_id: invitationId },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const twiml = await res.text();
  if (!res.ok || !twiml.includes("<Response")) throw new Error(`register-call failed (${res.status}): ${twiml.slice(0, 200)}`);
  return twiml;
}

async function placeTwilioCall(env: Env, to: string, twimlUrl: string, f: typeof fetch): Promise<{ call_id: string }> {
  const sid = env.TWILIO_ACCOUNT_SID!;
  const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER!, Url: twimlUrl }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok || !data.sid) throw new Error(`twilio call failed (${res.status} ${data.code ?? ""}): ${data.message ?? "unknown"}`);
  return { call_id: data.sid };
}

/** Starts the call; resolves once ElevenLabs accepted it (not when answered). Throws on any failure. */
export async function placeCall(
  env: Env,
  { to, invitationId, script, fetch: f = fetch }: { to: string; invitationId: string; script: string; fetch?: typeof fetch },
  twimlToken?: string,
): Promise<{ call_id: string }> {
  if (twilioDirect(env) && twimlToken) {
    return placeTwilioCall(env, to, `${env.PUBLIC_API_URL!.replace(/\/$/, "")}/v1/voice/twiml/${twimlToken}`, f);
  }
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
