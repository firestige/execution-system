import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createPluginRuntime, parseWsrCommand } from "../../packages/dsh-intake/src/index.js";

const root = path.resolve(process.argv[2]);
const worktree = path.join(root, "worktree");
const bindingFile = path.join(root, "bindings.json");
const closeFile = path.join(root, "close.json");
await mkdir(worktree, { recursive: true });

class WorkflowIntakeService {
  constructor({ application }) { this.application = application; }
  invoke(request) { return this.application.execute(request); }
}

let closeCalls = 0;
let cancelCalls = 0;
const execution = new Promise(() => undefined);
const application = Object.freeze({
  async start() {}, async execute() { return execution; }, async inspect() { throw new Error("not used"); },
  async cancel() { cancelCalls += 1; throw new Error("shutdown must not cancel"); },
  status() { return { state: "READY" }; }, async close() { closeCalls += 1; },
});
const control = Object.freeze({
  async list() { return []; }, attach() {},
  async waitForDelivery() { return { deliveryId: "delivery-signal", worktree }; },
  async recover() { throw new Error("not used"); }, async status() { throw new Error("not used"); },
  async finishAction() { throw new Error("not used"); }, async answerAction() { throw new Error("not used"); },
});
const runtime = await createPluginRuntime({ configFile: path.join(root, "execution.json"), bindingFile }, {
  moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult: JSON.stringify }),
  factory: Object.freeze({ async create() { return application; } }),
  control,
  quiesceTimeoutMs: 5,
});
await runtime.invokeForSession({
  sessionKey: "session-signal", worktree,
  operation: parseWsrCommand("create fixture@1.0.0\nwait"),
  turnText: "/wsr create fixture@1.0.0\nwait", images: [],
});

const keepAlive = setInterval(() => undefined, 1_000);
let closing = false;
async function closeFromHost(signal) {
  if (closing) return;
  closing = true;
  await runtime.close();
  clearInterval(keepAlive);
  await writeFile(closeFile, `${JSON.stringify({ signal, closeCalls, cancelCalls })}\n`, "utf8");
  process.exit(0);
}
process.once("SIGTERM", () => { void closeFromHost("SIGTERM"); });
process.once("SIGINT", () => { void closeFromHost("SIGINT"); });
process.stdout.write("READY\n");
