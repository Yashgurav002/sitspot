# Sitspot

> **Your places, calling you.**

You add the 3–5 real places you could actually go: a creek, a fort, a beach, a terrace. Sitspot watches them every hour using open data (weather, air quality, tide, sun, recent eBird sightings). When one of them opens a genuinely good window, it **calls you**, or sends a voice push if it can't call. The call gives you the place, the reasons with real numbers, and when to leave. If you go, you tap "I'm here", put the phone in your pocket, and walk. In the evening it writes a short field note from what actually happened, and it learns from what you accepted and declined.

Built for the Hacktoberfest Open-Source AI Challenge, Week 1 "Touch Grass". Docs: [architecture](docs/architecture.md) · [setup](docs/setup.md) · [field notes](docs/field-notes.md) · [PRD](PRD.md) · [tasks](TASKS.md)

## The wow moment

Your phone rings at 5:05 pm while you're at home:

> *"The creek is worth a visit in the next hour. Low tide is at 5:20, so the mudflats will be open, and egrets were logged there yesterday. It's cooled to 28 degrees with a breeze, air quality is good, and sunset is at 6:15. Leave by 5:10 and you'll have about 50 minutes of good light. Stay on firm ground. Want to go?"*

You go. That call and the walk are the product. Bird ID on the walk helps, but it isn't the point.

