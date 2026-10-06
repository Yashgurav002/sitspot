# Sitspot — Build Spec (v3, zero-cost)

> **The outdoors, calling you back.**
> Sitspot watches a few real places near you (terrace, a ground, Vasai Fort, the creek, the beach) using open data. When one of them opens a genuinely good window, it **phones you at home** with the place and the reasons. If you go, your phone stays in your pocket and names the birds around you using an open model running on the phone.

Hackathon: **Hacktoberfest Open-Source AI Challenge, Week 1 — "Touch Grass"** (Oct 5–11, 2026).
Builder location: Vasai, Maharashtra, India (timezone `Asia/Kolkata`).

**Ground rules for this project**

1. **Zero cost.** No paid plans, no paid credits. Only free tiers, free trials that need no card, or credits given by the hackathon/partners.
2. **No extra hardware.** Only your normal phone, and it is never left outside on its own.
3. **Open models at the core.** Every model on the critical path is open-weight.
4. Everything marked **[verify]** was written from training knowledge (reliable to about mid-2026) without web access. Check it against official docs before relying on it.

---

## 0. How to use this file for vibe coding

- Put this file at the repo root as `SITSPOT_BUILD_SPEC.md`. Tell your coding agent: *"Read SITSPOT_BUILD_SPEC.md. We are building it phase by phase. Do only Phase N now. Stop when its acceptance checks pass."*
- Build in the order of **Section 18 (Build plan)**. Each phase lists acceptance checks; don't move on until they pass.
- Keep the agent honest: never let it fake a data source, invent API fields, or hard-code demo results. If an API response differs from this spec, the API wins; update the spec.
- Commit after every passing phase. Turn on Entire (if free) before the first commit so the agent sessions are recorded for the DEV post.

---

## 1. Product in one page

**Problem.** "Go outside more" fails because it is abstract, and because in a city timing really matters: October afternoons are hot, air quality swings by the hour, and the creek is only worth visiting near low tide. Nobody checks five apps to find the good 40 minutes.

**Solution.** You add 3–5 places you could actually go. Sitspot pulls weather, air quality, tide, sun position and recent bird sightings for each place every hour, forecasts which place and hour will be good, and decides whether a moment is worth interrupting you. If it is, it calls you (or sends a voice push) with the place, the reasons and when to leave. If you go, you tap "I'm here", put the phone in your pocket, and talk to it through earphones while it names birds on-device. In the evening it writes a short field note and learns from what you accepted.

**The one wow moment.** Your phone rings at 5:05pm while you're at home: *"The creek is worth a visit in the next hour. Low tide is at 5:20, so the mudflats will be open, and egrets were logged there yesterday. It's cooled to 28 degrees with a breeze, air quality is good, and sunset is at 6:15. Leave by 5:10 and you'll have about 50 minutes of good light."* You go. That call, and real footage of what you find, is the demo.

**Screen budget.** About 3 minutes to set up, then under 1 minute a day.

**Positioning rules (competitors already cover "best time to go outside" and "offline bird ID")**

1. Never describe Sitspot as "the best time to go outside". Say **"your places, calling you"**.
2. Lead with the call and the walk, not the forecast.
3. Bird ID is a supporting feature on visits, never the headline.
4. Compete on depth: real visits, real footage, honest benchmarks.

---

## 2. Zero-cost stack

Default = what to build first. Fallback = what to use if the default needs a card or runs out.

| Job | Default (free) | Free limit / catch | Fallback (free) |
| --- | --- | --- | --- |
| LLM brain (Gemma) | **Google AI Studio / Gemini API free tier, Gemma model** via its OpenAI-compatible endpoint [verify Gemma availability and rate limits] | Rate-limited; prompts may be used to improve Google products on the free tier [verify] | OpenRouter free Gemma variant [verify]; **Ollama on your laptop** for development |
| On-phone bird ID | **BirdNET** in the browser (TensorFlow.js build) [verify a browser build exists] | License CC BY-NC-SA, fine for a non-commercial hackathon [verify] | Run BirdNET in Python on your laptop over home Wi-Fi (say plainly that audio then leaves the phone) |
| Forecast | **TabPFN** open package (`tabpfn`) on CPU, or the free `tabpfn-client` API [verify limits and license] | CPU is slow above a few thousand rows | Train/evaluate on **Kaggle or Colab free GPU** |
| Fine-tuning | **Tinker**, only if the hackathon gives free credits [verify] | Paid otherwise | **Unsloth LoRA on Kaggle free GPU** (fine-tunes Gemma itself; you lose only the Tinker category) |
| Durable workflows | **Temporal Cloud** free trial if no card is needed [verify] | Trial period | **`temporal server start-dev`** on your laptop (free CLI) during the build week |
| Database | **Tiger Cloud** free tier/trial [verify] (Postgres + TimescaleDB + pgvector) | Small storage | **Neon** or **Supabase** free Postgres with pgvector (lose the Tiger category) |
| Hosting | **Render free web services** (web + API) | Sleeps after ~15 min idle, cold start ~1 min; ~750 free instance hours/month; free Postgres expires after 30 days; background workers and cron jobs are not free [verify] | Vercel free for the web app |
| Keep-alive + hourly jobs | **GitHub Actions scheduled workflow** (free on public repos) calling `/cron/*` endpoints; **cron-job.org** (free) as a backup | Actions schedules can run a few minutes late | Run pullers from your laptop |
| Voice (call + conversation) | **ElevenLabs free plan** (TTS, STT, Agents) [verify monthly minutes] | Only about 10–15 minutes of voice a month: save it for real calls and the demo | Browser Web Speech API (free) for development |
| Phone call to your number | **Twilio free trial** balance via ElevenLabs telephony [verify India calling, trial message, verified-number rule] | Trial can only call verified numbers (yours is fine) and plays a trial notice | **Web Push** notification (free) that opens the voice conversation in the browser |
| Weather, AQI, tide | **Open-Meteo** forecast, air-quality and marine APIs (free, no key, non-commercial) [verify tide accuracy for Vasai creek] | Non-commercial use | Cached last hour |
| Bird sightings | **eBird API 2.0** (free key) [verify endpoints and terms] | Rate limits | Conditions-only forecast |
| Sun and moon | `suncalc` npm package | — | — |
| Agent framework | **Mastra** (open source) | — | — |
| Observability | **Sentry free Developer plan** [verify limits] | Small quotas | Console logs |
| Web search (stretch) | **SerpApi free plan** (~100 searches/month) [verify] | Tiny quota | Skip |
| Dev tools | **GitHub Copilot Free** (or free Pro via GitHub Student) [verify features]; **Entire** CLI [verify free] | Monthly limits | — |
| GPU inference | **DigitalOcean GPU Droplet only with free hackathon or sign-up credits** [verify: sign-up credits usually need a card] | Paid otherwise | Not needed: Gemma runs on AI Studio / OpenRouter / Ollama |

