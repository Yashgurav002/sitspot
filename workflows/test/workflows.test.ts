import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Activities, InvitationStatus, PickDTO } from "../src/activities-types";
import {
  arrivedSignal, dayStatusQuery, InvitationWorkflow, respondedSignal, statusQuery, UserDayWorkflow, visitEndedSignal,
} from "../src/workflows";
import { workflowsPath } from "../src/index";

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let n = 0;
let TQ = "test";

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ workflowsPath, logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } as never });
}, 300_000);
afterAll(async () => {
  await env?.teardown();
});

function mocks(over: Partial<Activities> = {}) {
  TQ = `test-${++n}`;
  const calls: Record<string, number> = {};
  const statuses: InvitationStatus[] = [];
  const count = <F extends (...a: never[]) => unknown>(name: string, f: F) =>
    ((...a: Parameters<F>) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return f(...a);
    }) as F;
  const base: Activities = {
    evaluateWindows: async () => null,
    createInvitation: async () => ({ invitationId: "inv-1", created: true }),
    reflect: async () => {},
    recheckWindow: async () => ({ ok: true, reason: "still good" }),
    composeScript: async () => ({ script: "Go?", fallback: false }),
    deliver: async () => ({ channel: "push" }),
    setStatus: async (_id, s) => void statuses.push(s),
    compileVisit: async () => ({ noteId: "note-1" }),
    ...over,
  };
  const acts = Object.fromEntries(Object.entries(base).map(([k, f]) => [k, count(k, f as never)])) as unknown as Activities;
  return { acts, calls, statuses };
}

// No sticky cache: every task replays from history (and a dead worker's sticky queue can't strand tasks in the test server).
const worker = (acts: Activities) =>
  Worker.create({ connection: env.nativeConnection, taskQueue: TQ, workflowBundle: bundle, activities: acts, maxCachedWorkflows: 0 });

/** Invitation args relative to the (skipped) server clock. */
async function startInvitation(windowMin = 60) {
  const now = await env.currentTimeMs(); // server clock runs ahead of Date.now() once earlier tests skipped time
  return env.client.workflow.start(InvitationWorkflow, {
    taskQueue: TQ,
    workflowId: `inv-test-${++n}`,
    args: [{ invitationId: "inv-1", sendAt: new Date(now).toISOString(), windowEnd: new Date(now + windowMin * 60_000).toISOString() }],
  });
}

/** Poll a query until it returns `want` (queries don't skip time). */
async function until(h: { query: (q: typeof statusQuery) => Promise<InvitationStatus> }, want: InvitationStatus) {
  for (let i = 0; i < 200; i++) {
    if ((await h.query(statusQuery)) === want) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`status never reached ${want}`);
}

describe("InvitationWorkflow", () => {
  it("accept → arrive → end → completed", async () => {
    const m = mocks();
    const w = await worker(m.acts);
    const status = await w.runUntil(async () => {
      const h = await startInvitation();
      await until(h, "sent");
      await h.signal(respondedSignal, { accepted: true });
      await h.signal(arrivedSignal, { visitId: "v1" });
      await h.signal(visitEndedSignal, { rating: 5 });
      return h.result();
    });
    expect(status).toBe("completed");
    expect(m.statuses.slice(-2)).toEqual(["arrived", "completed"]);
    expect(m.calls.deliver).toBe(1);
    expect(m.calls.compileVisit).toBe(1);
  });

  it("decline → declined", async () => {
    const m = mocks();
    const status = await (await worker(m.acts)).runUntil(async () => {
      const h = await startInvitation();
      await until(h, "sent");
      await h.signal(respondedSignal, { accepted: false });
      return h.result();
    });
    expect(status).toBe("declined");
    expect(m.calls.compileVisit).toBeUndefined();
  });

  it("no answer within 15 min → no_answer", async () => {
    const m = mocks();
    const status = await (await worker(m.acts)).runUntil(async () => (await startInvitation()).result());
    expect(status).toBe("no_answer");
    expect(m.statuses).toEqual(["no_answer"]);
  });

  it("accepted but no arrival by window end → missed", async () => {
    const m = mocks();
    const status = await (await worker(m.acts)).runUntil(async () => {
      const h = await startInvitation();
      await until(h, "sent");
      await h.signal(respondedSignal, { accepted: true });
      return h.result();
    });
    expect(status).toBe("missed");
  });

  it("recheck fails → cancelled, nothing delivered", async () => {
    const m = mocks({ recheckWindow: async () => ({ ok: false, reason: "rain" }) });
    const status = await (await worker(m.acts)).runUntil(async () => (await startInvitation()).result());
    expect(status).toBe("cancelled");
    expect(m.calls.composeScript).toBeUndefined();
    expect(m.calls.deliver).toBeUndefined();
  });

  it("worker restart while waiting on arrived: resumes, deliver still called once", async () => {
    const m = mocks();
    const w1 = await worker(m.acts);
    const run1 = w1.run();
    const h = await startInvitation();
    await until(h, "sent");
    await h.signal(respondedSignal, { accepted: true });
    await until(h, "accepted");
    w1.shutdown();
    await run1;

    await h.signal(arrivedSignal, { visitId: "v1" }); // lands while no worker is running
    const w2 = await worker(m.acts);
    const status = await w2.runUntil(async () => {
      // Let w2 process the queued signal before anything unlocks time skipping.
      await until(h, "arrived");
      await h.signal(visitEndedSignal, { rating: 4 });
      return h.result();
    });
    expect(status).toBe("completed");
    expect(m.calls.deliver).toBe(1);
    expect(m.calls.composeScript).toBe(1);
  });
});

describe("UserDayWorkflow", () => {
  it("same pick on consecutive hours starts exactly one child", async () => {
    const now = await env.currentTimeMs();
    const pick: PickDTO = {
      spot_id: "s1",
      window_start: new Date(now + 20 * 3_600_000).toISOString(), // child sleeps past the test
      window_end: new Date(now + 21 * 3_600_000).toISOString(),
      send_at: new Date(now + 19 * 3_600_000).toISOString(),
      score: 0.9,
      factors: {},
      reason: "test",
    };
    const m = mocks({ evaluateWindows: async () => pick });
    const userId = `u${++n}`;
    const started = await (await worker(m.acts)).runUntil(async () => {
      const h = await env.client.workflow.start(UserDayWorkflow, { taskQueue: TQ, workflowId: `day-${userId}`, args: [userId] });
      await env.sleep(150 * 60_000);
      const s = await h.query(dayStatusQuery);
      await h.terminate();
      return s.started;
    });
    expect(m.calls.evaluateWindows).toBeGreaterThanOrEqual(2);
    expect(m.calls.createInvitation).toBe(m.calls.evaluateWindows);
    expect(started).toEqual([`inv-${userId}-${pick.window_start}`]);
    const child = await env.client.workflow.getHandle(started[0]!).describe();
    expect(child.status.name).toBe("RUNNING");
  });
});
