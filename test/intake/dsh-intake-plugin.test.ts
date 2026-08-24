import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  IntakeSessionBindingRepository,
  createPluginRuntime,
  mapIntakeToolOperation,
  parseWsrCommand,
  presentToDshSession,
} from "../../packages/dsh-intake/src/index.js";
import { WorkflowIntakeService, renderIntakeResult } from "../../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Wave 6 DSH Intake plugin", () => {
  it("rejects invalid profile config before binding, bootstrap, or startup activation effects", async () => {
    let factoryCalls = 0;
    const options = {
      moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult }),
      factory: Object.freeze({ async create() { factoryCalls += 1; throw new Error("must not run"); } }),
    } as any;
    for (const config of [
      null, {}, { configFile: "relative", bindingFile: "/tmp/bindings.json" },
      { configFile: "/tmp/execution.json", bindingFile: "relative" },
      { configFile: "/tmp/execution.json", bindingFile: "/tmp/bindings.json", credential: "secret" },
    ]) await expect(createPluginRuntime(config as never, options)).rejects.toThrow("DSH_INTAKE_CONFIG_INVALID");
    expect(factoryCalls).toBe(0);
  });

  it("publishes the exact DSH bundle, public dependency, and first-party skill without Package content", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../packages/dsh-intake");
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as any;
    const patch = await readFile(path.join(packageRoot, "cordis.patch.yml"), "utf8");
    const skill = await readFile(path.join(packageRoot, "skills/workflow-execution/SKILL.md"), "utf8");
    const source = await readFile(path.join(packageRoot, "src/plugin.js"), "utf8");

    expect(manifest).toMatchObject({
      name: "@workflow-self-recursive/dsh-intake",
      version: "0.1.1",
      dsh: { bundle: { patch: "./cordis.patch.yml" }, compatibility: {
        executionSystem: "0.1.1", dsh: "0.1.1-rc.2", commands: "0.1.1-rc.2",
        agents: "0.1.1-rc.2", skillFilesystem: "0.1.1-rc.2", toolSkill: "0.1.1-rc.2", tools: "0.1.1-rc.2",
      } },
    });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(patch).toContain("id: workflow-execution");
    expect(patch).toContain("name: '@workflow-self-recursive/dsh-intake'");
    expect(patch).toContain("id: skill-filesystem");
    expect(patch).toContain("customSkillDirs");
    expect(patch).toMatch(/id: skill-filesystem[\s\S]*?disabled: false/u);
    expect(patch).toMatch(/id: tool-skill\s+disabled: false/u);
    expect(skill).toContain("workflow_execution_intake");
    expect(skill).toContain("exactly once");
    expect(skill).toContain("/wsr action finish");
    expect(source).toContain('import("@workflow-self-recursive/execution-system")');
    expect(source).not.toMatch(/(?:src\/(?:delivery|observation|providers|host|coordinator|invocation)|RunnerFactory|DSH-E|ctx\.sessions)/u);
    expect(JSON.stringify(manifest) + patch + skill + source).not.toContain("implementation-workflow@0.3.0");
    expect(JSON.stringify(manifest) + patch + skill + source).not.toContain("system-design-workflow@0.3.0");
  });

  it("persists one-to-one session/Delivery bindings while different worktrees remain parallel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-bindings-"));
    roots.push(root);
    const repository = new IntakeSessionBindingRepository(path.join(root, "bindings.json"));
    await repository.start();
    const first = await repository.claim(Object.freeze({ sessionKey: "native-session-a", correlation: "intake-1", deliveryId: "delivery-a", worktree: "/worktree/a" }));
    const second = await repository.claim(Object.freeze({ sessionKey: "native-session-b", correlation: "intake-2", deliveryId: "delivery-b", worktree: "/worktree/b" }));
    expect(await repository.list()).toEqual([first, second]);
    await expect(repository.claim(Object.freeze({ sessionKey: "native-session-c", correlation: "intake-3", deliveryId: "delivery-a", worktree: "/worktree/a" })))
      .rejects.toMatchObject({ code: "DELIVERY_INTAKE_BOUND" });
    await expect(repository.claim(Object.freeze({ sessionKey: "native-session-a", correlation: "intake-1", deliveryId: "delivery-c", worktree: "/worktree/c" })))
      .rejects.toMatchObject({ code: "INTAKE_BINDING_INVARIANT_VIOLATION" });

    const restarted = new IntakeSessionBindingRepository(path.join(root, "bindings.json"));
    await restarted.start();
    expect(await restarted.bySession("native-session-a")).toEqual(first);
    expect(await restarted.byDelivery("delivery-b")).toEqual(second);
    await restarted.markDetached("delivery-a");
    expect(await restarted.byDelivery("delivery-a")).toMatchObject({ state: "DETACHED" });
    const reclaimed = await restarted.claim(Object.freeze({ sessionKey: "native-session-c", correlation: "intake-3", deliveryId: "delivery-a", worktree: "/worktree/a" }));
    expect(reclaimed).toMatchObject({ sessionKey: "native-session-c", correlation: "intake-3", state: "BOUND" });
    expect(await restarted.bySession("native-session-a")).toBeUndefined();
    expect(JSON.stringify(await restarted.list())).not.toContain("credential");
  });

  it("detaches an unavailable restored host session and refuses a live Delivery second claim before Core", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-recovery-"));
    roots.push(root);
    const worktree = path.join(root, "worktree");
    await (await import("node:fs/promises")).mkdir(worktree);
    const file = path.join(root, "bindings.json");
    const repository = new IntakeSessionBindingRepository(file);
    await repository.start();
    await repository.claim(Object.freeze({ sessionKey: "stale-session", correlation: "stale-correlation", deliveryId: "delivery-1", worktree }));
    let recoverCalls = 0;
    const control = Object.freeze({
      async list() { return [{ deliveryId: "delivery-1", worktree, package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "DETACHED", action: "UNKNOWN" }]; },
      attach() {},
      async waitForDelivery() { return new Promise(() => undefined); },
      async recover(request: any) { recoverCalls += 1; return { kind: "RECOVERY", worktree, deliveryId: "delivery-1", state: "RUNNING_CORRELATED", request }; },
      async status() { return { kind: "ERROR", code: "DELIVERY_UNKNOWN", message: "DELIVERY_UNKNOWN" }; },
      async finishAction() { return { kind: "ERROR", code: "ACTION_NOT_AWAITING_INPUT", message: "ACTION_NOT_AWAITING_INPUT" }; },
      async answerAction() { return { kind: "ERROR", code: "ACTION_NOT_AWAITING_INPUT", message: "ACTION_NOT_AWAITING_INPUT" }; },
    });
    const application = Object.freeze({
      async start() {}, async execute() { return { kind: "RECOVERY", worktree, deliveryId: "delivery-1", state: "RUNNING_CORRELATED" }; }, async inspect() { throw new Error("not used"); },
      async cancel() { throw new Error("not used"); }, status() { return { state: "READY" }; }, async close() {},
    });
    const runtime: any = await createPluginRuntime({ configFile: path.join(root, "execution.json"), bindingFile: file }, {
      bindings: repository,
      factory: Object.freeze({ async create() { return application; } }),
      control,
      moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult }),
      sessionAvailable: () => false,
    } as any);
    expect(await runtime.bindings.byDelivery("delivery-1")).toMatchObject({ state: "DETACHED" });
    const first = await runtime.invokeForSession({ sessionKey: "new-session", worktree, operation: parseWsrCommand("recover"), images: [] });
    expect(first).toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-1" });
    expect(await runtime.bindings.byDelivery("delivery-1")).toMatchObject({ sessionKey: "new-session", state: "BOUND" });
    const second = await runtime.invokeForSession({ sessionKey: "second-session", worktree, operation: parseWsrCommand("recover delivery-1"), images: [] });
    expect(second).toMatchObject({ kind: "ERROR", code: "DELIVERY_INTAKE_BOUND" });
    expect(recoverCalls).toBe(1);
    const occupiedCreate = await Promise.race([
      runtime.invokeForSession({ sessionKey: "third-session", worktree, operation: parseWsrCommand("create fixture@1.0.0\nnew request"), turnText: "/wsr create fixture@1.0.0\nnew request", images: [] }),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "TIMEOUT" }), 50)),
    ]);
    expect(occupiedCreate).toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-1" });
    await runtime.close();
  });

  it("joins every durable restart disposition before opening Intake without replaying an effect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-four-state-restart-"));
    roots.push(root);
    const worktrees = await Promise.all(["running", "input", "wait", "uncertain"].map(async (name) => {
      const directory = path.join(root, name);
      await (await import("node:fs/promises")).mkdir(directory);
      return directory;
    }));
    const inventory = [
      { deliveryId: "delivery-running", worktree: worktrees[0]!, package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "BOUND", action: "RUNNING" },
      { deliveryId: "delivery-input", worktree: worktrees[1]!, package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "BOUND", action: "AWAITING_INPUT" },
      { deliveryId: "delivery-wait", worktree: worktrees[2]!, package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "BOUND", action: "WORKFLOW_WAIT" },
      { deliveryId: "delivery-uncertain", worktree: worktrees[3]!, package: "fixture@1.0.0", lifecycle: "START_UNCERTAIN", intakeBinding: "BOUND", action: "UNKNOWN" },
    ];
    const bindings = new IntakeSessionBindingRepository(path.join(root, "bindings.json"));
    await bindings.start();
    for (const [index, item] of inventory.entries()) {
      await bindings.claim(Object.freeze({
        sessionKey: `session-${index}`,
        correlation: `correlation-${index}`,
        deliveryId: item.deliveryId,
        worktree: item.worktree,
      }));
    }
    const attached: unknown[] = [];
    let executeCalls = 0;
    let startObservedAttachments = 0;
    const application = Object.freeze({
      async start() { startObservedAttachments = attached.length; },
      async execute() { executeCalls += 1; throw new Error("startup must not create or replay a Delivery"); },
      async inspect() { throw new Error("not used"); }, async cancel() { throw new Error("not used"); },
      status() { return { state: "READY" }; }, async close() {},
    });
    const control = Object.freeze({
      async list() { return inventory; },
      attach(deliveryId: string, correlation: string) { attached.push({ deliveryId, correlation }); },
      async waitForDelivery() { return undefined; }, async recover() { throw new Error("not used"); },
      async status() { throw new Error("not used"); }, async finishAction() { throw new Error("not used"); },
      async answerAction() { throw new Error("not used"); },
    });

    const runtime: any = await createPluginRuntime({
      configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json"),
    }, {
      bindings, control,
      moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult }),
      factory: Object.freeze({ async create() { return application; } }),
      sessionAvailable: () => true,
    } as any);

    expect(attached).toEqual(inventory.map((item, index) => ({ deliveryId: item.deliveryId, correlation: `correlation-${index}` })));
    expect(startObservedAttachments).toBe(4);
    expect(executeCalls).toBe(0);
    await runtime.close();
  });

  it("fails closed when durable bindings violate one-to-one identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-corrupt-"));
    roots.push(root);
    const file = path.join(root, "bindings.json");
    await writeFile(file, `${JSON.stringify({ schemaVersion: "execution.intake-bindings@1.0.0", bindings: [
      { sessionKey: "session-a", correlation: "intake-a", deliveryId: "delivery-a", worktree: "/a", state: "BOUND" },
      { sessionKey: "session-b", correlation: "intake-b", deliveryId: "delivery-a", worktree: "/a", state: "BOUND" },
    ] })}\n`, "utf8");
    await expect(new IntakeSessionBindingRepository(file).start()).rejects.toMatchObject({ code: "INTAKE_BINDING_INVARIANT_VIOLATION" });
  });

  it("parses only the exact /wsr operation grammar and never accepts --intent", () => {
    expect(parseWsrCommand("list")).toEqual({ operation: "list" });
    expect(parseWsrCommand("create implementation-workflow@0.3.0\nuse this turn")).toEqual({ operation: "create", selector: "implementation-workflow@0.3.0", directive: "/wsr create implementation-workflow@0.3.0", remainder: "use this turn" });
    expect(parseWsrCommand("recover")).toEqual({ operation: "recover" });
    expect(parseWsrCommand("recover delivery-1")).toEqual({ operation: "recover", deliveryId: "delivery-1" });
    expect(parseWsrCommand("status delivery-1")).toEqual({ operation: "status", deliveryId: "delivery-1" });
    expect(parseWsrCommand("action finish\nfinal answer")).toEqual({ operation: "action-finish", remainder: "final answer" });
    expect(parseWsrCommand("abandon delivery-1")).toEqual({ operation: "abandon", deliveryId: "delivery-1" });
    expect(() => parseWsrCommand("create implementation-workflow --intent hidden prompt")).toThrowError("WSR_COMMAND_INVALID");
    expect(() => parseWsrCommand("recover latest")).not.toThrow();
    expect(() => parseWsrCommand("recover by-name extra")).toThrowError("WSR_COMMAND_INVALID");
    expect(mapIntakeToolOperation({ operation: "create", selector: "implementation-workflow@0.3.0" }))
      .toEqual({ operation: "create", selector: "implementation-workflow@0.3.0", directive: "/workflow-execution" });
    expect(mapIntakeToolOperation({ operation: "action-finish" })).toEqual({ operation: "action-finish" });
    expect(() => mapIntakeToolOperation({ operation: "create", selector: "implementation-workflow@0.3.0", deliveryId: "delivery-1" }))
      .toThrowError("INTAKE_OPERATION_INVALID");
    expect(() => mapIntakeToolOperation({ operation: "list", ambient: true })).toThrowError("INTAKE_OPERATION_INVALID");
    expect(() => mapIntakeToolOperation({ operation: "latest" })).toThrowError("INTAKE_OPERATION_INVALID");
  });

  it("renders asynchronous DSH-E output in DSH-I without invoking its AgentLoop", async () => {
    const events: any[] = [];
    const agent = Object.freeze({
      session: Object.freeze({ append(type: string, data: unknown) { events.push([type, data]); } }),
      send() { throw new Error("DSH-I AgentLoop must stay unused"); },
    });
    await presentToDshSession(agent, "Question from DSH-E", () => "cmd-presentation-1");
    expect(events).toEqual([
      ["command/run", { commandId: "cmd-presentation-1", name: "wsr", source: { kind: "plugin", plugin: "workflow-execution" } }],
      ["command/done", { commandId: "cmd-presentation-1", kind: "success", text: "Question from DSH-E" }],
    ]);
  });

  it("maps a native session and attachment into one private binding and host-neutral multi-turn control", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-runtime-"));
    roots.push(root);
    const worktreePath = path.join(root, "worktree");
    await (await import("node:fs/promises")).mkdir(worktreePath);
    const worktree = await (await import("node:fs/promises")).realpath(worktreePath);
    const requests: any[] = [];
    const answers: any[] = [];
    const finishes: any[] = [];
    const presentations: any[] = [];
    let resolveExecution!: (value: any) => void;
    const execution = new Promise<any>((resolve) => { resolveExecution = resolve; });
    let capturedDependencies: any;
    const application = Object.freeze({
      async start() {},
      async execute(request: any) {
        requests.push(request);
        await capturedDependencies.intake.publish({ correlation: request.intakeCorrelation, text: "Question from DSH-E" });
        return execution;
      },
      async inspect() { return { kind: "RECOVERY", worktree, deliveryId: "delivery-1", state: "RUNNING_CORRELATED" }; },
      async cancel(deliveryId: string) { return { kind: "TERMINAL", worktree, deliveryId, outcome: "CANCELLED" }; },
      status() { return { state: "READY" }; },
      async close() {},
    });
    const control = Object.freeze({
      async list() { return []; },
      attach() {},
      async waitForDelivery() { return { deliveryId: "delivery-1", worktree }; },
      async recover() { return { kind: "ERROR", code: "DELIVERY_UNKNOWN", message: "DELIVERY_UNKNOWN" }; },
      async status() { return { kind: "ERROR", code: "DELIVERY_UNKNOWN", message: "DELIVERY_UNKNOWN" }; },
      async finishAction(request: any) { finishes.push(request); return { kind: "RECOVERY", worktree, deliveryId: "delivery-1", state: "RUNNING_CORRELATED" }; },
      async answerAction(request: any) { answers.push(request); return { kind: "RECOVERY", worktree, deliveryId: "delivery-1", state: "RUNNING_CORRELATED" }; },
    });
    const factory = Object.freeze({ async create(_file: string, dependencies: any) { capturedDependencies = dependencies; return application; } });
    const runtime: any = await createPluginRuntime({ configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json") }, {
      moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult }), factory, control,
      present: async (presentation: any) => { presentations.push(presentation); },
    } as any);
    const attachmentStore = Object.freeze({ async readImage() { return { ref: { name: "proof.png", mediaType: "image/png" }, data: Uint8Array.from([1, 2, 3]) }; } });
    const result = await runtime.invokeForSession({
      sessionKey: "native-session-private", worktree,
      operation: parseWsrCommand("create implementation-workflow@0.3.0\nuse attached evidence"),
      turnText: "/wsr create implementation-workflow@0.3.0\nuse attached evidence",
      images: [{ type: "image", attachment: { attachmentId: "native-ref" } }], attachmentStore,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: "START_UNCERTAIN", deliveryId: "delivery-1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      worktree, selector: "implementation-workflow@0.3.0",
      prompt: { text: "use attached evidence", attachments: [{ filename: "proof.png", byteLength: 3, digest: `sha256:${"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"}` }] },
    });
    expect(JSON.stringify(requests[0])).not.toContain("native-session-private");
    expect(presentations).toEqual([{ sessionKey: "native-session-private", text: "Question from DSH-E" }]);
    expect(await capturedDependencies.attachments.read(requests[0].prompt.attachments[0].contentRef)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await runtime.bindings.bySession("native-session-private")).toMatchObject({ deliveryId: "delivery-1", worktree });

    await runtime.answerForSession({ sessionKey: "native-session-private", text: "ordinary answer", images: [], attachmentStore, signal: new AbortController().signal });
    expect(answers).toEqual([{ correlation: requests[0].intakeCorrelation, prompt: { text: "ordinary answer", attachments: [] } }]);
    await runtime.invokeForSession({ sessionKey: "native-session-private", worktree, operation: parseWsrCommand("action finish\nfinal answer"), turnText: "/wsr action finish\nfinal answer", images: [], attachmentStore, signal: new AbortController().signal });
    expect(finishes).toEqual([{ correlation: requests[0].intakeCorrelation, prompt: { text: "final answer", attachments: [] } }]);
    resolveExecution({ kind: "TERMINAL", worktree, deliveryId: "delivery-1", outcome: "SUCCEEDED" });
    await expect.poll(async () => runtime.bindings.bySession("native-session-private")).toBeUndefined();
    await expect.poll(() => presentations).toContainEqual({
      sessionKey: "native-session-private",
      text: JSON.stringify({ kind: "TERMINAL", worktree, deliveryId: "delivery-1", outcome: "SUCCEEDED" }),
    });
    await runtime.close();
  });

  it("closes the Intake gate, reaches a quiescent boundary, then disposes Execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-close-order-"));
    roots.push(root);
    const worktree = path.join(root, "worktree");
    await (await import("node:fs/promises")).mkdir(worktree);
    let resolveExecution!: (value: any) => void;
    const execution = new Promise<any>((resolve) => { resolveExecution = resolve; });
    let applicationClosed = false;
    const application = Object.freeze({
      async start() {}, async execute() { return execution; }, async inspect() { throw new Error("not used"); }, async cancel() { throw new Error("not used"); },
      status() { return { state: "READY" }; }, async close() { applicationClosed = true; },
    });
    const control = Object.freeze({
      async list() { return []; }, attach() {}, async waitForDelivery() { return { deliveryId: "delivery-close", worktree }; },
      async recover() { throw new Error("not used"); }, async status() { throw new Error("not used"); }, async finishAction() { throw new Error("not used"); }, async answerAction() { throw new Error("not used"); },
    });
    const runtime: any = await createPluginRuntime({ configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json") }, {
      moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult }),
      factory: Object.freeze({ async create() { return application; } }), control, quiesceTimeoutMs: 1_000,
    } as any);
    await runtime.invokeForSession({ sessionKey: "session-close", worktree, operation: parseWsrCommand("create fixture@1.0.0\nwait"), turnText: "/wsr create fixture@1.0.0\nwait", images: [] });
    const closing = runtime.close();
    await Promise.resolve();
    expect(applicationClosed).toBe(false);
    resolveExecution({ kind: "TERMINAL", worktree, deliveryId: "delivery-close", outcome: "SUCCEEDED" });
    await closing;
    expect(applicationClosed).toBe(true);
    await expect(runtime.invokeForSession({ sessionKey: "after-close", worktree, operation: parseWsrCommand("list"), images: [] }))
      .resolves.toMatchObject({ kind: "ERROR", code: "APPLICATION_CLOSING" });
  });

  it("bounds quiescence without fabricating terminal truth or clearing the durable binding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-close-timeout-"));
    roots.push(root);
    const worktree = path.join(root, "worktree");
    await (await import("node:fs/promises")).mkdir(worktree);
    const execution = new Promise<never>(() => undefined);
    let closeCalls = 0;
    let cancelCalls = 0;
    const application = Object.freeze({
      async start() {}, async execute() { return execution; }, async inspect() { throw new Error("not used"); },
      async cancel() { cancelCalls += 1; throw new Error("shutdown must not fabricate cancellation"); },
      status() { return { state: "READY" }; }, async close() { closeCalls += 1; },
    });
    const control = Object.freeze({
      async list() { return []; }, attach() {}, async waitForDelivery() { return { deliveryId: "delivery-timeout", worktree }; },
      async recover() { throw new Error("not used"); }, async status() { throw new Error("not used"); },
      async finishAction() { throw new Error("not used"); }, async answerAction() { throw new Error("not used"); },
    });
    const runtime: any = await createPluginRuntime({
      configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json"),
    }, {
      moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult }),
      factory: Object.freeze({ async create() { return application; } }), control, quiesceTimeoutMs: 5,
    } as any);
    await runtime.invokeForSession({
      sessionKey: "session-timeout", worktree,
      operation: parseWsrCommand("create fixture@1.0.0\nwait"),
      turnText: "/wsr create fixture@1.0.0\nwait", images: [],
    });

    await runtime.close();

    expect(closeCalls).toBe(1);
    expect(cancelCalls).toBe(0);
    expect(await runtime.bindings.bySession("session-timeout")).toMatchObject({
      deliveryId: "delivery-timeout", state: "BOUND",
    });
  });

  it("rolls back a failed startup and makes concurrent repeated close join one disposal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-lifecycle-faults-"));
    roots.push(root);
    const config = { configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json") };
    let failedCloseCalls = 0;
    const failedApplication = Object.freeze({
      async start() { throw new Error("startup failed"); }, async execute() { throw new Error("not used"); },
      async inspect() { throw new Error("not used"); }, async cancel() { throw new Error("not used"); },
      status() { return { state: "CLOSED" }; }, async close() { failedCloseCalls += 1; },
    });
    const control = Object.freeze({
      async list() { return []; }, attach() {}, async waitForDelivery() { return undefined; },
      async recover() { throw new Error("not used"); }, async status() { throw new Error("not used"); },
      async finishAction() { throw new Error("not used"); }, async answerAction() { throw new Error("not used"); },
    });
    await expect(createPluginRuntime(config, {
      moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult }),
      factory: Object.freeze({ async create() { return failedApplication; } }), control,
    } as any)).rejects.toThrow("startup failed");
    expect(failedCloseCalls).toBe(1);

    let resolveClose!: () => void;
    const closeBoundary = new Promise<void>((resolve) => { resolveClose = resolve; });
    let closeCalls = 0;
    const application = Object.freeze({
      async start() {}, async execute() { throw new Error("not used"); }, async inspect() { throw new Error("not used"); },
      async cancel() { throw new Error("not used"); }, status() { return { state: "READY" }; },
      async close() { closeCalls += 1; await closeBoundary; },
    });
    const runtime: any = await createPluginRuntime(config, {
      moduleLoader: async () => ({ WorkflowIntakeService, renderIntakeResult }),
      factory: Object.freeze({ async create() { return application; } }), control,
    } as any);
    const first = runtime.close();
    const second = runtime.close();
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await expect.poll(() => closeCalls).toBe(1);
    expect(secondSettled).toBe(false);
    resolveClose();
    await Promise.all([first, second]);
    expect(closeCalls).toBe(1);
  });
});
