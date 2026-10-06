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

The API loads the repo-root `.env`. The web app doesn't read it (Next only reads `apps/web/.env*`): it calls the API at `/api` on its own origin, and the Route Handler `app/api/[...path]/route.ts` proxies that to `API_INTERNAL_URL` (default `http://localhost:8787`, read at runtime). Set `NEXT_PUBLIC_API_URL` in `apps/web/.env.local` only if the API lives on another origin (then also `WEB_ORIGIN` + `COOKIE_CROSS_SITE=1` on the API).

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
| `WEB_ORIGIN` | CORS origin (only used when web and API are on different origins) | the web origin when hosting, e.g. `https://<your-app>.vercel.app` |
| `NGROK_DOMAIN` | `pnpm start --tunnel` | your free ngrok dev domain |
| `PROXY_SECRET` | per-client login rate limit behind the Vercel proxy | random; same value in Vercel env |
| `COOKIE_CROSS_SITE` | leave **unset** with the `/api` proxy (cookie is first-party, `SameSite=Lax`) | `1` only for a split web/API deploy |

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

One command (Temporal → API → production web → hourly cron, prefixed logs; `q` + Enter or Ctrl-C stops everything):

```sh
pnpm start               # builds apps/web only if .next is missing
pnpm start --build       # rebuild the web app first (after code changes)
pnpm start --no-cron     # without scripts/hourly.mjs
pnpm start --tunnel --no-web   # hosting: API + ngrok, web on Vercel (step 11)
```

`TEMPORAL_BIN=temporal pnpm start` uses a Temporal CLI on PATH instead of the SDK-downloaded binary; an already-running server on :7233 is reused. Under Git Bash (mintty), prefer `q` + Enter: Ctrl-C there may kill children without letting the API close PGlite cleanly.

`scripts/hourly.mjs` does locally what the GitHub cron does: `POST /cron/pull` at :05 (and once at startup) and `forecast_job.py --api` at :15 (skipped until `ml/tabpfn/.venv` and `ml/tabpfn/cache/training.csv` exist). `node scripts/hourly.mjs --once` runs both now.

Or by hand, for development:

```sh
pnpm --filter @sitspot/api start     # :8787. Logs "temporal: on" once connected; the worker runs in-process
pnpm --filter @sitspot/web dev       # :3000, API at http://localhost:3000/api
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
CRON_SECRET=... .venv/Scripts/python forecast_job.py --api http://localhost:8787   # via the API (works with PGlite)
DATABASE_URL=... .venv/Scripts/python forecast_job.py                              # or straight to Postgres
```

- The export caches every call, so it's safe to Ctrl-C and rerun. eBird returns 429 after about 600 fast calls; the script backs off. Rerun with `--stride 1` later to fill in days (cached calls are free).
- `train_eval.py --synthetic` is a smoke test that writes only to the temp dir.
- TabPFN-2 weights download from HuggingFace with no token.

## 9. Phone call: ElevenLabs + Twilio

Not yet run live. These steps come from `apps/api/src/voice/README.md`.

1. **Public URL**: `pnpm start --tunnel` (step 11). The API is at `https://<NGROK_DOMAIN>`.
2. **`.env`**: `VOICE_SHARED_SECRET` (random), `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`, `MY_PHONE_E164`, plus the VAPID keys.
3. **ElevenLabs agent**:
   - LLM → **Custom LLM**. Server URL `https://<NGROK_DOMAIN>/v1/voice/llm` (ElevenLabs appends `/chat/completions`). API key: a secret whose value is `VOICE_SHARED_SECRET`. If the dashboard offers request headers, `X-Voice-Secret: <VOICE_SHARED_SECRET>` works too.
   - First message: `{{script}}`.
   - System prompt: anything short, plus a line `invitation_id: {{invitation_id}}`.
   - Dynamic variables: `script`, `invitation_id` (the outbound call fills both).
   - Security: allow overrides of the custom LLM extra body if the dashboard asks.
   - Post-call webhook: `https://<NGROK_DOMAIN>/v1/voice/webhooks/post-call`. Copy its secret into `ELEVENLABS_WEBHOOK_SECRET`, and enable the transcription and call-initiation-failure events.
4. **Telephony**: import the Twilio trial number into ElevenLabs; its id is `ELEVENLABS_PHONE_NUMBER_ID`. In Twilio, verify your mobile (a trial account only calls verified numbers), and check that Voice → Geo permissions allows your country (India for `+91`).

If the call isn't configured or fails, delivery falls back to Web Push. Tapping the push opens `/call/[id]`, which shows the script with yes/no buttons and, when ElevenLabs is configured, the same agent as an in-browser voice conversation.

## 10. Sentry