### What zero cost does to the partner list

| Partner | Status under zero cost |
| --- | --- |
| Gemma | **Core** (AI Studio free tier, Ollama locally, fine-tuned Gemma via Unsloth) |
| TabPFN | **Core** (open package, free) |
| Render | **Core** (free web services) |
| Temporal | **Core** (Cloud trial or local dev server) |
| Tiger Data | **Core if a free tier/trial works**, else replaced by Neon/Supabase |
| ElevenLabs | **Core**, free minutes used sparingly |
| Mastra | **Core** (open source) |
| Sentry, Entire, GitHub Copilot | **Process** (free plans) |
| Tinker | **Only with free credits**, else Unsloth on Kaggle |
| DigitalOcean | **Only with free credits**, else dropped |
| SerpApi | Stretch, free plan |
| Arduino, Backboard, MongoDB | Not used |

**Ask on day 1:** check the challenge page and Discord/announcements for partner credits (Tinker, DigitalOcean, Temporal, Tiger Data, ElevenLabs often give hackathon credits). Free credits from a partner are fine; anything that needs your card is not.

---
## 3. Product specification

### 3.1 Users
- **Primary:** people who work or study from home in dense cities and have places within ~20 minutes they never visit.
- **Secondary (roadmap):** housing societies, school eco-clubs, walking and birding groups.

### 3.2 User journey
1. **Add spots (3 min, screen).** Pick 3–5 places on a map or from current location; set travel time, quiet hours, and what you love ("sunsets, kingfishers, anything near water").
2. **Watch (all day, no screen).** Hourly pulls of conditions per spot; forecast per spot and hour.
3. **Invite (10 s, voice).** When a window clears the bar, the phone rings (or a voice push arrives) with where, why, and when to leave. You can ask follow-ups ("How far?", "Anything closer?").
4. **Go (minutes, outside).** Walk or take an auto.
5. **Arrive (5 s, screen, optional).** Tap **"I'm here"**. Screen goes black (pocket mode), mic on, BirdNET runs on the phone.
6. **Notice (minutes, voice).** Through earphones: "What was that call?", "Three egrets on the left." Answers come from on-phone detections; your words are logged.
7. **Reflect (evening, 30 s, screen).** Short field note: what you saw, what the spot did, when to come back. Rate the visit 1–5.
8. **Learn (continuous).** Accepts, declines, no-answers, arrivals and ratings tune the policy.

### 3.3 Example spots (Vasai)
| Spot | Kind | Good for | Note |
| --- | --- | --- | --- |
| Your terrace / balcony | `home` | Dawn birds, sunset | Zero travel |
| A nearby ground or park | `park` | Morning/evening walk | Pick one within 10 min |
| Vasai Fort | `heritage` | Evening walk, birds in greenery | Check opening hours [verify] |
| Creek / mangrove edge | `coastal` | Shorebirds on a falling tide | Firm ground only; never onto mudflats |
| Arnala / Rangaon / Bhuigaon beach | `coastal` | Sunset, breeze | Tide and daylight rules apply |

### 3.4 Signals per spot (hourly)
| Signal | Source | Notes |
| --- | --- | --- |
| Temperature, apparent temperature, humidity, wind, precipitation, cloud cover | Open-Meteo Forecast API | Hourly, `timezone=Asia/Kolkata` [verify param names] |
| PM2.5, PM10, US AQI | Open-Meteo Air Quality API | [verify variable names, e.g. `us_aqi`, `pm2_5`] |
| Sea level / tide height | Open-Meteo Marine API | [verify a tide variable such as `sea_level_height_msl` and its accuracy for a creek] |
| Sunrise, sunset, golden hour, moon | `suncalc` | Computed locally |
| Recent bird sightings near spot | eBird API 2.0 `data/obs/geo/recent` (lat, lng, dist, back) | [verify] |

### 3.5 The decision (code, not model)

For each spot `s` and candidate hour `h` in the next 6 hours:

```
score(s,h) = p_rich(s,h)            # TabPFN probability of good birding (0..1)
           * comfort(s,h)           # 0..1 from apparent temp, AQI, rain
           * tide_fit(s,h)          # coastal spots only; 1.0 for others
           * light_bonus(s,h)       # 1.0, or up to 1.3 within golden hour
           * novelty(s,h)           # 1.0, up to 1.3 if a loved species was reported nearby in 48h
           * availability(h)        # 0 or 1 from policy, times a learned per-hour accept factor (0.5..1.5)
```

- `comfort`: 1.0 when apparent temp ≤ 30°C, falls linearly to 0 at 38°C; multiply by AQI factor (1.0 at AQI ≤ 100, 0.5 at 150, 0 at ≥ 200); 0 if precipitation > 2 mm/h.
- `tide_fit` (coastal): 1.0 when tide is falling and between 1 and 3 hours before low tide; 0.6 near low; 0.2 rising; 0 within the safety margin of high tide.
- `availability = 0` if: inside quiet hours, already 2 invitations today, within 3 h of a decline, or an invitation is already open.
- **Invite** if `score ≥ threshold_user` (start 0.35; reflection nudges it ±0.05 nightly based on accept/rating) and every safety rule passes.
- **Send time** = window start − travel_min − 10 min.
- Always store `score`, each factor, and a **one-sentence reason** with the invitation.

All weights live in `packages/policy/config.ts` so they're easy to tune and test.

### 3.6 Safety rules (hard-coded, tested, never overridden by the model)
1. No `coastal` invitations after sunset − 30 min or before sunrise.
2. No `coastal` invitations when the window overlaps high tide ± 60 min [verify a sensible local margin].
3. Never suggest walking onto mudflats, into water, or off paths; the call script always says "stay on firm ground" for coastal spots.
4. No invitations at all when apparent temperature ≥ 38°C or AQI ≥ 200.
5. Quiet hours are absolute.

### 3.7 Memory
| Level | Contents | Storage | Visible behaviour change |
| --- | --- | --- | --- |
| Short-term | Current call/visit: detections, what you said | Temporal workflow state | "That's the same call you asked about two minutes ago" |
| Long-term | Preferences, quiet hours, accept history by hour/spot, travel times | `preferences`, `invitations` tables | Say "the creek is too far on weekdays" once → creek only invited at weekends |
| Semantic | Field notes and voice observations, embedded | `field_notes`, `observations` + hybrid search | "Last time you saw egrets there was Wednesday, on a falling tide" |

Preference writes require a **quoted user utterance** stored in `source_utterance`.

