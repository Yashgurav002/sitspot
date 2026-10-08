// Benchmark 7: 20 forced worker kills across the InvitationWorkflow lifecycle (time-skipping test server,
// mocked activities). The worker runs in a child process and is hard-killed (child.kill() = TerminateProcess
// on Windows, SIGTERM-without-handler elsewhere), never shut down gracefully.
//   pnpm --filter @sitspot/evaluation durability
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arrivedSignal, InvitationWorkflow, respondedSignal, statusQuery, visitEndedSignal, workflowsPath } from '@sitspot/workflows';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';

// `tsx durability/run.ts inflight`: supplementary probe, kills right after the status flips to "arrived",
// i.e. while the setStatus("arrived") activity may still be in flight. Writes durability_inflight_raw.csv only.
const INFLIGHT = process.argv[2] === 'inflight';
const ALL_POINTS = ['send', 'responded', 'arrived', 'visitEnded'] as const;
type Point = (typeof ALL_POINTS)[number];
const POINTS: readonly Point[] = INFLIGHT ? ['visitEnded'] : ALL_POINTS;
const PER_POINT = INFLIGHT ? 2 : 5;
const TRIAL_MS = INFLIGHT ? 300_000 : 90_000;

const tmp = mkdtempSync(join(tmpdir(), 'sitspot-durability-'));
const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } as never;
const env = await TestWorkflowEnvironment.createTimeSkipping();
const bundle = await bundleWorkflowCode({ workflowsPath, logger: silent });
const BUNDLE = join(tmp, 'bundle.js');
writeFileSync(BUNDLE, bundle.code);
const workerJs = fileURLToPath(new URL('./worker.mjs', import.meta.url));

