# Sitspot — Tasks

Each task = one issue. `Deps` must be done first. Every task is **done only when its checks pass** (`pnpm test` for the touched package, plus the listed checks). Status: `[ ]` todo · `[~]` in progress · `[x]` done.

## Where we are (updated 2026-10-06 evening)

**Done:** T00–T13, T15 — all committed with passing tests (`git log --oneline`).
**In progress (agents may have been interrupted — check `git status` for uncommitted work):**
- T14: API/workers/LLM Sentry done (no-op without SENTRY_DSN_API). Web (@sentry/nextjs) part still to do.
- T16 Evaluation (retrieval, agent safety, voice latency, 20-kill durability) → `evaluation/`.
- eBird export for TabPFN running in background → `ml/tabpfn/cache/checklists.csv`, log `ml/tabpfn/cache/export.log`. Cached; rerun the same command to resume:
  `cd ml/tabpfn && EBIRD_API_KEY=... .venv/Scripts/python export_ebird.py --start 2022-09-01 --end 2026-10-05 --stride 3 --max 8000` (eBird 429s after ~600 fast calls; script backs off. Later rerun with `--stride 1` to fill in days — cached calls are free.)
  Then: `features.py` → `train_eval.py` (writes `evaluation/tabpfn_results.md`).

**Next up:** T18 deploy (decide API/worker host + Postgres + public GitHub repo) → T19 docs → T17 fine-tune (optional).

**Waiting on the user:**
- Twilio trial: verify +91 number, check Voice → Geo permissions allows India.
- ElevenLabs free account + API key (agent setup happens after we have a public URL; steps in `apps/api/src/voice/README.md`).
- Optional: Sentry DSN, public GitHub repo URL.
- Real-world: 4+ visits Thu–Sat (creek on falling tide + one sunset), film them, notes in `docs/field-notes.md`.

