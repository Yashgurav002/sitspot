# Evaluation (T16)

Real numbers only, misses included. Synthetic data is labelled as such in every result file.

| Benchmark (spec §19) | Result file | Data | Rerun (from repo root) |
| --- | --- | --- | --- |
| 4 Retrieval: keyword vs vector vs hybrid | [retrieval_results.md](retrieval_results.md), per-question [retrieval/retrieval_raw.csv](retrieval/retrieval_raw.csv) | SYNTHETIC 60 notes / 40 questions | `pnpm --filter @sitspot/evaluation retrieval` (Ollama + `nomic-embed-text`, ~30 s) |
| Agent evals (40 chat turns + 10 scripts) | [agent_results.md](agent_results.md), raw `agent/*.jsonl`, labels `agent/manual_review.json` | SYNTHETIC cases (`agent/cases.ts`) | `pnpm --filter @sitspot/evaluation agent:chat` (Ollama gemma3:1b, ~1 min), `... agent:script` (AI Studio gemma-4-31b-it from `.env`, ~15 min), then `... agent:report` |
| 5 Voice latency (LLM part): gemma3:1b vs 4b | in [agent_results.md](agent_results.md), raw `agent/latency_raw.csv` | first 20 chat cases | `pnpm --filter @sitspot/evaluation latency` (~2 min), then `... agent:report` |
| 7 Durability: 20 forced worker kills | [durability_results.md](durability_results.md), raw `durability/*.csv` | mocked activities, Temporal time-skipping server | `pnpm --filter @sitspot/evaluation durability` (~1.5 min); in-flight probe `... durability:inflight` (~4 min) |
| 2 TabPFN forecast | `tabpfn_results.md` (not here yet) | real eBird checklists | comes from `ml/tabpfn` once the eBird export finishes |
| 3 On-phone bird ID, 9 Battery | not measured | — | need a real phone (BirdNET in the browser, 30 labelled clips; battery per 30-min pocket visit) |

Notes

- After re-running `agent chat` or `agent script`, re-read the outputs and update `agent/manual_review.json` before `agent:report`:
  the manual columns are only as good as that file.
- Run one heavy eval at a time; latency numbers are only meaningful on an otherwise idle machine.
- Hardware for the latency numbers is in `agent_results.md` (the laptop GPU was used, so they are not CPU-only numbers).