function startWorker(taskQueue: string, callsFile: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [workerJs], {
    env: { ...process.env, ADDRESS: env.address, TASK_QUEUE: taskQueue, BUNDLE, CALLS_FILE: callsFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((ok, fail) => {
    child.stdout!.on('data', (d: Buffer) => d.toString().includes('READY') && ok(child));
    child.on('exit', (c) => fail(new Error(`worker exited early (${c})`)));
  });
}

async function kill(child: ChildProcess) {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await gone;
}

type H = Awaited<ReturnType<typeof env.client.workflow.start<typeof InvitationWorkflow>>>;
async function until(h: H, want: string, ms = 30_000) {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    try {
      last = await h.query(statusQuery);
      if (last === want) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`status stuck at "${last}", wanted "${want}"`);
}

/** Block until the workflow is idle at a wait: exactly nActs activities scheduled and completed, no workflow task outstanding. */
async function settled(h: H, nActs: number, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ev = (await h.fetchHistory()).events ?? [];
    const n = (k: keyof (typeof ev)[number]) => ev.filter((e) => e[k]).length;
    const acts = n('activityTaskScheduledEventAttributes');
    if (acts === nActs && n('activityTaskCompletedEventAttributes') === acts &&
      n('workflowTaskScheduledEventAttributes') === n('workflowTaskCompletedEventAttributes')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflow never settled with ${nActs} completed activities`);
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`trial timed out after ${ms} ms`)), ms))]);

let n = 0;
async function trial(point: Point, signalWhileDown: boolean) {
  const id = ++n;
  const TQ = `dur-${id}`;
  const calls = join(tmp, `calls-${id}.txt`);
  writeFileSync(calls, '');
  let w = await startWorker(TQ, calls);
  const t0 = performance.now();
  const now = await env.currentTimeMs();
  const h = await env.client.workflow.start(InvitationWorkflow, {
    taskQueue: TQ,
    workflowId: `dur-${id}`,
    args: [{ invitationId: 'inv-1', sendAt: new Date(now + 30 * 60_000).toISOString(), windowEnd: new Date(now + 180 * 60_000).toISOString() }],
  });

  // Each step: [state we wait in, activities completed by then, action that moves past it].
  const steps: [Point, string, number, () => Promise<unknown>][] = [
    ['send', 'pending', 0, () => env.sleep(31 * 60_000)],
    ['responded', 'sent', 3, () => h.signal(respondedSignal, { accepted: true })],
    ['arrived', 'accepted', 4, () => h.signal(arrivedSignal, { visitId: 'v1' })],
    ['visitEnded', 'arrived', 5, () => h.signal(visitEndedSignal, { rating: 5 })],
  ];
  let result = 'unknown';
  let error = '';
  try {
    await withTimeout(
      (async () => {
        for (const [p, waitStatus, nActs, act] of steps) {
          await until(h, waitStatus);
          if (p !== point) {
            await act();
            continue;
          }
          // The status query flips before the setStatus activity runs; kill only once the workflow is truly blocked.
          if (!INFLIGHT) await settled(h, nActs);
          await kill(w);
          // Timers can't fire with no worker anyway; a signal sent now must be picked up by the new worker.
          if (signalWhileDown && p !== 'send') await act();
          w = await startWorker(TQ, calls);
          if (!(signalWhileDown && p !== 'send')) {
            await until(h, waitStatus); // replayed by the new worker
            await act();
          }
        }
        result = await h.result();
      })(),
      TRIAL_MS,
    );
  } catch (e) {
    error = (e as Error).message;
    await h.terminate().catch(() => {});
  }
  await kill(w);
  const lines = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
  const count = (a: string) => lines.filter((l) => l === a).length;
  const statuses = lines.filter((l) => l.startsWith('setStatus')).map((l) => l.split(' ')[1]);
  const c = { recheckWindow: count('recheckWindow'), composeScript: count('composeScript'), deliver: count('deliver'), compileVisit: count('compileVisit') };
  const correct =
    result === 'completed' && c.recheckWindow === 1 && c.composeScript === 1 && c.deliver === 1 && c.compileVisit === 1 &&
    statuses.join(',') === 'accepted,arrived,completed';
  return { id, point, signalWhileDown: signalWhileDown && point !== 'send', result, ...c, statuses: statuses.join(' '), correct, error, ms: Math.round(performance.now() - t0) };
}

const results: Awaited<ReturnType<typeof trial>>[] = [];
for (const point of POINTS)
  for (let i = 0; i < PER_POINT; i++) {
    const r = await trial(point, i % 2 === 1);
    results.push(r);
    console.log(JSON.stringify(r));
  }
await env.teardown();

const ok = results.filter((r) => r.correct).length;
const dup = results.reduce((a, r) => a + Math.max(0, r.deliver - 1), 0);
const csv = ['id,kill_point,signal_sent_while_worker_down,result,recheckWindow,composeScript,deliver,compileVisit,statuses,correct,error,ms', ...results.map((r) => [r.id, r.point, r.signalWhileDown, r.result, r.recheckWindow, r.composeScript, r.deliver, r.compileVisit, r.statuses, r.correct, JSON.stringify(r.error), r.ms].join(','))];
if (INFLIGHT) {
  writeFileSync(new URL('./durability_inflight_raw.csv', import.meta.url), csv.join('\n') + '\n');
  console.log(`inflight probe: correct ${ok}/${results.length}, duplicate deliveries ${dup}`);
  process.exit(0);
}
writeFileSync(new URL('./durability_raw.csv', import.meta.url), csv.join('\n') + '\n');

const byPoint = POINTS.map((p) => {
  const rs = results.filter((r) => r.point === p);
  return `| waiting ${p} | ${rs.length} | ${rs.filter((r) => r.correct).length} | ${rs.reduce((a, r) => a + Math.max(0, r.deliver - 1), 0)} | ${rs.filter((r) => r.signalWhileDown).length} |`;
});
function inflightSection() {
  const f = new URL('./durability_inflight_raw.csv', import.meta.url);
  if (!existsSync(f)) return '_Not run._';
  const rows = readFileSync(f, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const okN = rows.filter((r) => r[9] === 'true').length;
  const secs = rows.map((r) => Math.round(Number(r.at(-1)) / 1000));
  return `${okN}/${rows.length} correct, ${rows.reduce((a, r) => a + Math.max(0, Number(r[6]) - 1), 0)} duplicate deliveries, but each trial took ${secs.join(' s and ')} s wall-clock:
the activity task had been handed to the killed worker, and the server only re-dispatches it after the activity's \`startToCloseTimeout\`
(2 minutes in \`workflows.ts\`; the time-skipping server does not skip time while an activity is outstanding, so this is real time).
In production the same stall applies: a worker killed mid-activity delays that invitation by up to 2 minutes (no heartbeats are configured).
Raw rows: \`durability/durability_inflight_raw.csv\`.`;
}

const md = `# Durability results (benchmark 7)

**Correct resumes: ${ok}/${results.length}. Duplicate deliveries: ${dup}.** (target 20/20, 0 duplicates)

Run ${new Date().toISOString().slice(0, 10)} with \`evaluation/durability/run.ts\`.

| Kill point (workflow waiting on) | Kills | Correct resumes | Duplicate deliveries | Of which next signal sent while no worker was running |
| --- | --- | --- | --- | --- |
${byPoint.join('\n')}

## Method

- Temporal **time-skipping test server** (\`TestWorkflowEnvironment.createTimeSkipping()\`), the real \`InvitationWorkflow\` bundle from \`workflows/src/workflows.ts\`.
- The worker runs in a **separate Node process** (\`durability/worker.mjs\`, \`maxCachedWorkflows: 0\`) with **mocked activities** that append each call to a file,
  so calls survive the kill. Each kill is \`child.kill('SIGKILL')\` (TerminateProcess on Windows): no graceful shutdown, no drain.
- Each trial runs one invitation through its whole lifecycle (send timer 30 min → recheck/compose/deliver → responded → arrived → visitEnded → compileVisit)
  and kills the worker exactly once, while the workflow is blocked at one of four points; a fresh worker process is then started.
  In 2 of 5 trials per signal point, the next signal is sent while no worker is running.
- A resume is **correct** if the workflow returns \`completed\`, \`recheckWindow\`, \`composeScript\`, \`deliver\` and \`compileVisit\` each ran exactly once,
  and \`setStatus\` saw exactly \`accepted, arrived, completed\`. A duplicate delivery is any \`deliver\` call beyond the first.
- Raw per-trial rows: \`durability/durability_raw.csv\`.

## Supplementary: kill with an activity in flight (\`tsx durability/run.ts inflight\`)

${inflightSection()}

Harness history, for honesty: the first version of this harness killed the worker as soon as the \`status\` query flipped,
which happens *before* the \`setStatus\` activity runs. At the visitEnded point that meant killing with an activity in flight; all 5 of those
trials hit the harness's 90 s timeout (15/20 overall; rows kept in \`durability/first_run_raw.csv\`). The harness was then changed to wait until the workflow is idle before killing (the
20 kills above), and the in-flight case was measured separately with a 300 s timeout (this section).

## Caveats

- The 20 headline kills happen while the workflow is **waiting** (timer / signal); only the 2-trial probe above kills mid-activity. A kill mid-activity makes Temporal retry that
  activity (at-least-once); duplicate-call safety there rests on the real \`deliver\` activity's own idempotency ("never re-delivers a row past
  'pending'"), which this eval does not exercise because activities are mocked.
- Test server, not Temporal Cloud; no network partitions; one workflow at a time.
`;
writeFileSync(new URL('../durability_results.md', import.meta.url), md);
console.log(`correct ${ok}/${results.length}, duplicate deliveries ${dup}`);
process.exit(0);
