// Temporal workflow code (spec §10). Deterministic: only @temporalio/workflow + type imports.
import {
  condition, continueAsNew, defineQuery, defineSignal, log, ParentClosePolicy, proxyActivities, setHandler, sleep,
  startChild, WorkflowIdReusePolicy,
} from "@temporalio/workflow";
import type { Activities, InvitationArgs, InvitationStatus } from "./activities-types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const IST_MS = 5.5 * HOUR;
export const TASK_QUEUE = "sitspot";

const retry = { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2, nonRetryableErrorTypes: ["ValidationError"] };
// DB/policy/delivery activities: fast. LLM activities: a Gemma call on AI Studio takes 60–110 s and the
// agent retries once on validation (LLM_TIMEOUT_MS=180000 each), so 2 min would kill and re-run them.
const acts = proxyActivities<Activities>({ startToCloseTimeout: "1 minute", retry });
const llmActs = proxyActivities<Pick<Activities, "composeScript" | "compileVisit">>({ startToCloseTimeout: "10 minutes", retry });

// ---------- signals / queries ----------
export const respondedSignal = defineSignal<[{ accepted: boolean }]>("responded");
export const arrivedSignal = defineSignal<[{ visitId: string }]>("arrived");
export const visitEndedSignal = defineSignal<[{ rating: number | null }]>("visitEnded");
export const statusQuery = defineQuery<InvitationStatus>("status");
export const dayStatusQuery = defineQuery<{ started: string[] }>("status");

/** Next instant after `t` that is IST hh:05 (after /cron/pull and the forecast job). */
export function nextTick(t: number): number {
  const local = t + IST_MS;
  let next = Math.floor(local / HOUR) * HOUR + 5 * MIN;
  if (next <= local) next += HOUR;
  return next - IST_MS;
}

/** Next IST midnight strictly after `t`. */
export function nextIstMidnight(t: number): number {
  return (Math.floor((t + IST_MS) / (24 * HOUR)) + 1) * 24 * HOUR - IST_MS;
}

const isAlreadyStarted = (e: unknown) => e instanceof Error && e.name === "WorkflowExecutionAlreadyStartedError";

// ---------- UserDayWorkflow ----------
export async function UserDayWorkflow(userId: string): Promise<void> {
  const started: string[] = [];
  setHandler(dayStatusQuery, () => ({ started }));
  const midnight = nextIstMidnight(Date.now());

  for (let t = nextTick(Date.now()); t < midnight; t = nextTick(Date.now())) {
    await sleep(t - Date.now());
    const pick = await acts.evaluateWindows(userId);
    if (!pick) continue;
    const workflowId = `inv-${userId}-${pick.window_start}`;
    const { invitationId } = await acts.createInvitation(userId, pick, workflowId);
    try {
      await startChild(InvitationWorkflow, {
        workflowId,
        args: [{ invitationId, sendAt: pick.send_at, windowEnd: pick.window_end }],
        parentClosePolicy: ParentClosePolicy.ABANDON,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
      started.push(workflowId);
    } catch (e) {
      if (!isAlreadyStarted(e)) throw e;
      log.info("invitation workflow already exists", { workflowId });
    }
  }
  await sleep(Math.max(0, midnight - Date.now()));
  await acts.reflect(userId);
  await continueAsNew<typeof UserDayWorkflow>(userId);
}

// ---------- InvitationWorkflow ----------
export async function InvitationWorkflow({ invitationId, sendAt, windowEnd }: InvitationArgs): Promise<InvitationStatus> {
  let status: InvitationStatus = "pending";
  let accepted: boolean | undefined;
  let visitId: string | undefined;
  let ended = false;
  setHandler(statusQuery, () => status);
  setHandler(respondedSignal, (a) => void (accepted = a.accepted));
  setHandler(arrivedSignal, (a) => void (visitId = a.visitId));
  setHandler(visitEndedSignal, () => void (ended = true));

  const finish = async (s: InvitationStatus) => {
    status = s;
    await acts.setStatus(invitationId, s);
    return s;
  };

  const wait = Date.parse(sendAt) - Date.now();
  if (wait > 0) await sleep(wait);

  if (!(await acts.recheckWindow(invitationId)).ok) return finish("cancelled");
  await llmActs.composeScript(invitationId);
  await acts.deliver(invitationId);
  status = "sent";

  // Tapping "I'm here" without answering counts as a yes.
  if (!(await condition(() => accepted !== undefined || visitId !== undefined, "15 minutes"))) return finish("no_answer");
  if (accepted === false && visitId === undefined) return finish("declined");
  if (visitId === undefined) {
    await finish("accepted");
    const left = Date.parse(windowEnd) - Date.now();
    if (left <= 0 || !(await condition(() => visitId !== undefined, left))) return finish("missed");
  }
  await finish("arrived");
  await condition(() => ended, "90 minutes");
  await llmActs.compileVisit(invitationId);
  return finish("completed");
}