**Decisions made (don't re-litigate):**
- LLM: scripts/notes = `gemma-4-31b-it` on AI Studio (slow ~100 s, thinks first; stripped in `packages/llm`); voice chat = `gemma3:1b` on local Ollama (`CHAT_LLM_BASE_URL`) for latency.
- Tide from Open-Meteo is timing-only (no heights in scripts) — coarse open-coast model.
- eBird district codes verified: IN-MH-PG, IN-MH-TH, IN-MH-MC, IN-MH-MS.
- Dev DB = PGlite (`.pglite/`); prod = any Postgres with pgvector via `DATABASE_URL`.
- Temporal worker runs inside the API process; local dev server: `"$LOCALAPPDATA/Temp/temporal-sdk-typescript-1.24.0.exe" server start-dev --db-filename .temporal/temporal.db` (UI :8233).
- Learned per-hour accept factors stored in `users.accept_factors` (not preferences — those must be the user's own words).
- Credits needed in README/DEV post: TabPFN by Prior Labs; BirdNET (Kahl et al. 2021, CC BY-NC-SA 4.0).

**Known gaps / before going public:** login rate limit; strong ADMIN_PASSCODE set only in host env; `COOKIE_CROSS_SITE=1` (or proxy) when web and API are on different sites; BirdNET + battery untested on a real phone (needs HTTPS).

**Run locally:** start Temporal (above) → `pnpm --filter @sitspot/api start` (:8787) → `pnpm --filter @sitspot/web dev` (:3000) → sign in with `ADMIN_PASSCODE`. Tests: `pnpm -r test`.

## Wave 0 — Foundation (sequential)

- [x] **T00 Monorepo scaffold** — pnpm workspaces, tsconfig base, Vitest, ESLint, `.env.example` (§16), CI workflow (lint+typecheck+test), README stub, empty packages with `index.ts`.
  Checks: `pnpm install`, `pnpm -r typecheck`, `pnpm -r test` green.

## Wave 1 — Independent packages (parallel)

- [x] **T01 `packages/shared`** — zod schemas + TS types: Spot, ConditionsHour, Sighting, Forecast, Invitation (+status enum), Factors, Visit, Detection, Observation, FieldNote, Preference. Deps: T00.
- [x] **T02 `packages/db`** — SQL migration from §7 (PGlite-compatible; Timescale lines commented), migration runner, `getDb()` returning a `query(sql, params)` adapter over PGlite (no `DATABASE_URL`) or `postgres` (with it). Query helpers: spots CRUD, upsert conditions/sightings/forecasts, invitations CRUD/status, visits, detections (idempotent), observations, notes, preferences, hybrid search (RRF). Deps: T00.
  Checks: tests run migrations on in-memory PGlite and exercise every helper incl. hybrid search.
- [x] **T03 `packages/data`** — Open-Meteo forecast/air-quality/marine clients, eBird recent-obs client, suncalc sun helpers, derived features (`minutes_from_sunrise`, `minutes_to_sunset`, `is_golden_hour`, `tide_trend`, `hours_to_low_tide`, `hours_to_high_tide`, next low/high tide). zod parsing. Deps: T00.
  Checks: unit tests on recorded fixtures (fetched once from the real API and committed); one opt-in live test (`LIVE=1`) hitting Open-Meteo for Vasai.
- [x] **T04 `packages/policy`** — `config.ts` weights; `comfort`, `tideFit`, `lightBonus`, `novelty`, `availability`, `score`, `safetyCheck` (S-1..S-5), `evaluateWindows(spots, conditions, forecasts, sun, user, history, now)` → ranked candidates with factors + reason; `sendAt`. Pure functions. Deps: T00.
  Checks: a test for every safety rule and every factor boundary; property test that no candidate violating safety is ever returned.
- [x] **T05 `packages/llm`** — one OpenAI-compatible client (`chat`, `chatStream`, `json<T>(schema)`, `embed`), configured by env; timeouts; returns token usage + latency. Deps: T00.
  Checks: tests against a local fake HTTP server; opt-in live test against Ollama.

## Wave 2 — Brain and API (parallel, after Wave 1)

- [x] **T06 `packages/agent`** — context block builder (§9.2), system prompt (§9.3), `composeScript`, `chat`, `extractIntent`, `writeNote`; grounding validators (numbers-in-facts, species-in-facts, quote-substring, coastal safety line, note verifier); retry-once then deterministic template fallback. Deps: T01, T05.
  Checks: unit tests for every validator; `tests/when_ai_is_wrong.test.ts` feeding hallucinating fake LLM outputs → all rejected/replaced.
- [x] **T07 `apps/api` core** — Hono server: `/health`, passcode auth, `/v1/spots` CRUD, conditions, sightings, invitations list/get/respond, visits arrive/detections/observations/end, notes + search, preferences, `/cron/pull`, `/cron/forecast-ingest`, push subscribe. Deps: T02, T03.
  Checks: route tests with `app.request()` on PGlite; `/cron/pull` integration test with fixture-backed fetch.
- [x] **T08 `ml/tabpfn`** — `export_ebird.py` (cache, 1 req/s), `features.py`, `train_eval.py` (TabPFN vs hotspot×hour avg, logistic regression, XGBoost; time split; AUC/Brier/precision@threshold → `evaluation/tabpfn_results.md`), `forecast_job.py`. Deps: T02 (schema).
  Checks: pytest on features + labelling with a small synthetic fixture; scripts run end-to-end on fixture data. Real run needs `EBIRD_API_KEY`.

## Wave 3 — Loop (parallel, after Wave 2)

- [x] **T09 `workflows/`** — Temporal `UserDayWorkflow`, `InvitationWorkflow`, signals/queries, activities wired to db/policy/agent/delivery; worker entry `pnpm worker`. Deps: T04, T06, T07.
  Checks: time-skipping tests: accept→arrive→end→completed; decline; no-answer; missed; recheck-cancel; deterministic IDs prevent duplicates; worker restart resumes without duplicate delivery.
- [x] **T10 Delivery + voice** — Web Push (VAPID), ElevenLabs outbound call client, custom-LLM SSE endpoint `/v1/voice/llm/chat/completions`, post-call webhook with HMAC verification. Deps: T06, T07.
  Checks: SSE endpoint returns valid OpenAI chunks (test); webhook rejects bad signature; call failure falls back to push.
- [x] **T11 `apps/web`** — Next.js PWA: passcode sign-in, Spots page (Leaflet map), settings (quiet hours, loves), invitations history with factor breakdown, notes + search, `/call/[id]`, service worker for push, manifest. Deps: T07.
  Checks: `next build` passes; Playwright smoke: sign in → add spot → see it listed.
- [x] **T12 Visit page + BirdNET** — `/visit/[id]`: arrive, wake lock, pocket overlay with 2-s hold exit, mic capture, Web Worker running BirdNET TF.js (or documented honest fallback), regional filter, dedupe, IndexedDB outbox, observations, end + rating. Deps: T11.
  Checks: unit tests for dedupe/outbox/filter; build passes; manual terrace test.

## Wave 4 — Depth

- [x] **T13 Memory** — preference extraction from `intent` with quoted utterance → `preferences`; policy reads `spot_weekends_only` / `avoid_*`; nightly reflect: threshold nudge ±0.05, per-hour accept factors. Deps: T09.
- [~] **T14 Observability** — Sentry in api/web/workflows with spans + attributes (§17.4); no-op without DSN. Deps: T09–T11.
- [x] **T15 Scheduling + MCP** — `.github/workflows/cron.yml`; read-only `/mcp` tools. Deps: T07.
- [~] **T16 Evaluation** — retrieval eval (40 Qs: BM25 vs vector vs hybrid), agent eval (40 scripted turns), durability (20 kills) → `evaluation/*.md`. Deps: T09, T06, T02.
- [ ] **T17 (P2) Fine-tune** — `ml/finetune` dataset builder + verifier + Kaggle notebook + eval. Deps: T06.

## Wave 5 — Ship

- [ ] **T18 Deploy** — web to Vercel; API target decided (Vercel / Render); worker host; env set; cron live.
- [ ] **T19 Docs** — README, architecture image, `docs/field-notes.md`, demo account.
