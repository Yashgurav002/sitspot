// In-process Temporal worker + client (spec §10, §17.3). Returns null when Temporal is unreachable,
// so the API keeps working without it. Also runnable standalone: `pnpm worker` (see bottom).
import { createDeliver } from "./delivery";
import { pathToFileURL } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createDb, migrate, type Db } from "@sitspot/db";
import {
  arrivedSignal, InvitationWorkflow, respondedSignal, TASK_QUEUE, UserDayWorkflow, visitEndedSignal, workflowsPath,
} from "@sitspot/workflows";
import { createActivities, type ActivityDeps, type Deliver } from "./activities";
import { DEMO_EMAIL, type Signals } from "./app";
import { activityInterceptor, sentryEnabled } from "./observability";

export type TemporalHandle = {
  /** Plug into createApp({ signals }). */
  signals: Required<Signals>;
  /** Start an InvitationWorkflow now (TEST invitations); returns its workflow id. */
  startTestInvitation(invitationId: string, windowEnd: Date): Promise<string>;
  /** For /health: "up" if the frontend answers. */
  health(): Promise<"up" | "down">;
  close(): Promise<void>;
};

export type TemporalDeps = Omit<ActivityDeps, "deliver"> & { deliver: Deliver };

function connectionOptions(env: Record<string, string | undefined>) {
  const apiKey = env.TEMPORAL_API_KEY || undefined;
  return {
    address: env.TEMPORAL_ADDRESS || "localhost:7233",
    // Temporal Cloud: API key auth requires TLS.
    ...(apiKey && { tls: true, apiKey }),
  };
}

export async function startTemporal(deps: TemporalDeps): Promise<TemporalHandle | null> {
  const { db, env } = deps;
  const namespace = env.TEMPORAL_NAMESPACE || "default";
  const opts = connectionOptions(env);
  let connection: Connection, native: NativeConnection;
  try {
    connection = await Connection.connect({ ...opts, connectTimeout: "5s" });
    native = await NativeConnection.connect(opts);
  } catch (e) {
    console.warn(`[temporal] not reachable at ${opts.address} (${(e as Error).message}); running without workflows`);
    return null;
  }
  const client = new Client({ connection, namespace });

  const worker = await Worker.create({
    connection: native,
    namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities(deps),
    ...(sentryEnabled() && { interceptors: { activity: [activityInterceptor] } }),
  });
  const running = worker.run().catch((e) => console.error("[temporal] worker stopped:", e));

  // One UserDayWorkflow per real user (not demo). Idempotent: an already-running one is left alone.
  // ponytail: started at boot only; start one on sign-up if users ever get created at runtime.
  const users = await db.query<{ id: string }>(`select id from users where email <> $1`, [DEMO_EMAIL]);
  for (const u of users) {
    try {
      await client.workflow.start(UserDayWorkflow, { taskQueue: TASK_QUEUE, workflowId: `day-${u.id}`, args: [u.id] });
    } catch (e) {
      if ((e as Error).name !== "WorkflowExecutionAlreadyStartedError") console.error(`[temporal] day-${u.id}:`, e);
    }
  }
  console.log(`[temporal] worker on ${opts.address}/${namespace}, queue '${TASK_QUEUE}', ${users.length} day workflow(s)`);

  /** Signal the invitation's workflow, found via invitations.workflow_id. */
  const signalInv = async (invitationId: string, send: (h: ReturnType<typeof client.workflow.getHandle>) => Promise<void>) => {
    const rows = await db.query<{ workflow_id: string | null }>(`select workflow_id from invitations where id = $1`, [invitationId]);
    const wf = rows[0]?.workflow_id;
    if (!wf) return; // created outside Temporal (e.g. tests/manual) — nothing to signal
    await send(client.workflow.getHandle(wf));
  };

  return {
    async startTestInvitation(invitationId, windowEnd) {
      const workflowId = `test-${invitationId}`;
      // recheckWindow reads workflow_id to recognise a TEST, so it must be on the row before the workflow runs.
      await db.query(`update invitations set workflow_id = $2 where id = $1`, [invitationId, workflowId]);
      await client.workflow.start(InvitationWorkflow, {
        taskQueue: TASK_QUEUE, workflowId,
        args: [{ invitationId, sendAt: new Date().toISOString(), windowEnd: windowEnd.toISOString() }],
      });
      return workflowId;
    },
    signals: {
      responded: (inv, accepted) => signalInv(inv, (h) => h.signal(respondedSignal, { accepted })),
      arrived: (inv, visitId) => signalInv(inv, (h) => h.signal(arrivedSignal, { visitId })),
      visitEnded: (inv, _visitId, rating) => signalInv(inv, (h) => h.signal(visitEndedSignal, { rating })),
    },
    async health() {
      try {
        await connection.workflowService.getSystemInfo({});
        return "up";
      } catch {
        return "down";
      }
    },
    async close() {
      worker.shutdown();
      await running;
      await native.close();
      await connection.close();
    },
  };
}

// ---------- standalone worker: `pnpm worker` ----------
// Needs a DB the API can share (DATABASE_URL); PGlite is single-process, so with PGlite run the
// worker inside the API instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    /* no .env */
  }
  const db: Db = await createDb();
  await migrate(db);
  const t = await startTemporal({
    db,
    env: process.env,
    deliver: createDeliver({ db, env: process.env }),
  });
  if (!t) process.exit(1);
  const stop = async () => {
    await t.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
