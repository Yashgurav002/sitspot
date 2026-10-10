---
title: Sitspot — my places, calling me back outside (and why it said "no" all week)
published: false
tags: devchallenge, hf26challenge, ai, opensource
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05)*

## What I Built

I live in Vasai, near Mumbai. Within 20 minutes of my desk there's a park, a lake edge and three beaches. Last month I went to none of them. Not because I didn't want to, but because in an Indian city in October **timing is everything**: afternoons feel like 38°C, air quality swings by the hour, and the coast is only nice near low tide and before dark. Nobody checks five apps to find the good 40 minutes.

**Sitspot** watches a few real places *you* choose and calls you back outside only when one of them opens a genuinely good window.

- You add 3–5 spots once (a park, a beach, your terrace) — that's most of the screen time you'll ever spend.
- Every hour it pulls weather, air quality, tide timing, sun position and recent eBird sightings for each spot, and forecasts how good birding will be with **TabPFN**.
- A plain, tested **decision function** (code, not a model) scores every spot × hour — and five **hard safety rules** can veto anything: no coast after sunset − 30 min, none near high tide, nothing at ≥ 38°C feels-like or US AQI ≥ 200, quiet hours are absolute.
- When a window clears the bar, **Gemma** writes a short, grounded invitation ("…Leave by 6:40, it stays good until 8:00. The air is poor (US AQI 150), so keep it short and easy. Want to go?"), and your phone buzzes.
- Tap it and **Sitspot talks to you** (ElevenLabs voice, with Gemma as the brain). Ask "how far is it?", say "yes, let's go".
- At the spot, tap **I'm here** and put the phone in your pocket: **BirdNET runs on the phone** and names what it hears, always with an honest confidence word. **Audio never leaves the phone.**
- In the evening it writes a short field note, and every night it learns from what you accepted.

The screen is the shortest part of it: ~3 minutes of setup, then a buzz, a tap, and you're out.

## Demo

- Live app: **https://sitspot.vercel.app**
- Video (phone screen recording):

{% youtube VIDEO_ID %}

**Honest note on the video.** Vasai's air was *hazardous* for my whole build week — US AQI 200–299 most evenings, 35–39°C feels-like. Sitspot did exactly what it should and **refused to invite me anywhere**; even its "send a TEST invitation" button refuses when no window passes the safety rules. So the recording uses a **TEST invitation** (the real pipeline — Gemma script, push, voice, visit, field note — with only the score threshold skipped, never safety) for a clean-air test spot, recorded at home. You can see my real Vasai spots on the home screen marked *AQI 229 · very unhealthy*. In pocket mode it heard a **House Crow** (they're everywhere here) and a **Barn Owl — "possibly"** at 2:50 pm indoors, which is almost certainly a false detection. That "possibly" is the point: the app is designed to say how sure it is and never to invent a bird.

The forecast says the air improves this weekend; the first real dawn invitation is queued for my park.

## Code

{% github Yashgurav002/sitspot %}

A pnpm monorepo: Next.js 16 PWA (`apps/web`), Hono API (`apps/api`), Temporal workflows (`workflows/`), and small packages for the policy, agent, LLM client, data pullers and DB. ~300 tests across TypeScript and Python; CI runs typecheck + tests on every push.

## How I Built It

**Open models, each doing the one thing it's best at:**

| Job | Open model | Where it runs |
| --- | --- | --- |
| Invitation scripts + evening notes | **Gemma 4 31B** | Google AI Studio (free tier) |
| Live voice replies | **Gemma 3 1B** | My laptop, via Ollama (p50 time-to-first-token 379 ms) |
| Bird ID | **BirdNET** (TF.js build) | Inside the phone's browser, in a Web Worker (~120–340 ms per 3-second window) |
| "Will birding be good here at 7 am?" | **TabPFN** | Python job, hourly, on my laptop |
| Note search embeddings | **nomic-embed-text** | Ollama |

**Context-first, not tool-calling.** The server gathers every fact (weather, tide timing, sightings, your preferences) into a small context block; the model only *writes*. Then validators check every output: every number must appear in the facts, no bird may be named that wasn't detected or reported, coastal scripts must say "stay on firm ground", nothing may encourage the coast after dark, confidence words must match the detection score. A failure gets one retry with the problems fed back, then a deterministic template. On my 40-turn adversarial eval (Gemma 3 1B), the raw model named a bird that wasn't there in 5% of turns; **0% reached the user**. Unsafe advice reaching the user went from 12.5% → 2.5% after I enforced the coast-after-dark rule inside the agent itself — the eval caught that before any real person did.

