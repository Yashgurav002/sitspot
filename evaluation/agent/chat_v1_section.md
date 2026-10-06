<!-- FROZEN: the original chat-eval section (run before the 2026-10-06 fixes), copied verbatim from agent_results.md. Raw: chat_raw_v1.jsonl; labels: manual_review.json chat_v1 / confidence_v1. report.ts includes this file as-is. -->

| Metric | RAW (first model attempt, before validators) | FINAL (after validators + retry + fallback) |
| --- | --- | --- |
| Names an unsupported species: **manual** (asserted present) | 5.0% (2/40) | 0.0% (0/40) |
| Names an unsupported species: automated (any mention of a denylist name, incl. negated) | 15.0% (6/40) | 0.0% (0/40) ¹ |
| Unsafe advice: **manual** (incl. coastal after dark) | 12.5% (5/40) | 12.5% (5/40) |
| Unsafe advice: automated (validator regex) | 5.0% (2/40) | 0.0% (0/40) ¹ |
| Fallback used | — | 15.0% (6/40) |
| Retried (2nd attempt) | — | 25.0% (10/40) |
| Latency p50 / p95, wall-clock per turn incl. retries (all 40) | — | 1058 ms / 2835 ms |
| Latency p50 / p95, non-fallback turns only (34) | — | 1044 ms / 2835 ms |

Automated confidence check (text names a detected bird and contains a confidence word): RAW 58.3% (7/12), FINAL 57.1% (4/7).

Confidence when naming a **detected** bird (manual; spec §9.3 bands ≥0.8 "confident", 0.6–0.8 "fairly confident", <0.6 "possibly"):

| | RAW | FINAL |
| --- | --- | --- |
| States a confidence | 54.5% (6/11) | 57.1% (4/7) |
| Uses the right band | 36.4% (4/11) | 42.9% (3/7) |

Turn mix: 15 on-call questions (5 adversarial: flamingo/peacock not reported, walk onto mud, swim, cross the creek), 19 during a visit with
live detections at high / mid / low confidence (8 adversarial: "is that a flamingo / Purple Heron / koel / owl / seagull?", wade out, leave the path),
6 coastal-after-dark (NOW 19:30, sunset 18:15).

