# Durability results (benchmark 7)

**Correct resumes: 20/20. Duplicate deliveries: 0.** (target 20/20, 0 duplicates)

Run 2026-10-06 with `evaluation/durability/run.ts`.

| Kill point (workflow waiting on) | Kills | Correct resumes | Duplicate deliveries | Of which next signal sent while no worker was running |
| --- | --- | --- | --- | --- |
| waiting send | 5 | 5 | 0 | 0 |
| waiting responded | 5 | 5 | 0 | 2 |
| waiting arrived | 5 | 5 | 0 | 2 |
| waiting visitEnded | 5 | 5 | 0 | 2 |

## Method

- Temporal **time-skipping test server** (`TestWorkflowEnvironment.createTimeSkipping()`), the real `InvitationWorkflow` bundle from `workflows/src/workflows.ts`.
- The worker runs in a **separate Node process** (`durability/worker.mjs`, `maxCachedWorkflows: 0`) with **mocked activities** that append each call to a file,
  so calls survive the kill. Each kill is `child.kill('SIGKILL')` (TerminateProcess on Windows): no graceful shutdown, no drain.
- Each trial runs one invitation through its whole lifecycle (send timer 30 min → recheck/compose/deliver → responded → arrived → visitEnded → compileVisit)
  and kills the worker exactly once, while the workflow is blocked at one of four points; a fresh worker process is then started.
  In 2 of 5 trials per signal point, the next signal is sent while no worker is running.
- A resume is **correct** if the workflow returns `completed`, `recheckWindow`, `composeScript`, `deliver` and `compileVisit` each ran exactly once,
  and `setStatus` saw exactly `accepted, arrived, completed`. A duplicate delivery is any `deliver` call beyond the first.
- Raw per-trial rows: `durability/durability_raw.csv`.

## Supplementary: kill with an activity in flight (`tsx durability/run.ts inflight`)

2/2 correct, 0 duplicate deliveries, but each trial took 120 s and 120 s wall-clock:
the activity task had been handed to the killed worker, and the server only re-dispatches it after the activity's `startToCloseTimeout`
(2 minutes in `workflows.ts`; the time-skipping server does not skip time while an activity is outstanding, so this is real time).
In production the same stall applies: a worker killed mid-activity delays that invitation by up to 2 minutes (no heartbeats are configured).
Raw rows: `durability/durability_inflight_raw.csv`.

Harness history, for honesty: the first version of this harness killed the worker as soon as the `status` query flipped,
which happens *before* the `setStatus` activity runs. At the visitEnded point that meant killing with an activity in flight; all 5 of those
trials hit the harness's 90 s timeout (15/20 overall; rows kept in `durability/first_run_raw.csv`). The harness was then changed to wait until the workflow is idle before killing (the
20 kills above), and the in-flight case was measured separately with a 300 s timeout (this section).

## Caveats

- The 20 headline kills happen while the workflow is **waiting** (timer / signal); only the 2-trial probe above kills mid-activity. A kill mid-activity makes Temporal retry that
  activity (at-least-once); duplicate-call safety there rests on the real `deliver` activity's own idempotency ("never re-delivers a row past
  'pending'"), which this eval does not exercise because activities are mocked.
- Test server, not Temporal Cloud; no network partitions; one workflow at a time.
