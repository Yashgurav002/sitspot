# Sitspot — Product Requirements Document

> **Your places, calling you.**
> Status: v1.0 · Owner: Yash · Date: 2026-10-06 · Event: Hacktoberfest Open-Source AI Challenge, Week 1 "Touch Grass" (submit Sun 2026-10-11)
> Source of truth for implementation details: [`SITSPOT_BUILD_SPEC.md`](SITSPOT_BUILD_SPEC.md) (referenced below as §N). Where this PRD and the spec disagree, this PRD wins; where an external API disagrees with either, the API wins.

---

## 1. Problem

"Go outside more" fails because it is abstract, and in a city the *timing* decides whether going out is worth it: October afternoons in Vasai are hot, air quality swings by the hour, and the creek is only interesting near low tide. Nobody checks five apps to find the good 40 minutes, so people with a creek, a fort and a beach 15 minutes away visit none of them.

## 2. Goal and non-goals

**Goal.** A person adds 3–5 real places once. From then on, Sitspot watches those places using open data and, only when one opens a genuinely good window, interrupts them (phone call, or voice push as fallback) with the place, the reasons, and when to leave. If they go, the phone stays in their pocket and names birds on-device.

**Non-goals (this week).**
- Not a generic "best time to go outside" app — never positioned that way (§1).
- Bird ID is a supporting feature, never the headline.
- No multi-tenant onboarding, payments, social features, native apps.
- No extra hardware; the phone is never left outside alone.
- No paid services (zero-cost rule, §2).

## 3. Users

| Persona | Need |
| --- | --- |
| **Primary — "home-bound city worker"** (Yash in Vasai) | Has places within ~20 min, never knows when they're worth it; wants to be told, not to check. |
| Secondary (roadmap) | Housing societies, school eco-clubs, birding groups. |

## 4. Success metrics

| Metric | Target (one user, one week — an anecdote, and we say so) |
| --- | --- |
| Real visits triggered by an invitation | ≥ 4, including one creek visit on a falling tide and one sunset |
| Visits rated 4–5 | ≥ 70% |
| Screen time per day | < 1 min after setup |
| Decision → phone ringing | < 30 s |
| Unsafe invitations (coast after dark / high tide / heat ≥ 38°C / AQI ≥ 200) | **0** (tested) |
| Species named that were not detected or eBird-reported | **0** (tested) |

## 5. Scope and priorities

**P0 — the demo cannot happen without these**
1. Spots: add/edit/remove 3–5 places (map tap or current location), kind, travel time; quiet hours.
2. Hourly conditions per spot: weather, AQI, tide (coastal), sun; eBird recent sightings.
3. Decision policy + hard safety rules as pure, tested code (§3.5–3.6).
4. Invitation lifecycle as a durable workflow (Temporal) with signals: responded, arrived, visitEnded.
5. Grounded call script + conversation from an open model (Gemma), context-first, validated (§9).
6. Delivery: Web Push (always) → ElevenLabs+Twilio phone call (when keys exist).
7. Visit page: "I'm here", pocket mode (wake lock + black overlay), observations, end + rating.
8. Evening field note built from deterministic facts, with a verifier.
9. Web app: spots, invitations history (score breakdown + reason), notes.

**P1 — depth / prize categories**
10. TabPFN `p_rich` forecast + benchmarks vs baselines (§12).
11. BirdNET running in the browser on the visit page (§14); honest fallback if it can't be made to work.
12. Preference memory with quoted source utterance + one visible behaviour change.
13. Hybrid search (BM25 + vector, RRF) over notes/observations + retrieval eval.
14. Sentry tracing across pull → decision → call → visit → note.
15. Scheduling: GitHub Actions cron hitting `/cron/*`; keep-alive.
16. Read-only MCP endpoint.

**P2 — only if time remains**
17. Fine-tuned small Gemma field-note model (Unsloth on Kaggle) + eval (§13).
18. Mastra wrapper around the agent (prize category only; the context-first path must work without it).
19. SerpApi search.

## 6. Functional requirements

