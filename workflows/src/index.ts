import { fileURLToPath } from "node:url";

export type * from "./activities-types";
export {
  arrivedSignal, dayStatusQuery, InvitationWorkflow, respondedSignal, statusQuery, TASK_QUEUE, UserDayWorkflow,
  visitEndedSignal,
} from "./workflows";

/** Absolute path of the workflow source, for Worker.create({ workflowsPath }) (bundled from TS by the SDK). */
export const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