1. Create a free Sentry project (Node) and copy its DSN into `SENTRY_DSN_API`.
2. Restart the API. `src/instrument.ts` initialises Sentry only when the DSN is set; otherwise every helper is a no-op.
3. You get spans for HTTP routes, data pulls, policy, LLM calls (`gen_ai.*`), Temporal activities and delivery. Bodies, headers, cookies, query strings, GenAI inputs/outputs and console breadcrumbs are not collected.

`SENTRY_DSN_WEB` (`@sentry/nextjs`) is not wired yet.

## 11. Hosting: Vercel web + laptop API via ngrok

The web app runs on Vercel. Everything else (API, in-process Temporal worker, Temporal dev server, Ollama, PGlite, hourly cron) runs on the laptop behind an ngrok tunnel to the API on :8787. The browser only talks to the Vercel origin: `apps/web/app/api/[...path]/route.ts` proxies `/api/*` to `API_INTERNAL_URL` (the ngrok URL). The session cookie is first-party on the Vercel domain (`SameSite=Lax`, `Secure`). The proxy adds `ngrok-skip-browser-warning`, so ngrok's free-plan interstitial never shows, and it streams responses, so the voice SSE isn't buffered.

### Laptop

1. Install ngrok (https://ngrok.com/download, or `winget install ngrok.ngrok`), then run `ngrok config add-authtoken <token>`.
2. In the root `.env`: `NGROK_DOMAIN=ranger-pasted-kissable.ngrok-free.dev`, a strong `ADMIN_PASSCODE`, `CRON_SECRET` and `PROXY_SECRET` (random), and `WEB_ORIGIN=https://<your-app>.vercel.app`. Leave `COOKIE_CROSS_SITE` empty.
3. Start everything with the tunnel. `--no-web` skips the local web app to save memory:
   ```sh
   pnpm start --tunnel --no-web
   ```
   To run the tunnel by hand instead: `ngrok http --url=ranger-pasted-kissable.ngrok-free.dev 8787`.
4. Check it: `curl https://ranger-pasted-kissable.ngrok-free.dev/health`.

The ngrok free plan allows 1 GB a month. BirdNET models (82 MB) are served by Vercel, so they don't count against it. Keep the laptop awake and plugged in (Settings → System → Power → Screen and sleep → Never when plugged in).

### Vercel (one-time, nothing is deployed yet)

- Import the GitHub repo and set **Root Directory** to `apps/web`. `apps/web/vercel.json` already sets the framework (Next.js), the install command (`cd ../.. && pnpm install --frozen-lockfile --filter @sitspot/web...`) and the build command (`cd ../.. && pnpm --filter @sitspot/web build`). Keep "Include files outside the root directory" on (the default).
- Env vars:
  - `API_INTERNAL_URL=https://ranger-pasted-kissable.ngrok-free.dev`
  - `PROXY_SECRET=<same as the laptop>`. This lets the API rate-limit logins per real client IP. Without it, all Vercel traffic shares one bucket.
  - `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the `packageManager` pnpm version.
  - Optional: `NEXT_PUBLIC_SENTRY_DSN`.
- The build runs `ml/birdnet-web/fetch_model.mjs` first (Node, no Python needed). It downloads the BirdNET TF.js models into `public/birdnet/` when they're missing, so Vercel serves them as static files.
- Vercel Hobby cron is daily-only, so the hourly pull/forecast stays on the laptop (`scripts/hourly.mjs`, started by `pnpm start`).

### ElevenLabs

Prefer calling the API directly through ngrok. These are server-to-server calls, so there's no interstitial and no Vercel function time:
- Custom LLM server URL: `https://ranger-pasted-kissable.ngrok-free.dev/v1/voice/llm`
- Post-call webhook: `https://ranger-pasted-kissable.ngrok-free.dev/v1/voice/webhooks/post-call`

The Vercel proxy also works (`https://<your-app>.vercel.app/api/v1/voice/llm`, `.../api/v1/voice/webhooks/post-call`), but each turn then goes through a Vercel function as an extra hop.

### Optional GitHub cron

`.github/workflows/cron.yml` is a backup to `scripts/hourly.mjs`. Set the secrets `API_URL=https://ranger-pasted-kissable.ngrok-free.dev`, `WEB_URL=https://<your-app>.vercel.app` and `CRON_SECRET`. GitHub reaches the laptop only through the tunnel, so these runs fail while the laptop sleeps. The forecast job runs in API mode only if `ml/tabpfn/training.csv` is committed.

### All-local variant (no Vercel)

Run `pnpm start`, then tunnel to the web app instead: `ngrok http --url=ranger-pasted-kissable.ngrok-free.dev 3000`, or `cloudflared tunnel --url http://localhost:3000` (no account, but the URL changes every run, so you have to update ElevenLabs each time). The API is then at `https://<tunnel>/api`, so ElevenLabs uses `https://<tunnel>/api/v1/voice/...`. Browsers see ngrok's warning page once.