### 6.1 Spots & settings
- FR-1 A user can create a spot with `name, kind ∈ {home, park, heritage, coastal}, lat, lon, travel_min`.
- FR-2 Spot picker uses Leaflet + OpenStreetMap tiles; "use my location" uses the Geolocation API.
- FR-3 User sets quiet hours (default 22:00–07:00 Asia/Kolkata) and free-text loves.
- FR-4 Single-user passcode sign-in (`ADMIN_PASSCODE`) + a public read-only demo user.

### 6.2 Data pulling (§11)
- FR-5 `POST /cron/pull` (header `X-Cron-Secret`) upserts 48 h of hourly conditions for every spot from Open-Meteo forecast + air-quality (+ marine for coastal).
- FR-6 eBird recent sightings (≤ 5 km, 7 days) refreshed at most once per day per spot; skipped with a logged warning if `EBIRD_API_KEY` is absent — never faked.
- FR-7 All external responses are zod-parsed; a schema mismatch fails loudly, not silently.

### 6.3 Decision (§3.5) — code, not model
- FR-8 For every spot × next 6 hours compute `score = p_rich · comfort · tide_fit · light_bonus · novelty · availability` and store every factor.
- FR-9 `p_rich` comes from the latest `forecasts` row; if none exists, use the prior 0.5 with `model_version = "prior"` (visible in the UI).
- FR-10 Invite when `score ≥ user.threshold` (default 0.35) and all safety rules pass; at most 2 invitations/day; none within 3 h of a decline; one open at a time.
- FR-11 `send_at = window_start − travel_min − 10 min`.
- FR-12 Every invitation stores score, factors JSON and a one-sentence reason.

### 6.4 Safety (§3.6) — hard-coded, unit-tested, never overridden by the model
- S-1 No coastal invitations after sunset − 30 min or before sunrise.
- S-2 No coastal invitations overlapping high tide ± 60 min.
- S-3 Coastal scripts always contain "stay on firm ground"; never suggest mudflats/water/off-path.
- S-4 No invitations when apparent temperature ≥ 38 °C or US AQI ≥ 200.
- S-5 Quiet hours are absolute.

