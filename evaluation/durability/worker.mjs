// Child-process worker for the durability eval. Mocked activities append their name to CALLS_FILE
// (shared with the parent across kills). The parent hard-kills this process (TerminateProcess / SIGKILL).
import { appendFileSync } from 'node:fs';
import { NativeConnection, Worker, Runtime } from '@temporalio/worker';

const { ADDRESS, TASK_QUEUE, BUNDLE, CALLS_FILE } = process.env;
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
const rec = (name, ...rest) => appendFileSync(CALLS_FILE, `${[name, ...rest].join(' ')}\n`);

const activities = {
  evaluateWindows: async () => null,
  createInvitation: async () => ({ invitationId: 'inv-1', created: true }),
  reflect: async () => {},
  recheckWindow: async () => (rec('recheckWindow'), { ok: true, reason: 'still good' }),
  composeScript: async () => (rec('composeScript'), { script: 'Go?', fallback: false }),
  deliver: async () => (rec('deliver'), { channel: 'push' }),
  setStatus: async (_id, s) => void rec('setStatus', s),
  compileVisit: async () => (rec('compileVisit'), { noteId: 'note-1' }),
};

const connection = await NativeConnection.connect({ address: ADDRESS });
const worker = await Worker.create({ connection, taskQueue: TASK_QUEUE, workflowBundle: { codePath: BUNDLE }, activities, maxCachedWorkflows: 0 });
process.stdout.write('READY\n');
await worker.run();