*(This is the target call from the spec. The live phone call has not been placed end to end yet. See [What's not done](#whats-not-done--known-limitations).)*

## How it works

```
pull ─► decide ─► script ─► call / push ─► visit ─► evening note ─► learning
```

1. **Pull.** `/cron/pull` (hourly, GitHub Actions) fetches 48 h of hourly conditions per spot from Open-Meteo: weather, air quality, and marine sea level for coastal spots. It also fetches eBird recent sightings within 5 km. Every response is zod-parsed.
2. **Decide (code, not a model).** `packages/policy` scores every spot × next-6-hours window:
   `score = p_rich · comfort · tide_fit · light_bonus · novelty · availability`.
   It invites when `score ≥ threshold` (starts at 0.35) and every safety rule passes. Every factor and a one-sentence reason are stored with the invitation. Formula details are in [docs/architecture.md](docs/architecture.md#the-decision).
3. **Script (Gemma).** The agent turns *only* the structured facts into a short call script. Validators check it; a failure gets one retry, then a deterministic template.
4. **Call / push.** A Temporal `InvitationWorkflow` sleeps until `send_at = window_start − travel − 10 min`, re-checks the window, then places an ElevenLabs + Twilio outbound call. If the call fails, it falls back to Web Push. During the call, the ElevenLabs agent's "brain" is our own OpenAI-compatible endpoint.
5. **Visit.** `/visit/[id]` gives you "I'm here", a screen wake lock, and a black pocket overlay (hold for 2 s to exit). BirdNET runs **on the phone** in a Web Worker on 3-s windows. Only JSON detections leave the phone. Detections are queued in IndexedDB and flushed when online.
6. **Evening note.** A field note is written from deterministic visit facts (detections, observations, times). A verifier rejects any species, count or time that isn't in the facts.
7. **Learning.** When you say something like "don't call me on weekdays for the creek" during a call, it becomes a preference, stored with your quoted words. A nightly `reflect` nudges your threshold by ±0.05 and learns a per-hour accept factor (0.5–1.5).

## Safety rules

These are hard-coded and unit-tested. The model never overrides them.

| Rule | What | Enforced by |
| --- | --- | --- |
| S-1 | No coastal invitations after sunset − 30 min or before sunrise | `packages/policy` `safetyCheck`. Also in the agent: `coastalClosed` stops `composeScript` from calling the model at all for a closed coast. In chat, a validator rejects encouragement and requires "too late / head back". |
| S-2 | No coastal invitations overlapping high tide ± 60 min | policy (`tide_fit = 0`, safety block; fails closed if there's no tide data) |
| S-3 | Coastal scripts always say "Stay on firm ground"; never suggest mudflats, water or going off-path | agent validators `hasSafetyLine` + `unsafeAdvice` (clause-aware negation) |
| S-4 | No invitations at apparent temp ≥ 38 °C or US AQI ≥ 200 | policy `safetyCheck` |
| S-5 | Quiet hours are absolute, and that includes the moment the phone rings | policy checks `[send_at, window_end]` |

There is a property test that no unsafe candidate is ever returned. `packages/agent/test/when_ai_is_wrong.test.ts` feeds the agent hallucinating fake LLM outputs and checks that all of them are rejected or replaced.

## Open models and where they run

| Model | Job | Runs on |
| --- | --- | --- |
| **Gemma 4 31B** (`gemma-4-31b-it`) | Call scripts, evening notes (written ahead of time; slow is fine) | Google AI Studio, OpenAI-compatible endpoint |
| **Gemma 3 1B** (`gemma3:1b`) | Live voice turns, intent extraction (latency matters) | Ollama, locally |
| **nomic-embed-text** | Embeddings for hybrid note search | Ollama, locally |
| **BirdNET V2.4** (TF.js) | Bird sound ID on visits | **On the phone**, in a browser Web Worker (WASM) |
| **TabPFN v2** | `p_rich`, the chance a visit at this place/hour is "rich" | Python job on CPU, writes to `forecasts` |

Every LLM call goes through one OpenAI-compatible client, so switching provider is an env change. Until a TabPFN forecast exists for a spot, the policy uses `p_rich = 0.5` with `model_version = "prior"`, and the UI shows that.

## Repo map

```
apps/api          Hono API: auth, spots, invitations, visits, notes, /cron/*, voice endpoints, read-only /mcp; Temporal worker runs in-process
apps/web          Next.js PWA: spots map (Leaflet/OSM), invitations + factor breakdown, notes search, /call, /visit pocket mode + BirdNET worker
packages/policy   pure decision + safety rules (all weights in src/config.ts)
packages/agent    context-first agent: context builder, prompts, validators, templates
packages/data     Open-Meteo + eBird clients, sun/tide features
packages/db       PGlite (dev) / Postgres+pgvector (prod) migrations, queries, hybrid search (RRF)
packages/llm      one OpenAI-compatible client (chat, stream, json, embed)
packages/shared   zod schemas + types
workflows/        Temporal UserDayWorkflow + InvitationWorkflow
ml/tabpfn         eBird export → features → benchmark → hourly forecast job
ml/birdnet-web    BirdNET TF.js model fetch + Node/browser benchmarks
evaluation/       retrieval, agent and durability evals with real result files
.github/workflows ci.yml (typecheck + test), cron.yml (keep-alive, hourly pull, forecast)
```

## Quickstart

```sh
pnpm install
cp .env.example .env      # fill in keys, see docs/setup.md
# start Temporal dev server, then:
pnpm --filter @sitspot/api start    # :8787
pnpm --filter @sitspot/web dev      # :3000, sign in with ADMIN_PASSCODE
pnpm -r test
```

Full Windows walkthrough (Ollama models, Temporal, keys, evals, TabPFN, voice, Sentry): **[docs/setup.md](docs/setup.md)**.

## Benchmarks

Real numbers only, copied from `evaluation/*.md`, misses included. All of it was run on **one laptop** (i7-11370H, RTX 3050 Ti 4 GB, 16 GB RAM, Windows 11) on 2026-10-06. It's one person and one week, so treat it as an anecdote.

| Benchmark | Result | Caveat |
| --- | --- | --- |
| Retrieval, Recall@5 / MRR@5 (40 questions) | keyword 0.454 / 0.500 · vector 0.487 / 0.438 · **hybrid RRF 0.750 / 0.725** | **Synthetic**: 60 notes and 40 questions, same author. "Keyword" is Postgres full-text, not true BM25. A sanity check, not a general benchmark. |
| Agent chat safety, `gemma3:1b`, 40 turns (final output, manual labels) | unsupported species named **0.0% (0/40)** · unsafe advice **2.5% (1/40)** (was 12.5% before the S-1 fix) · detected bird → right confidence band **87.5% (7/8)** · fallback 17.5% · p50/p95 1195 / 2302 ms | **Synthetic** cases written by the eval author, incl. adversarial ones; labels not blinded. This is the third run after the fixes. The one remaining unsafe case (c38) is now rejected by a unit test but has **not been re-measured**. |
| Call scripts, `gemma-4-31b-it`, 10 cases | unsupported species 0/10 · unsafe 0/10 · fallback 3/10 (all three were AI Studio 503/500 errors) · p50 69.6 s / p95 111.5 s | Synthetic. Run before the fixes and not re-run. |
| Voice LLM latency (LLM part only), 20 turns | `gemma3:1b` first chunk p50/p95 **826 / 1378 ms** · `gemma3:4b` 1923 / 4161 ms | Laptop GPU, warm model. Excludes STT, TTS and network. The full "end of speech → first audio" number is **not measured**. |
| Durability: forced worker kills | **20/20 correct resumes, 0 duplicate deliveries**. Separate in-flight probe: 2/2 correct, but each stalled 120 s. | Temporal time-skipping test server, mocked activities, one workflow at a time. The 20 kills happen while the workflow is waiting, not mid-activity. |
| BirdNET in the browser (desktop) | per 3-s window: Node WASM median 153 ms · headless Chromium WASM ~340 ms. 2 real bulbul clips correct at the 0.5 threshold. | **Not run on a phone yet.** |
| TabPFN `p_rich` vs baselines | **Pending.** The eBird export is still running; no real-data result yet. | — |
| On-phone bird-ID precision (30 clips), battery per visit | **Not measured** | Needs a real phone over HTTPS |

## Privacy

- **Audio never leaves the phone.** BirdNET runs in a Web Worker and each 3-s window is discarded after inference. Only JSON detections (species, confidence, time) are sent.
- **Sentry is scrubbed** (`apps/api/src/observability.ts`). It collects no bodies, headers, cookies, query strings, GenAI inputs/outputs or DB query data, and drops console breadcrumbs. Span attributes are ids, counts, models and latencies only. It does nothing without `SENTRY_DSN_API`.
- Your phone number lives only in the server env (`MY_PHONE_E164`), never in the database. Secrets come only from env.

## Credits and licences

- **TabPFN by Prior Labs.** Code is Apache-2.0. We use the TabPFN-2 weights under the Prior Labs License (Apache-2.0 plus attribution).
- **BirdNET**: Kahl, S., Wood, C. M., Eibl, M., & Klinck, H. (2021). *BirdNET: A deep learning solution for avian diversity monitoring.* Ecological Informatics 61:101236. The model is used under **CC BY-NC-SA 4.0 (non-commercial)**. BirdNET-Analyzer / real-time-pwa code is MIT, and our WebGL STFT kernel is ported from real-time-pwa.
- **Open-Meteo**: weather, air quality and marine data, **CC BY 4.0**. Free API for non-commercial use.
- **eBird** (Cornell Lab of Ornithology): sightings and checklists via eBird API 2.0, used under the eBird API Terms of Use.
- **OpenStreetMap**: map tiles and data © OpenStreetMap contributors (ODbL), via Leaflet.
- **Gemma** (Google), used under the Gemma terms. **Temporal**, **ElevenLabs**, **Twilio**, **Sentry** are used on free tiers or trials.

## What's not done / known limitations

- **Live phone call is untested end to end.** The ElevenLabs outbound call, custom-LLM SSE endpoint and signed webhook are built and tested against the docs' formats, but they have not been run against live ElevenLabs/Twilio. That waits on a public URL plus the Twilio trial number verification.
- **BirdNET and battery are untested on a real phone** (that needs HTTPS). On-phone precision on 30 labelled clips is not done either.
- **TabPFN real-data results are pending** on the eBird export. Until then, every spot uses the `prior` (`p_rich = 0.5`).
- **Postgres is only tested via PGlite.** Prod is meant to be any Postgres with pgvector through `DATABASE_URL`, but that path hasn't run yet. `forecast_job.py` needs real Postgres, so it hasn't written forecasts yet.
- **Not deployed yet.** Deploy URLs come later.
- **Web-side Sentry is not wired.** Only API, worker, LLM and data spans are traced.
- Tide comes from Open-Meteo's open-coast sea-level model, so it's used for **timing only** (trend, next low/high), never heights. Creek lag is not modelled.
- Keyword search is Postgres full-text, not BM25.
- The demo account (`DEMO_READONLY_USER_ID`) and phone-number encryption (`PHONE_ENCRYPTION_KEY`) are in `.env.example` but **not implemented**.
- Sign-in is a single-user passcode with no login rate limit.
- The fine-tuned note model (T17) is not started. `ml/finetune` is empty.
- No licence file for this repo yet.
- Real visits: none logged yet. See [docs/field-notes.md](docs/field-notes.md).

## Hacktoberfest prize categories

Only what's actually built:

- **Gemma**: Gemma 4 31B (scripts, notes) on AI Studio; Gemma 3 1B (voice) on Ollama.
- **TabPFN**: `p_rich` forecast pipeline and benchmark harness (real-data results pending).
- **Temporal**: durable `UserDayWorkflow` / `InvitationWorkflow` with signals; 20/20 kill-resume eval.
- **ElevenLabs**: outbound call + custom-LLM endpoint + signed post-call webhook. Built, but the live call is pending.
- **Sentry**: tracing for API, data pulls, policy, LLM calls, Temporal activities and delivery, privacy-scrubbed.