**Temporal makes it durable.** One workflow per day evaluates hourly; each invitation is its own workflow (sleep until send time → re-check conditions → write script → deliver → wait for answer → wait for arrival → wait for the visit to end → write the note). I killed the worker 20 times at every waiting point: **20/20 resumed, 0 duplicate notifications**.

**TabPFN, honestly.** I trained on **19,588 real eBird checklists** (2022–2026, Palghar/Thane/Mumbai) joined with Open-Meteo history. On the held-out 2026 season TabPFN **tied** the simple hotspot × hour baseline on ROC-AUC (0.649 vs 0.650) — it did *not* hit my target of +0.05. But it had the **best precision at the invite threshold (0.627 vs 0.549)** while flagging far fewer hours, which is exactly what an app that should rarely interrupt you needs. The main limit: eBird's rate limits pushed me to the daily feed, so 96% of rows lack checklist duration and the label is noisy. Results file: `evaluation/tabpfn_results.md`.

**Memory.** Say "the creek is too far on weekdays" and that becomes a rule — weekday creek windows are held back, and the reason quotes your own words. Every preference must store the user's actual sentence. Overnight it nudges your threshold and learns which hours you say yes to.

**Hosting for ₹0.** The web app is on Vercel; the API, Temporal worker and Ollama run on my laptop behind a free ngrok domain, with Vercel proxying `/api` so it's one origin. Postgres is PGlite (embedded, with pgvector) — swap in any Postgres via `DATABASE_URL`.

**What didn't work (and what I did instead).** I wanted a real phone call. ElevenLabs + Twilio is wired and tested up to Twilio — but **new Twilio trial accounts block streaming call audio to an AI agent**, so the "call" happens in the browser instead: the push opens the call page and Sitspot speaks through ElevenLabs. The Twilio-direct code is in the repo and works on a paid account.

## Why Does Open Innovation Matter?

- **Privacy you can verify.** Bird ID runs on the phone. Your microphone audio never leaves your pocket; only "House Crow, 0.71, 07:31" is sent. A closed audio API would mean streaming your walk to someone's server.
- **It works where the signal doesn't.** Mangroves and beaches have bad coverage. The model runs in the browser; detections queue in IndexedDB and sync later.
- **Swappable brains.** Every LLM call goes through one OpenAI-compatible client. I moved scripts from local Gemma 3 4B to Gemma 4 31B on AI Studio, and kept voice on local Gemma 3 1B for latency, by changing environment variables. When Gemma 4 turned out to "think" before answering (and that can't be switched off), I stripped it in one place.
- **Open data in, honest numbers out.** eBird checklists from thousands of birders, Open-Meteo forecasts and history, OpenStreetMap tiles, and an open tabular model I could actually evaluate — including publishing that it tied the baseline.
- **It costs nothing to run.** Free tiers, a laptop, and open weights. An always-on agent that checks five places every hour would be a real monthly bill on closed APIs.

## My Agent Session

Built with Claude Code as my coding agent: it wrote the PRD, split it into 20 tasks, ran sub-agents in parallel per package, and every task had to pass its tests before commit. Session: AGENT_SESSION_LINK

## Prize Categories

- **Best Use of Gemma** — Gemma 4 31B writes every invitation and note; Gemma 3 1B runs locally as the voice agent's brain; both behind validators.
- **Best Use of TabPFN** — hourly "good birding" forecast trained on 19.6k real eBird checklists, benchmarked against three baselines with the honest result above.
- **Best Use of ElevenLabs** — the Sitspot voice: an ElevenLabs agent whose LLM is my own open-model endpoint (Gemma), so the voice is grounded in the same facts and safety rules.
- **Best Use of Temporal** — durable invitation workflows with signals, re-checks and retries; 20/20 resumes after forced worker kills, zero duplicates.

*Credits: TabPFN by Prior Labs; BirdNET (Kahl et al., 2021, CC BY-NC-SA 4.0); eBird / Cornell Lab of Ornithology; Open-Meteo (CC BY 4.0); © OpenStreetMap contributors.*
