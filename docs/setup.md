# Local setup (Windows)

These steps were tested on Windows 11 with Git Bash. PowerShell works too if you swap the env-var syntax.

## 1. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node | ≥ 22 (built on 24) | |
| pnpm | 11 | `corepack enable` picks up `packageManager` from `package.json` |
| Ollama | recent (evals used 0.17) | https://ollama.com |
| Python | 3.11 | only for the TabPFN pipeline |
| Temporal dev server | — | see step 4 |

```sh
pnpm install
cp .env.example .env
ollama pull gemma3:1b          # voice turns + intent
ollama pull nomic-embed-text   # note embeddings
```

## 2. `.env` keys

The API loads the repo-root `.env`. The web app doesn't need it locally, because `NEXT_PUBLIC_API_URL` defaults to `http://localhost:8787`.

| Key | Needed for | Where to get it |
| --- | --- | --- |
| `ADMIN_PASSCODE` | sign-in | choose one |
| `CRON_SECRET` | `/cron/*`, also signs sessions if `SESSION_SECRET` is empty | random: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `LLM_API_KEY` | scripts + notes (`gemma-4-31b-it`) | Google AI Studio → API key (free) |
| `LLM_BASE_URL`, `CHAT_LLM_BASE_URL`, `EMBED_BASE_URL` | — | defaults in `.env.example` (AI Studio + local Ollama). To run fully local, point `LLM_BASE_URL` at `http://localhost:11434/v1` and set the `LLM_MODEL_*` keys to Ollama models. |
| `EBIRD_API_KEY` | sightings, TabPFN export | https://ebird.org/api/keygen (free, needs an eBird account). Without it, sightings are skipped (never faked) and novelty = 1.0. |
| `DATABASE_URL` | prod Postgres | leave empty locally to use PGlite in `PGLITE_DIR` (`.pglite/`) |
| `TEMPORAL_ADDRESS` | workflows | `localhost:7233` |
| `VAPID_*` | Web Push | `pnpm --filter @sitspot/api exec tsx scripts/gen-vapid.ts` |
| `ELEVENLABS_*`, `VOICE_SHARED_SECRET`, `MY_PHONE_E164` | phone call | step 9 |
| `SENTRY_DSN_API` | tracing | step 10 |
| `MCP_TOKEN` | optional bearer for read-only `/mcp` | random string |

## 3. Tests

```sh
pnpm -r test                               # every package
pnpm test                                  # same, plus root tests/
pnpm -r typecheck
pnpm --filter @sitspot/web e2e             # Playwright smoke: sign in → add spot → listed
LIVE=1 pnpm --filter @sitspot/data test    # opt-in: hits the real Open-Meteo
```

## 4. Start Temporal