### 3.8 Voice scripts
- **Call opener (template filled by the LLM from structured facts only):** place, the 2–3 strongest reasons with numbers, when to leave, how long it stays good, a safety line for coastal spots, then "Want to go?"
- **Follow-ups it must handle:** how far, anything closer, how long will it be good, is it raining, not today, don't call me for X.
- **On a visit:** species answers always include confidence: "Most likely a common kingfisher, heard twice in the last minute. Fairly confident, not certain."
- **Never** name a species that is not in the current detections or recent eBird data for that spot.

---

## 4. Architecture

```
                REAL-WORLD INPUTS
 ┌──────────────────────┐ ┌──────────────────────────┐ ┌─────────────────────┐
 │ Open data APIs       │ │ Your phone, on a visit   │ │ You                 │
 │ Open-Meteo, eBird    │ │ BirdNET in the browser   │ │ answer the call     │
 │ (pulled hourly)      │ │ audio never leaves phone │ │ tap "I'm here"      │
 └─────────┬────────────┘ └────────────┬─────────────┘ └──────────▲──────────┘
           │ hourly pulls               │ detections (JSON only)   │ phone call / voice push
 ┌─────────▼────────────────────────────▼─────────────────────────┴──────────┐
 │ RENDER (free web services)                                                │
 │  apps/web  Next.js PWA + visit page          apps/api  Hono + Mastra agent │
 │  (spots, notes, pocket mode)                 REST, /cron/*, custom-LLM,   │
 │                                              Temporal worker (in-process) │
 └──────┬──────────────────┬───────────────────┬─────────────────┬───────────┘
        │                  │                   │                 │
 ┌──────▼───────┐  ┌───────▼────────┐  ┌───────▼───────┐  ┌──────▼─────────┐
 │ Gemma        │  │ Tiger Data     │  │ ElevenLabs    │  │ Temporal       │
 │ AI Studio /  │  │ Postgres +     │  │ calls, STT,   │  │ Cloud trial or │
 │ OpenRouter / │  │ Timescale +    │  │ TTS; brain =  │  │ local dev      │
 │ Ollama       │  │ pgvector       │  │ our agent     │  │ server         │
 └──────────────┘  └────────────────┘  └───────────────┘  └────────────────┘
        TabPFN: runs in a Python job (GitHub Actions / laptop) and writes forecasts to the DB
        Sentry: traces every span from data pull to phone call
        GitHub Actions: hourly cron + keep-alive pings to the free Render services
```

**Why the Temporal worker runs inside the API process:** Render background workers aren't free. The API web service starts the Temporal worker on boot; GitHub Actions/cron-job.org ping `/health` every 10 minutes so the free service doesn't sleep. During the build week, you can also just run the worker on your laptop.

### 4.1 Components
| Component | Runs on | Stack | Owns |
| --- | --- | --- | --- |
| Web PWA + visit page | Render free web service | Next.js (App Router), TypeScript, Tailwind | Spots, quiet hours, notes, search, pocket mode |
| API + agent + worker | Render free web service | Node 20+, TypeScript, Hono, Mastra, Temporal TS SDK | REST, cron endpoints, custom-LLM endpoint, MCP, workflows |
| Forecast job | GitHub Actions (hourly) or laptop | Python 3.11, `tabpfn`, `pandas`, `psycopg` | Reads features, writes `forecasts` |
| Data pullers | Called by GitHub Actions via `/cron/pull` | TypeScript in the API | Weather, AQI, tide, eBird into the DB |
| LLM | AI Studio / OpenRouter / Ollama | OpenAI-compatible client | Call scripts, conversation, notes, preference extraction |
| Database | Tiger Cloud (or Neon/Supabase) | Postgres + TimescaleDB + pgvector (+ pg_textsearch/`tsvector`) | Time-series, memory, retrieval |
| Voice | ElevenLabs Agents + Twilio trial | Custom LLM pointing at our API | Calls, in-visit conversation |
| Observability | Sentry free | `@sentry/node`, `@sentry/nextjs` | Traces and errors |

---

## 5. Models (all open-weight)

| Piece | Model | Where it runs | Expected quality | Weak spot → fix |
| --- | --- | --- | --- | --- |
| Agent voice and writing | Gemma (latest available; Gemma 3 confirmed, newer likely [verify]) — 12B–27B class | AI Studio free tier / OpenRouter free / Ollama locally | Good for short, grounded text | Tool-calling support varies by provider → use the **context-first pattern** (Section 9) |
| Bird ID | BirdNET | Your phone's browser during visits | Research-grade, covers Indian species; traffic/horns reduce accuracy | Use BirdNET's location/week species filter for Vasai; confidence threshold ≥ 0.5; always speak confidence |
| Forecast | TabPFN | Python job (CPU/Kaggle) | Strong on small tables | Cap ~5–10k rows; check license [verify] |
| Field Note Compiler | Small Gemma (e.g. 1B–4B) fine-tuned with Unsloth LoRA on Kaggle, or a Tinker LoRA if credits | Ollama locally / AI Studio not possible for custom weights → serve via Ollama on laptop or skip in prod | Good after tuning | Only detected species allowed; verifier rejects anything else |
| Embeddings | Open small embedding model (e.g. `nomic-embed-text` via Ollama, or a Gemma embedding model [verify]) | Ollama / API | Fine | — |

