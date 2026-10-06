# Voice + delivery (T10)

## Routes

| Route | Auth | What |
| --- | --- | --- |
| `POST /v1/voice/llm/chat/completions` (alias `/v1/voice/llm/v1/chat/completions`) | `X-Voice-Secret` or `Authorization: Bearer` = `VOICE_SHARED_SECRET` | ElevenLabs custom LLM. OpenAI request in, OpenAI SSE chunks out (`stream:false` → one JSON completion). |
| `POST /v1/voice/webhooks/post-call` | `ElevenLabs-Signature` HMAC with `ELEVENLABS_WEBHOOK_SECRET` | Logs the call; records a yes/no the live endpoint missed; `call_initiation_failure` → push fallback. |
| `GET /v1/voice/session/:invitationId` | session cookie | `{agent_id, signed_url, script}` for an in-browser conversation; `agent_id:null` when ElevenLabs isn't configured. |

Which invitation a turn is about: `elevenlabs_extra_body.invitation_id` (and `visit_id`) → an `invitation_id: <uuid>` line in the system prompt → the owner's open invitation.

## Verified against the docs (2026-10-06)

- **Custom LLM** — https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm
  - ElevenLabs POSTs an OpenAI Chat Completions body (`messages`, `model`, `temperature`, `max_tokens`, `stream`, `user_id`) to the server URL + `/chat/completions` (their sample server serves `/v1/chat/completions`, so the base ends in `/v1`; we answer both shapes).
  - Response: `Content-Type: text/event-stream`, `data: {json}\n\n` chunks, ending `data: [DONE]\n\n`.
  - Extra params arrive as `elevenlabs_extra_body` in the body; sent by the caller as `custom_llm_extra_body` / `extra_body` in conversation initiation data.
  - Docs mention no custom request headers; auth is an API-key secret on the agent (sent as `Authorization: Bearer`), which is why we also accept Bearer.
- **Outbound call** — https://elevenlabs.io/docs/api-reference/twilio/outbound-call
  - `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call`, body `{agent_id, agent_phone_number_id, to_number, conversation_initiation_client_data: {dynamic_variables, custom_llm_extra_body, ...}}`.
  - 200 → `{success, message, conversation_id, callSid}`.
- **Auth header** — https://elevenlabs.io/docs/api-reference/authentication: `xi-api-key`.
- **Signed URL** — https://elevenlabs.io/docs/api-reference/conversations/get-signed-url: `GET /v1/convai/conversation/get-signed-url?agent_id=…` → `{signed_url}`.
- **Post-call webhooks** — https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks
  - Types: `post_call_transcription`, `post_call_audio`, `call_initiation_failure` (`failure_reason`: `busy` | `no-answer` | `unknown`).
  - `data.transcript[]` = `{role: "user"|"agent", message, time_in_call_secs, ...}`; `data.metadata.call_duration_secs`; `data.conversation_initiation_client_data.dynamic_variables`.
- **Signature** — SDK source https://github.com/elevenlabs/elevenlabs-js/blob/main/src/wrapper/webhooks.ts:
  header `t=<unix secs>,v0=<hex>`; `v0 = HMAC-SHA256(secret, "<t>.<raw body>")` hex; reject if older than 30 min.

## Setup

1. Public URL for the API (deployed, or `cloudflared tunnel --url http://localhost:8787`).
2. `.env`: `VOICE_SHARED_SECRET` (random), `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`, `MY_PHONE_E164`, and VAPID keys from `pnpm --filter @sitspot/api exec tsx scripts/gen-vapid.ts`.
3. ElevenLabs agent:
   - LLM → Custom LLM. Server URL `https://<public>/v1/voice/llm` (the endpoint appended is `/chat/completions`). API key: a secret whose value is `VOICE_SHARED_SECRET`. If a "request headers" field is offered, `X-Voice-Secret: <VOICE_SHARED_SECRET>` works too.
   - First message: `{{script}}`.
   - System prompt: anything short, plus a line `invitation_id: {{invitation_id}}` (backup for the extra body).
   - Dynamic variables `script`, `invitation_id` (the outbound call fills both).
   - Security → allow overrides of custom LLM extra body if the dashboard asks.
   - Post-call webhook: `https://<public>/v1/voice/webhooks/post-call`, copy its secret into `ELEVENLABS_WEBHOOK_SECRET`; enable transcription + call-initiation-failure events.
4. Telephony: import the Twilio trial number into ElevenLabs → its id is `ELEVENLABS_PHONE_NUMBER_ID`; verify your mobile in Twilio (trial only calls verified numbers).