The command below is the one used during the build (UI on http://localhost:8233). That binary is the dev server the Temporal TypeScript SDK downloads into your temp folder:

```sh
"$LOCALAPPDATA/Temp/temporal-sdk-typescript-1.24.0.exe" server start-dev --db-filename .temporal/temporal.db
```

If you don't have it, install the Temporal CLI and run `temporal server start-dev --db-filename .temporal/temporal.db`.

## 5. Start the API and the web app

```sh
pnpm --filter @sitspot/api start     # :8787. Logs "temporal: on" once connected; the worker runs in-process
pnpm --filter @sitspot/web dev       # :3000
```

The API still runs without Temporal (`temporal: off`), but then no invitations are scheduled. To run the worker on its own, use `pnpm worker`.

## 6. Sign in and add spots

1. Open http://localhost:3000 and sign in with `ADMIN_PASSCODE`.
2. **Spots**: tap the map (or use "my location"). Set the name, kind (`home` / `park` / `heritage` / `coastal`) and travel minutes. Add 3–5 spots.
3. **Settings**: set quiet hours (default 22:00–07:00 IST) and what you love (species, light, quiet).
4. Pull conditions now instead of waiting for the hourly cron:

   ```sh
   curl -X POST -H "X-Cron-Secret: $CRON_SECRET" http://localhost:8787/cron/pull
   ```

5. **Invitations** shows each candidate's score and factor breakdown.

## 7. Evals

Run one at a time on an idle machine. They write to `evaluation/*.md` and `evaluation/*/` raw files.

```sh
pnpm --filter @sitspot/evaluation retrieval      # Ollama nomic-embed-text, ~30 s
pnpm --filter @sitspot/evaluation agent:chat     # Ollama gemma3:1b, ~1 min
pnpm --filter @sitspot/evaluation agent:script   # AI Studio gemma-4-31b-it, ~15 min
pnpm --filter @sitspot/evaluation latency        # gemma3:1b vs 4b, ~2 min (also: ollama pull gemma3:4b)
pnpm --filter @sitspot/evaluation agent:report   # after updating agent/manual_review.json
pnpm --filter @sitspot/evaluation durability     # 20 forced kills, ~1.5 min
pnpm --filter @sitspot/evaluation durability:inflight   # ~4 min
```

## 8. TabPFN pipeline (`ml/tabpfn`)

```sh
cd ml/tabpfn
python -m venv .venv
.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m pytest -q tests

EBIRD_API_KEY=... .venv/Scripts/python export_ebird.py --start 2022-09-01 --end 2026-10-05 --stride 3 --max 8000
.venv/Scripts/python features.py              # → cache/training.csv
.venv/Scripts/python train_eval.py            # → evaluation/tabpfn_results.md
DATABASE_URL=... .venv/Scripts/python forecast_job.py   # needs real Postgres; PGlite can't be opened from Python
```

- The export caches every call, so it's safe to Ctrl-C and rerun. eBird returns 429 after about 600 fast calls; the script backs off. Rerun with `--stride 1` later to fill in days (cached calls are free).
- `train_eval.py --synthetic` is a smoke test that writes only to the temp dir.
- TabPFN-2 weights download from HuggingFace with no token.

## 9. Phone call: ElevenLabs + Twilio

Not yet run live. These steps come from `apps/api/src/voice/README.md`.

1. **Public URL** for the API: deploy it, or run `cloudflared tunnel --url http://localhost:8787`.
2. **`.env`**: `VOICE_SHARED_SECRET` (random), `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`, `MY_PHONE_E164`, plus the VAPID keys.
3. **ElevenLabs agent**:
   - LLM → **Custom LLM**. Server URL `https://<public>/v1/voice/llm` (ElevenLabs appends `/chat/completions`). API key: a secret whose value is `VOICE_SHARED_SECRET`. If the dashboard offers request headers, `X-Voice-Secret: <VOICE_SHARED_SECRET>` works too.
   - First message: `{{script}}`.
   - System prompt: anything short, plus a line `invitation_id: {{invitation_id}}`.
   - Dynamic variables: `script`, `invitation_id` (the outbound call fills both).
   - Security: allow overrides of the custom LLM extra body if the dashboard asks.
   - Post-call webhook: `https://<public>/v1/voice/webhooks/post-call`. Copy its secret into `ELEVENLABS_WEBHOOK_SECRET`, and enable the transcription and call-initiation-failure events.
4. **Telephony**: import the Twilio trial number into ElevenLabs; its id is `ELEVENLABS_PHONE_NUMBER_ID`. In Twilio, verify your mobile (a trial account only calls verified numbers), and check that Voice → Geo permissions allows your country (India for `+91`).

If the call isn't configured or fails, delivery falls back to Web Push. Tapping the push opens `/call/[id]`, which shows the script with yes/no buttons and, when ElevenLabs is configured, the same agent as an in-browser voice conversation.

## 10. Sentry

1. Create a free Sentry project (Node) and copy its DSN into `SENTRY_DSN_API`.
2. Restart the API. `src/instrument.ts` initialises Sentry only when the DSN is set; otherwise every helper is a no-op.
3. You get spans for HTTP routes, data pulls, policy, LLM calls (`gen_ai.*`), Temporal activities and delivery. Bodies, headers, cookies, query strings, GenAI inputs/outputs and console breadcrumbs are not collected.

`SENTRY_DSN_WEB` (`@sentry/nextjs`) is not wired yet.