**Swappability:** every LLM call goes through one OpenAI-compatible client configured by `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. Swapping providers is an env change.

**Serving the fine-tuned model for free:** export the LoRA-merged model to GGUF and run it with Ollama on your laptop for the nightly note job (runs once a day, while you're home). In production fallback, the base Gemma via AI Studio writes the note with a strict verifier. Be honest about this in the article.

---
## 6. Repository structure

```
sitspot/
├── apps/
│   ├── web/                    Next.js PWA: spots, settings, notes, search, visit page (pocket mode)
│   └── api/                    Hono server: REST, /cron/*, custom-LLM endpoint, MCP, starts Temporal worker
├── packages/
│   ├── policy/                 Decision score, safety rules, config.ts (pure functions, heavily tested)
│   ├── agent/                  Mastra agent, prompts, context builders, intent extraction
│   ├── data/                   Open-Meteo, eBird, suncalc pullers + typed clients
│   ├── db/                     SQL migrations, query helpers, hybrid search
│   ├── llm/                    One OpenAI-compatible client (AI Studio / OpenRouter / Ollama)
│   └── shared/                 Types (zod schemas) shared by web and api
├── workflows/                  Temporal workflows + activities (imported by apps/api)
├── ml/
│   ├── tabpfn/                 export_ebird.py, features.py, train_eval.py, forecast_job.py
│   ├── finetune/               build_dataset.py, verifier.py, train_unsloth.ipynb (Kaggle), eval.py
│   └── birdnet-web/            browser model files + loader (or instructions to fetch them)
├── evaluation/                 benchmark scripts and committed result tables (CSV/MD)
├── tests/                      unit, integration, workflow, failure, e2e
├── docs/                       architecture.png, field-notes.md (your real visits), screenshots
├── .github/workflows/          ci.yml, cron.yml (hourly pull + forecast + keep-alive)
├── render.yaml
├── .env.example
└── README.md
```

Package manager: `pnpm` workspaces. Node 20+. Python 3.11 for `ml/`.

---

## 7. Database schema

Works on any Postgres with `pgvector`. On Tiger Cloud, also run the TimescaleDB lines. Embedding size 768 assumes `nomic-embed-text`; change it to match your model.

```sql
create extension if not exists vector;
-- Tiger Cloud only:
-- create extension if not exists timescaledb;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  phone_e164 text,                    -- encrypt at app level before storing
  timezone text not null default 'Asia/Kolkata',
  quiet_start time not null default '22:00',
  quiet_end time not null default '07:00',
  threshold real not null default 0.35,
  push_subscription jsonb,            -- Web Push fallback
  created_at timestamptz not null default now()
);

create table spots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('home','park','heritage','coastal')),
  lat double precision not null,
  lon double precision not null,
  travel_min int not null default 10,
  created_at timestamptz not null default now()
);

create table conditions (
  time timestamptz not null,
  spot_id uuid not null references spots(id) on delete cascade,
  temp_c real, apparent_c real, rh_pct real, wind_ms real,
  precip_mm real, cloud_pct real,
  pm25 real, pm10 real, us_aqi real,
  tide_m real,
  is_forecast boolean not null default true,
  primary key (spot_id, time)
);
-- select create_hypertable('conditions','time', if_not_exists => true);

create table sightings (
  time timestamptz not null,
  checklist_id text,
  loc_id text,
  lat double precision, lon double precision,
  species_code text not null,
  common_name text,
  how_many int,
  primary key (loc_id, species_code, time)
);
-- select create_hypertable('sightings','time', if_not_exists => true);

create table training_checklists (       -- TabPFN training table (from eBird)
  checklist_id text primary key,
  loc_id text, lat double precision, lon double precision,
  obs_time timestamptz,
  duration_min int,
  protocol text,
  num_species int,
  features jsonb not null default '{}'   -- joined weather/AQI/tide/sun features
);

create table forecasts (
  time timestamptz not null,             -- the hour being forecast
  spot_id uuid not null references spots(id) on delete cascade,
  p_rich real not null,
  model_version text not null,
  created_at timestamptz not null default now(),
  primary key (spot_id, time, model_version)
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  spot_id uuid not null references spots(id),
  window_start timestamptz not null,
  window_end timestamptz not null,
  score real not null,
  factors jsonb not null,                -- each factor of the score
  reason text not null,                  -- one sentence
  script text,                           -- what the call said
  channel text not null default 'call' check (channel in ('call','push')),
  status text not null default 'pending'
    check (status in ('pending','sent','accepted','declined','no_answer','arrived','completed','missed','cancelled')),
  workflow_id text,
  call_id text,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create table visits (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid unique references invitations(id),
  arrived_at timestamptz not null,
  ended_at timestamptz,
  minutes int,
  rating int check (rating between 1 and 5)
);

create table detections (
  time timestamptz not null,
  visit_id uuid not null references visits(id) on delete cascade,
  species_code text not null,
  common_name text,
  confidence real not null,
  model_version text not null,
  primary key (visit_id, time, species_code)
);
-- select create_hypertable('detections','time', if_not_exists => true);

create table observations (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid references visits(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  time timestamptz not null default now(),
  text text not null,
  embedding vector(768)
);

create table field_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  body text not null,
  facts jsonb not null,                  -- deterministic facts the note was built from
  model text not null,
  embedding vector(768),
  body_tsv tsvector generated always as (to_tsvector('english', body)) stored
);
create index on field_notes using gin (body_tsv);
create index on field_notes using hnsw (embedding vector_cosine_ops);
-- Tiger Cloud alternative for BM25: pg_textsearch index [verify syntax/availability]

create table preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  key text not null,                     -- e.g. 'avoid_species', 'spot_weekends_only', 'loves'
  value jsonb not null,
  source_utterance text not null,        -- the user's own words, required
  created_at timestamptz not null default now()
);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid references invitations(id),
  kind text not null,                    -- 'script','chat','note','intent'
  model text not null,
  tokens_in int, tokens_out int, latency_ms int,
  trace_id text,
  created_at timestamptz not null default now()
);
```

**Hybrid search (reciprocal rank fusion):**

```sql
with q as (select plainto_tsquery('english', $1) as tsq),
kw as (
  select id, row_number() over (order by ts_rank_cd(body_tsv, q.tsq) desc) as r
  from field_notes, q
  where user_id = $2 and body_tsv @@ q.tsq
  order by ts_rank_cd(body_tsv, q.tsq) desc
  limit 20
),
vec as (
  select id, row_number() over (order by embedding <=> $3) as r
  from (select id, embedding from field_notes where user_id = $2
        order by embedding <=> $3 limit 20) s
)
select id, sum(1.0 / (60 + r)) as rrf
from (select * from kw union all select * from vec) t
group by id order by rrf desc limit 5;
```

---

## 8. API

Base: `apps/api`. All JSON. Auth: magic-link session for web routes; `X-Cron-Secret` for `/cron/*`; `X-Voice-Secret` for ElevenLabs; short-lived visit token for detection uploads.

| Method & path | Caller | Purpose |
| --- | --- | --- |
| `GET /health` | keep-alive | 200 OK; also reports DB, LLM and Temporal status |
| `POST /auth/magic-link` · `GET /auth/callback` | web | Sign-in |
| `GET/POST/PATCH/DELETE /v1/spots` | web | Manage spots |
| `GET /v1/spots/:id/conditions?hours=12` | web, agent | Conditions + forecast with model version |
| `GET /v1/spots/:id/sightings?days=7` | agent | Recent eBird sightings near the spot |
| `GET /v1/invitations?status=` · `GET /v1/invitations/:id` | web | History with score breakdown and reason |
| `POST /v1/invitations/:id/respond` `{accepted: bool}` | web, call webhook | Signal into Temporal |
| `POST /v1/visits/:invitationId/arrive` | visit page | "I'm here" → `arrived` signal; returns visit token |
| `POST /v1/visits/:id/detections` `[{time,species_code,common_name,confidence,model_version}]` | visit page | Batched, idempotent; never audio |
| `POST /v1/visits/:id/observations` `{text}` | visit page | Typed/voice observation |
| `POST /v1/visits/:id/end` `{rating}` | visit page | `visitEnded` signal |
| `GET /v1/notes?date=` · `GET /v1/notes/search?q=` | web, agent | Notes; hybrid search |
| `GET/POST/DELETE /v1/memory/preferences` | web, agent | Preferences (writes need `source_utterance`) |
| `POST /v1/voice/llm/chat/completions` | ElevenLabs | OpenAI-compatible (streaming SSE) custom-LLM endpoint [verify ElevenLabs request/response format] |
| `POST /v1/voice/webhooks/post-call` | ElevenLabs | Call outcome + transcript; verify signature [verify] |
| `POST /v1/push/subscribe` | web | Save Web Push subscription |
| `POST /cron/pull` | GitHub Actions | Pull conditions for all spots (+ eBird daily) |
| `POST /cron/forecast-ingest` | forecast job | Bulk insert forecasts |
| `GET /mcp` | MCP clients | Read-only tools: list spots, conditions, forecast, search notes |

---

## 9. Agent (Mastra, context-first)

Open models differ in tool-calling support across free providers. So the agent **does not depend on tool calling**. The server gathers all context first, the model only writes, and a separate structured call extracts intents. If the provider supports tools, you may enable Mastra tools as an upgrade; the context-first path must still work.

### 9.1 Calls the LLM makes
| Kind | Input | Output | Validation |
| --- | --- | --- | --- |
| `script` | Invitation facts JSON (spot, window, factors, numbers, sightings, safety line) | `{script: string, reason: string}` | Zod; numbers in script must appear in facts; no species outside facts |
| `chat` | Context block + recent turns + user utterance | Short spoken reply (≤ 3 sentences) | Species check against context; strip unsafe advice |
| `intent` | User utterance + last reply | `{save_preference?: {key, value, quote}, respond?: 'accept'|'decline', end_visit?: bool}` | Zod; quote must be a substring of the utterance |
| `note` | Deterministic facts of the day | `{body: string}` | Verifier: species, counts, times must match facts |

### 9.2 Context block (built by `packages/agent/context.ts`)
```
NOW: 2026-10-08 17:05 IST
INVITATION: spot "Creek edge" (coastal), window 17:15–18:05, leave by 17:05, travel 12 min
FACTS: low tide 17:20 (0.6 m), falling; apparent 28°C; wind 4 m/s; US AQI 62; sunset 18:15
SIGHTINGS (eBird, last 48h, ≤3 km): Little Egret ×6 (yesterday 07:40), Common Kingfisher ×1
LIVE DETECTIONS (this visit): Common Kingfisher 0.71 (17:31), Red-vented Bulbul 0.64 (17:29)
PREFERENCES: loves "kingfishers"; "creek weekends only" = false
RELEVANT NOTES: [2026-10-07] "Egrets on the mudflats at falling tide..."
SAFETY: coastal → stay on firm ground; leave before 17:45 (sunset − 30)
```

### 9.3 System prompt (starting point)
```
You are Sitspot, a calm, friendly voice that invites one person outside to places they chose.
Speak in short, natural sentences. Maximum 3 sentences per turn.
Use ONLY the facts in the context block. Never invent numbers, times, places or species.
When naming a bird, say how confident you are, using the detection confidence:
≥0.8 "confident", 0.6–0.8 "fairly confident, not certain", <0.6 "possibly".
If asked something the context can't answer, say you don't know.
For coastal spots, always remind them to stay on firm ground. Never suggest entering mudflats or water.
Never pressure. If they decline, accept warmly and say when the next good window might be, if the context has one.
```

### 9.4 Custom-LLM endpoint for ElevenLabs
- ElevenLabs sends an OpenAI-style `chat.completions` request; our endpoint maps the last user message to a `chat` turn, builds the context block from the active invitation/visit (looked up by a dynamic variable or call metadata [verify how ElevenLabs passes it]), runs `intent` in parallel, streams the reply back as OpenAI SSE.
- Latency budget: context fetch < 150 ms (cache per call), first token < 800 ms. If AI Studio is slow, use a smaller Gemma for `chat`.

---

## 10. Temporal workflows

Task queue: `sitspot`. Worker starts inside `apps/api` (or `pnpm worker` on your laptop).

### 10.1 `UserDayWorkflow(userId)` — one per user, continues-as-new daily
```
loop until local midnight:
  await sleep(until next hour + 5 min)          // after /cron/pull and forecast job
  candidates = await activities.evaluateWindows(userId)   // runs policy for every spot × next 6h
  best = top candidate that passes safety + availability
  if best: start child InvitationWorkflow(best) (workflowId = `inv-${userId}-${best.windowStart}`)
at midnight: await activities.reflect(userId)  // notes, threshold nudge, accept factors
continueAsNew(userId)
```

### 10.2 `InvitationWorkflow(invitation)`
```
await sleep(until invitation.sendAt)
recheck = await activities.recheckWindow(invitation)        // conditions may have changed
if !recheck.ok: mark cancelled; return
script = await activities.composeScript(invitation)         // LLM 'script'
await activities.placeCall(invitation, script)              // ElevenLabs+Twilio; on failure → sendPush
answer = await condition(signal 'responded' , timeout 15 min)  // from post-call webhook or web
if no answer: mark no_answer; return
if declined: mark declined; return
arrived = await condition(signal 'arrived', timeout until window_end)
if !arrived: mark missed; return
ended = await condition(signal 'visitEnded', timeout 90 min)
await activities.compileVisit(invitation)                   // facts → note (fine-tuned model or base + verifier)
await activities.updateMemory(invitation)
mark completed
```
Signals: `responded({accepted})`, `arrived()`, `visitEnded({rating})`. Query: `status()`.
Activity retry policy: 3 attempts, exponential backoff, non-retryable for validation errors.
**Demo:** kill the worker while waiting on `arrived`, restart it, show the workflow resume in the Temporal UI with no duplicate call.

---
## 11. Data pullers (`packages/data`)

All free. Cache responses; never call more than needed.

```
# Weather (hourly, next 48 h)
GET https://api.open-meteo.com/v1/forecast
  ?latitude={lat}&longitude={lon}
  &hourly=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation,cloud_cover
  &wind_speed_unit=ms&timezone=Asia/Kolkata&forecast_days=2

# Air quality
GET https://air-quality-api.open-meteo.com/v1/air-quality
  ?latitude={lat}&longitude={lon}&hourly=pm2_5,pm10,us_aqi&timezone=Asia/Kolkata&forecast_days=2

# Tide (coastal spots only)            [verify variable + accuracy]
GET https://marine-api.open-meteo.com/v1/marine
  ?latitude={lat}&longitude={lon}&hourly=sea_level_height_msl&timezone=Asia/Kolkata&forecast_days=2

# History for TabPFN features
GET https://archive-api.open-meteo.com/v1/archive?latitude=..&longitude=..&start_date=..&end_date=..&hourly=...
(air-quality and marine APIs also accept start_date/end_date for past data [verify how far back])

# eBird (header: X-eBirdApiToken: $EBIRD_API_KEY)     [verify all]
GET https://api.ebird.org/v2/data/obs/geo/recent?lat={lat}&lng={lon}&dist=5&back=7
GET https://api.ebird.org/v2/product/lists/{regionCode}/{y}/{m}/{d}?maxResults=200    # checklist feed for a date
GET https://api.ebird.org/v2/product/checklist/view/{subId}                          # duration, protocol, species
GET https://api.ebird.org/v2/product/spplist/{regionCode}                           # species list for the BirdNET filter
GET https://api.ebird.org/v2/ref/hotspot/info/{locId}                                # hotspot lat/lon
Region codes to check: IN-MH and its districts (Palghar, Thane, Mumbai) [verify exact codes]
```

Derived features computed in code: `minutes_from_sunrise`, `minutes_to_sunset`, `is_golden_hour`, `tide_trend` (rising/falling from consecutive hours), `hours_to_low_tide`, `hours_to_high_tide`.

---

## 12. TabPFN forecast (`ml/tabpfn`)

**Task.** Probability that a ~45-minute birding visit at a place and hour is "rich" (many species), given conditions.

1. `export_ebird.py` — for Sep–Dec of the last 3–4 years plus the current season, pull the checklist feed for the regions above, then checklist details. Throttle to ~1 request/second and cache to disk. Target ~5,000–8,000 checklists. Run it overnight on Wednesday.
2. `features.py` — one row per checklist:
   `hour, day_of_year, minutes_from_sunrise, minutes_to_sunset, is_golden_hour, temp_c, apparent_c, rh_pct, wind_ms, precip_mm, cloud_pct, us_aqi (if history available), tide_m, tide_trend, dist_to_coast_km, duration_min, protocol (stationary/traveling)`.
   Weather/tide history joined on a 0.1° grid to keep API calls low. `dist_to_coast_km` from a small hand-made list of coastline points for the Mumbai–Vasai coast.
3. **Label:** `rich = num_species >= median(num_species)` for that hotspot (hotspots with ≥ 10 checklists), else the regional median for that hour band. Keep only stationary/traveling protocols with 15–120 min duration.
4. `train_eval.py` — time-ordered split: train on older seasons, test on the latest. Compare **TabPFN** vs **hotspot × hour-band average**, **logistic regression**, **XGBoost defaults**. Report ROC-AUC, Brier, precision at the invitation threshold. Save `evaluation/tabpfn_results.md`.
5. `forecast_job.py` (hourly in GitHub Actions) — fit TabPFN on a stratified subsample (~3,000 rows, CPU-friendly), build rows for every spot × next 12 hours (`duration_min=45`, `protocol=traveling`), predict, write to `forecasts` with `model_version`.

Notes: TabPFN downloads weights on first use; cache them in Actions. Check the TabPFN license before submitting [verify].

---

## 13. Fine-tuning the Field Note Compiler (`ml/finetune`)

**Why:** small open models invent birds in notes. The fine-tune teaches "only what's in the facts".

1. `build_dataset.py` — turn real eBird checklists near Vasai into pseudo-visit facts: `{spot_kind, start, end, species: [{name, count, first_time, confidence}], conditions: {...}}`. Add adversarial cases: low-confidence detections (must be hedged), look-alike species not present (must not appear), empty visits.
2. Targets — draft with the big Gemma (AI Studio), then `verifier.py` rejects any species, number or time not in the facts. Check whether Gemma's terms allow training on its outputs [verify]; if unsure, use template targets plus your own edits. ~800 train, 100 test (25 adversarial).
3. **Train (free):** Unsloth LoRA on **Kaggle free GPU** — small Gemma (1B or 4B, whichever fits), r=16, 2–3 epochs. Export merged GGUF → run with Ollama on your laptop.
   **If Tinker credits exist:** same dataset with Tinker on a supported model [verify list]; download the adapter.
4. `eval.py` — on the same 100 test cases: hallucinated-species rate, fact F1, JSON/format validity, p50 latency, for base small Gemma vs tuned vs big Gemma zero-shot. Save `evaluation/finetune_results.md`.

---

## 14. Visit page — pocket mode (`apps/web/app/visit/[id]`)

1. Tap **"I'm here"** → `POST /v1/visits/:invitationId/arrive` → receive visit token.
2. `navigator.wakeLock.request('screen')` (re-acquire on `visibilitychange`). Full-screen black overlay; exit needs a 2-second hold so pocket touches don't end it.
3. `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`; `AudioContext` at 48 kHz; 3-second mono ring buffer [verify BirdNET input spec].
4. Run BirdNET in a **Web Worker** with TensorFlow.js every 3 s. Filter output to the regional species list (from eBird `spplist`), confidence ≥ 0.5, de-duplicate the same species within 60 s. **Discard audio after each window.**
5. Queue detections in IndexedDB; flush every 30 s when online (works with no signal; syncs later).
6. Voice: start an ElevenLabs web conversation (React/JS SDK [verify package]) with the same agent, passing `invitation_id` and `visit_id` as dynamic variables; use earphones.
7. End: "Done" (hold) or 90 min timeout → rating 1–5 → `POST /v1/visits/:id/end`.
8. Measure battery drain per 30 minutes (benchmark).

If no browser build of BirdNET can be made to work by Wednesday night: ship visits without on-phone ID (voice observations + eBird context only) and say so honestly. Don't fake detections.

---

## 15. Voice and phone setup

1. **ElevenLabs Agent:** pick a calm voice; LLM = **Custom LLM** pointing to `https://<api>.onrender.com/v1/voice/llm` with header `X-Voice-Secret` [verify exact setup]; first message = `{{script}}` dynamic variable; enable post-call webhook to `/v1/voice/webhooks/post-call`.
2. **Phone (free):** Twilio free trial → verify your own mobile number → connect the trial number in ElevenLabs telephony → outbound call via the ElevenLabs outbound-call API with `to_number` and dynamic variables (`invitation_id`, `script`) [verify endpoint, India calling, trial notice].
3. **Fallback (free, always build it):** Web Push with VAPID keys (`web-push` npm). Notification text = the first sentence of the script; tapping opens `/call/[invitationId]`, which starts the same ElevenLabs conversation in the browser.
4. **Protect free minutes:** develop with browser Web Speech API; use ElevenLabs only from Thursday for real invitations and the demo.

---

## 16. Environment variables (`.env.example`)

```
# Database
DATABASE_URL=postgres://...

# LLM (OpenAI-compatible: AI Studio / OpenRouter / Ollama)
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/   # [verify]
LLM_API_KEY=
LLM_MODEL_CHAT=gemma-...            # fast model for voice turns
LLM_MODEL_SCRIPT=gemma-...          # call scripts
LLM_MODEL_NOTE=gemma-...            # or local Ollama fine-tune name
NOTE_LLM_BASE_URL=http://localhost:11434/v1   # Ollama for the fine-tuned note model
EMBED_BASE_URL=http://localhost:11434/v1
EMBED_MODEL=nomic-embed-text

# Data
EBIRD_API_KEY=

# Temporal
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_API_KEY=                   # only for Temporal Cloud

# Voice
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_PHONE_NUMBER_ID=
ELEVENLABS_WEBHOOK_SECRET=
VOICE_SHARED_SECRET=
MY_PHONE_E164=+91XXXXXXXXXX

# Push fallback
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@example.com

# Security
CRON_SECRET=
PHONE_ENCRYPTION_KEY=
ADMIN_PASSCODE=                     # hackathon shortcut: single-user sign-in
DEMO_READONLY_USER_ID=              # public read-only demo account

# Observability
SENTRY_DSN_API=
SENTRY_DSN_WEB=

# Web
NEXT_PUBLIC_API_URL=https://<api>.onrender.com
```

Hackathon shortcut: single-user passcode sign-in plus a public read-only demo account. Magic-link sign-in is a nice-to-have.

---

## 17. Deployment (free)

### 17.1 `render.yaml` (free plan) [verify Blueprint fields for pnpm monorepos]
```yaml
services:
  - type: web
    name: sitspot-api
    runtime: node
    plan: free
    buildCommand: corepack enable && pnpm install --frozen-lockfile && pnpm --filter api build
    startCommand: pnpm --filter api start
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        sync: false
      - key: LLM_API_KEY
        sync: false
      # ...all other secrets with sync: false
  - type: web
    name: sitspot-web
    runtime: node
    plan: free
    buildCommand: corepack enable && pnpm install --frozen-lockfile && pnpm --filter web build
    startCommand: pnpm --filter web start
    envVars:
      - key: NEXT_PUBLIC_API_URL
        sync: false
```

### 17.2 `.github/workflows/cron.yml`
```yaml
name: cron
on:
  schedule:
    - cron: "*/10 * * * *"   # keep-alive
    - cron: "5 * * * *"      # hourly pull
    - cron: "15 * * * *"     # hourly forecast
  workflow_dispatch: {}