### 6.5 Agent (§9) — context-first
- FR-13 One OpenAI-compatible LLM client configured only by env (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL_*`). Default dev target: Ollama; prod: Google AI Studio Gemma.
- FR-14 Four call kinds: `script`, `chat`, `intent`, `note`, each zod-validated.
- FR-15 Grounding checks: every number in a script appears in the facts; no species outside facts/detections; `intent.quote` must be a substring of the utterance. Failing output is retried once, then replaced by a deterministic template.
- FR-16 Species answers always carry confidence wording (≥ 0.8 confident; 0.6–0.8 fairly confident; < 0.6 possibly).
- FR-17 `POST /v1/voice/llm/chat/completions` — OpenAI-compatible SSE endpoint for ElevenLabs custom LLM (header `X-Voice-Secret`).

### 6.6 Workflows (§10)
- FR-18 `UserDayWorkflow` hourly evaluation → child `InvitationWorkflow` with deterministic ID (no duplicate calls on restart).
- FR-19 `InvitationWorkflow`: sleep → recheck → compose script → deliver (call, fallback push) → await responded (15 min) → arrived (until window end) → visitEnded (90 min) → compile note → update memory.
- FR-20 Activities retry 3× with exponential backoff; validation errors non-retryable.

### 6.7 Delivery
- FR-21 Web Push (VAPID, `web-push`) is always implemented; tapping opens `/call/[invitationId]`.
- FR-22 Phone call via ElevenLabs outbound-call API when `ELEVENLABS_*` keys exist; failure falls back to push.
- FR-23 Post-call webhook verifies signature and signals the workflow.

### 6.8 Visit
- FR-24 `/visit/[id]`: "I'm here" → arrive signal; wake lock; black overlay exited by 2-second hold.
- FR-25 Mic → BirdNET in a Web Worker every 3 s; regional species filter; confidence ≥ 0.5; dedupe 60 s; **audio discarded after each window**; only JSON detections leave the phone.
- FR-26 Detections queue in IndexedDB and flush every 30 s when online; endpoint idempotent.
- FR-27 End → rating 1–5 → `visitEnded` signal.

### 6.9 Memory & notes
- FR-28 Preference writes require `source_utterance` (the user's quoted words).
- FR-29 Nightly note from deterministic facts; verifier rejects any species/count/time not in facts.
- FR-30 Notes searchable via hybrid search (tsvector + pgvector RRF).

## 7. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Cost | ₹0. Free tiers / no-card trials / hackathon credits only. |
| Privacy | Audio never leaves the phone. Phone number encrypted at rest. Secrets only via env. |
| Honesty | No faked data sources, no hard-coded demo results; benchmarks publish real numbers including misses. |
| Reliability | Workflow survives worker kill with no duplicate call (20/20 forced kills). |
| Latency | Voice: end of speech → first audio p50 < 1.5 s. Context fetch < 150 ms. |
| Testability | Policy & safety 100% branch-tested. `tests/when_ai_is_wrong.test.ts` exists. CI runs lint + typecheck + tests. |
| Portability | Swapping LLM provider = env change. DB = any Postgres with pgvector (PGlite in dev/tests). |

## 8. Architecture (summary of §4)

```
Open-Meteo / eBird ──► /cron/pull ──► Postgres (+pgvector)  ◄── TabPFN job (Python, hourly)
                                          │
                       Temporal worker ◄──┤──► policy (pure TS) ──► InvitationWorkflow
                                          │                              │
                       Gemma (OpenAI-compatible) ◄── agent (context-first)│
                                                                          ▼
                                       Web Push / ElevenLabs+Twilio call ──► phone
                                                                          │
                     Next.js PWA (spots, notes, /visit pocket mode + BirdNET in Web Worker)
```

**Monorepo** (pnpm workspaces, Node 24, TypeScript, Vitest):
`apps/web` (Next.js App Router + Tailwind) · `apps/api` (Hono) · `packages/{shared,policy,data,db,llm,agent}` · `workflows/` · `ml/{tabpfn,finetune,birdnet-web}` · `evaluation/` · `tests/`.

**Deployment target.** Web on Vercel (free). API: Vercel functions work for REST/cron/voice endpoints; the **Temporal worker needs a long-running process** (laptop during build week, or Render free web service). Decided at deploy time; code keeps the worker as a separate entry point (`pnpm worker`) so either works.

## 9. External dependencies & what the user must provide

| Dependency | Needed for | Key/account | Without it |
| --- | --- | --- | --- |
| Open-Meteo | Conditions | none | — |
| eBird API 2.0 | Sightings, TabPFN data | `EBIRD_API_KEY` (free) | Sightings empty; novelty = 1.0; TabPFN blocked |
| Google AI Studio (Gemma) | LLM in prod | `LLM_API_KEY` (free) | Ollama locally |
| ElevenLabs + Twilio trial | Phone call | keys + verified number | Web Push only |
| Temporal | Workflows | none locally | — |
| Postgres + pgvector | Storage | `DATABASE_URL` (Neon/Supabase/Tiger free) | PGlite file locally |
| Sentry | Tracing | DSN (free) | console logs |

## 10. Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| No working TF.js BirdNET build | Med | Ship visits with voice observations + eBird context, say so honestly |
| Open-Meteo marine tide inaccurate for a creek | High | Use for trend/timing only; label as "sea level model"; validate against a tide table once |
| Twilio trial can't call Indian numbers | Med | Web Push + in-browser ElevenLabs conversation |
| 5-day scope | High | P0 first, P2 dropped without regret |
| Gemma free-tier rate limits | Med | Small model for `chat`; deterministic template fallback |

## 11. Release plan

| Milestone | Contents | Target |
| --- | --- | --- |
| M0 Scaffold | Monorepo, CI, env example | Tue |
| M1 Data | DB, pullers, spots UI | Wed AM |
| M2 Brain | Policy, safety, LLM, agent | Wed–Thu |
| M3 Loop | Workflows, push/call, visit page | Thu — first real invitation Thu evening |
| M4 Depth | TabPFN, BirdNET, memory, search, Sentry | Fri |
| M5 Real world | Visits, footage, benchmarks | Sat |
| M6 Ship | Deploy, README, video, DEV post | Sun |

Task breakdown lives in [`TASKS.md`](TASKS.md).