jobs:
  keepalive:
    if: github.event.schedule == '*/10 * * * *'
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS ${{ secrets.API_URL }}/health && curl -fsS ${{ secrets.WEB_URL }}
  pull:
    if: github.event.schedule == '5 * * * *' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -X POST -H "X-Cron-Secret: ${{ secrets.CRON_SECRET }}" ${{ secrets.API_URL }}/cron/pull
  forecast:
    if: github.event.schedule == '15 * * * *' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11", cache: pip }
      - run: pip install -r ml/tabpfn/requirements.txt
      - run: python ml/tabpfn/forecast_job.py
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```
Keep the repo public so Actions minutes are free. Scheduled runs can be a few minutes late; cron-job.org (free) can ping `/health` as a backup.

### 17.3 Temporal
- **Build week:** `temporal server start-dev` on your laptop + worker on your laptop (you're home when invitations fire anyway).
- **If Temporal Cloud trial works without a card:** point the Render API's in-process worker at it.

### 17.4 Observability (Sentry free)
- `@sentry/node` in `apps/api` with tracing; wrap each LLM call, data pull, policy evaluation and Temporal activity in spans with attributes `model`, `tokens_in`, `tokens_out`, `spot_id`, `invitation_id`.
- `@sentry/nextjs` in `apps/web`, including the visit page.
- Screenshot one full trace (pull → forecast → decision → call → visit → note) for the DEV post.

---

## 18. Build plan (today is Tue Oct 6; submit Sun Oct 11 [verify deadline])

Each phase: tasks → prompt for your coding agent → acceptance checks.

### Phase 0 — Accounts and scaffold (Tue evening)
- [ ] Sign up (free, no card): Google AI Studio, eBird API key, Tiger Cloud (or Neon), Render, ElevenLabs, Twilio trial, Sentry, GitHub; check Temporal Cloud and partner credits
- [ ] Go through Section 21 (verify list) for anything that needs a card → switch to its fallback
- [ ] Turn on Entire and Copilot code review (if free)

> **Prompt:** "Scaffold the pnpm monorepo exactly as Section 6 of SITSPOT_BUILD_SPEC.md: apps/web (Next.js + Tailwind), apps/api (Hono + TypeScript), packages/*, workflows/, ml/. Add .env.example from Section 16, a CI workflow running lint + typecheck + tests, and a README stub. No features yet."

**Done when:** `pnpm dev` runs web and api locally; CI is green.

### Phase 1 — Database, spots and pullers (Wed morning)
> **Prompt:** "Implement Section 7 migrations in packages/db and Section 11 pullers in packages/data with typed zod parsing. Add /cron/pull (Section 8) that fills `conditions` for all spots and refreshes eBird sightings daily. Build the Spots page in apps/web: add a spot by tapping a map or using current location, choose kind and travel time. Use a free map (Leaflet + OpenStreetMap tiles)."

**Done when:** your 3–5 Vasai spots exist, and `conditions` has 48 hours of weather, AQI and (for coastal spots) tide rows that match the Open-Meteo website.

### Phase 2 — TabPFN data + visit page (Wed afternoon/night)
> **Prompt A:** "Implement ml/tabpfn per Section 12: export_ebird.py with caching and 1 req/s throttle, features.py, train_eval.py with the three baselines, forecast_job.py writing to forecasts."
> **Prompt B:** "Implement the visit page per Section 14 with Wake Lock, black overlay, mic capture, BirdNET in a Web Worker via TensorFlow.js, regional species filter, IndexedDB outbox."

**Done when:** eBird export running overnight; visit page shows live detections on your terrace for 15 minutes; battery drain written down.

### Phase 3 — Agent, policy, workflows, voice (Thu)
> **Prompt:** "Implement packages/llm (one OpenAI-compatible client), packages/policy (Section 3.5–3.6 with unit tests for every safety rule), packages/agent (Section 9 context-first pattern, zod-validated outputs, species check), workflows (Section 10) with signals and retries, the custom-LLM endpoint and post-call webhook, and the Web Push fallback (Section 15)."

**Done when:** a test invitation calls your phone (or pushes), the reply is grounded in real facts, declining sets a cooldown, and **the first real invitation fires Thursday evening. Go.**

### Phase 4 — Depth (Fri)
- [ ] Fine-tune on Kaggle (Section 13); eval; switch the evening note to the tuned model if it wins
- [ ] Hybrid search + 40-question retrieval eval
- [ ] Preference memory with one visible behaviour change
- [ ] Sentry spans everywhere; Render deploy; GitHub Actions cron live

**Done when:** deployed URLs work, hourly jobs run without your laptop (except Temporal/notes if local), and three result tables exist in `evaluation/`.

### Phase 5 — Go outside (Fri evening → Sat)
- [ ] Answer every invitation; at least 4 visits including one creek visit on a falling tide and one sunset
- [ ] Film the call, the walk, arriving, the birds; switch to pocket mode on arrival
- [ ] Write a few honest lines after each visit in `docs/field-notes.md`

### Phase 6 — Benchmarks (Sat afternoon)
- [ ] Run Section 19 benchmarks; commit tables
- [ ] Record the kill-and-resume clip

### Phase 7 — Polish (Sat evening)
- [ ] Read-only demo account with your real week; README sections 1–16; architecture image; tag v0.1

### Phase 8 — Video (Sun morning) · Phase 9 — DEV post (Sun by noon, submit with 6 h buffer)

---

## 19. Tests and benchmarks

**Tests:** unit (policy, safety rules, verifier, species check, quote check); integration (pull → store → forecast → evaluateWindows); Temporal time-skipping tests (a week of invitations in seconds; no duplicate calls after worker kill); agent evals (40 scripted turns: never names undetected species, always states confidence, never sends anyone to the coast after dark); e2e (replay a recorded day of conditions → the right invitation fires). One file: `tests/when_ai_is_wrong.test.ts`.

| # | Benchmark | Metric | Compared against | Target |
| --- | --- | --- | --- | --- |
| 1 | Note model (fine-tune) | Hallucinated-species rate, fact F1, latency | Base small Gemma; big Gemma zero-shot | < 2% hallucination; F1 ≥ big Gemma; faster |
| 2 | TabPFN forecast | ROC-AUC, Brier, precision@threshold | Hotspot×hour average; logistic regression; XGBoost | AUC ≥ best baseline + 0.05 |
| 3 | On-phone bird ID | Precision/recall on 30 labelled clips | Default threshold | Precision > 0.85 |
| 4 | Retrieval | Recall@5, MRR on 40 questions | BM25 only; vector only | Hybrid beats both |
| 5 | Voice latency | End of speech → first audio | Two Gemma sizes | p50 < 1.5 s [validate] |
| 6 | End-to-end | Decision → phone ringing | — | < 30 s |
| 7 | Durability | Correct resumes out of 20 forced kills | — | 20/20 |
| 8 | Invitation quality | Share of visits rated 4–5 | Rules without TabPFN (shadow) | ≥ 70% |
| 9 | Battery | % per 30-min visit in pocket mode | — | Report honestly |
| 10 | Touch Grass impact | Minutes outside vs screen seconds per day | Your previous month | Outside > screen, every day |

Publish real numbers only, including misses. One person for one week is an anecdote; say so.

---

## 20. Demo (3 min) and DEV post

| Time | Shot | Audio |
| --- | --- | --- |
| 0:00–0:15 | You at your desk in Vasai, hazy window | "There's a creek, a fort and a beach near me. Last month I went to none of them. I never knew when it was worth it." |
| 0:15–0:30 | Adding three spots in under a minute | "So I built Sitspot. You tell it the places you could go. It watches them for you." |
| 0:30–0:40 | Back to work; clock hits 5:05 | Room sound |
| 0:40–1:00 | Phone rings: "Sitspot" | The real call: place, reasons, when to leave |
| 1:00–1:25 | Walk/auto, arrive, tap "I'm here", phone into pocket, real birds | "What's that call?" → answer with confidence |
| 1:25–1:45 | Sentry trace of that window | "And the audio never left my pocket." |
| 1:45–2:00 | Architecture, open models highlighted | Name the open models and where they run |
| 2:00–2:20 | Kill the worker mid-invitation; restart; it resumes | "Sunsets don't wait for deploys." |
| 2:20–2:40 | Three benchmark cards | Read the real numbers |
| 2:40–3:00 | Evening note; creek at sunset | "The screen took 50 seconds today. The creek took 40 minutes." |

**DEV post template sections:** What I Built · Demo · Code · How I Built It · Why Does Open Innovation Matter? · My Agent Session · Prize Categories. Title idea: *"The creek called me at 5:05pm. I went."* Write it as a week of real visits; the full draft lives in the strategy doc. Key "open innovation" points: on-phone audio privacy, weak signal at the creek, always-on cost shape, fine-tuning, swappability, community data (eBird checklists, open models).

**Prize categories to list (only what you actually built):** Gemma · TabPFN · Render · Temporal · Tiger Data (if used) · ElevenLabs · Mastra · Sentry · Entire · GitHub Copilot · Tinker / DigitalOcean only if you got free credits and used them · SerpApi only if built.

---

## 21. Verify list (do on day 1)

- [ ] Challenge deadline, timezone, template wording, exact prize list ($2,450 / 17 winners per the announcement)
- [ ] Gemma model available on Google AI Studio free tier + OpenAI-compatible endpoint + rate limits; newest Gemma version
- [ ] OpenRouter free Gemma availability and daily limits
- [ ] Open-Meteo variable names (air quality, marine tide) and tide usefulness for Vasai creek; history range
- [ ] eBird endpoints, region codes, response fields (checklist feed, checklist view), rate limits, terms
- [ ] BirdNET browser (TF.js) build, input format, license; species filter approach
- [ ] TabPFN license and CPU performance at ~3,000 rows
- [ ] Gemma terms on training with model outputs
- [ ] Unsloth + Kaggle free GPU quota and Gemma support
- [ ] Tinker / DigitalOcean / Temporal / Tiger / ElevenLabs hackathon credits (no card)
- [ ] Temporal Cloud trial requirements
- [ ] Tiger Cloud free tier; pg_textsearch availability
- [ ] Render free plan limits (sleep, hours, Postgres expiry, no free workers/cron) and Blueprint monorepo fields
- [ ] ElevenLabs free minutes, custom-LLM request/response format, dynamic variables, post-call webhook signature
- [ ] Twilio trial: calling an Indian number, trial notice, verified-number rule, connecting to ElevenLabs
- [ ] Sentry free plan tracing limits; Mastra/Sentry integration path
- [ ] GitHub Copilot Free features (code review?), Entire free usage
