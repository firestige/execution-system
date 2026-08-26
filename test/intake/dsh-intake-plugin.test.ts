import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  IntakeSessionBindingRepository,
  createSessionPresentationRouter,
  createPluginRuntime,
  mapIntakeToolOperation,
  parseWsrCommand,
  presentationForDshOperation,
  presentToDshSession,
  recordConsumedActionReply,
  recordWsrCommandInput,
  resolveConversationWorkspace,
} from "../../packages/dsh-intake/src/index.js";
import {
  WorkflowIntakeService,
  actionOutputPresentation,
  createIntakePresentation,
  presentationForIntakeResult,
  renderIntakeResult,
  serializeIntakePresentation,
} from "../../src/index.js";

const coreApi = Object.freeze({
  WorkflowIntakeService,
  actionOutputPresentation,
  createIntakePresentation,
  presentationForIntakeResult,
  renderIntakeResult,
  serializeIntakePresentation,
});

const roots: string[] = [];
const bindingIdentity = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Wave 6 DSH Intake plugin", () => {
  it("accepts only the registry-owned canonical workspace for the exact live conversation session", async () => {
    const launchDirectory = process.cwd();
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-authority-"));
    roots.push(root);
    const workspaceSpelling = path.join(root, "conversation-a");
    await mkdir(workspaceSpelling);
    const workspacePath = await realpath(workspaceSpelling);
    const canonicalRoot = await realpath(root);
    const sessionId = "session-a";
    const agent = { id: sessionId, session: { header: { cwd: workspacePath } } };
    const workspace = Object.freeze({ id: "workspace-a", path: workspacePath, sessionIds: Object.freeze([sessionId]) });
    const context = {
      agents: { get: (id: string) => id === sessionId ? agent : undefined },
      workspaceRegistry: { resolveByPath: async (candidate: string) => candidate === workspacePath ? workspace : undefined },
    };

    await expect(resolveConversationWorkspace(context, agent)).resolves.toEqual({
      sessionKey: sessionId,
      workspaceId: "workspace-a",
      path: workspacePath,
    });
    expect(workspacePath).not.toBe(launchDirectory);

    await expect(resolveConversationWorkspace({
      ...context,
      agents: { get: () => ({ ...agent }) },
    }, agent)).rejects.toMatchObject({ code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
    await expect(resolveConversationWorkspace({
      ...context,
      workspaceRegistry: { resolveByPath: async () => ({ ...workspace, sessionIds: [] }) },
    }, agent)).rejects.toMatchObject({ code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
    await expect(resolveConversationWorkspace({
      ...context,
      workspaceRegistry: { resolveByPath: async () => undefined },
    }, agent)).rejects.toMatchObject({ code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
    await expect(resolveConversationWorkspace({
      ...context,
      workspaceRegistry: { resolveByPath: async () => ({ ...workspace, id: "common-parent", path: canonicalRoot }) },
    }, agent)).rejects.toMatchObject({ code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
  });

  it("resolves conversation workspace only for operations whose selection depends on it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-workspace-decision-"));
    roots.push(root);
    const workspaceSpelling = path.join(root, "workspace");
    const fs = await import("node:fs/promises");
    await fs.mkdir(workspaceSpelling);
    const workspace = await fs.realpath(workspaceSpelling);
    const requests: unknown[] = [];
    const application = Object.freeze({
      async start() {},
      async execute(request: unknown) { requests.push(request); return { kind: "ERROR", code: "WORKFLOW_NOT_FOUND", message: "WORKFLOW_NOT_FOUND" }; },
      async inspect() { throw new Error("not used"); },
      async cancel(deliveryId: string) { return { kind: "TERMINAL", deliveryId, worktree: workspace, outcome: "CANCELLED" }; },
      status() { return { state: "READY" }; },
      async close() {},
    });
    const control = Object.freeze({
      async list() { return []; },
      async bindingInventory() { return [{ deliveryId: "delivery-1", worktree: workspace, deliveryBindingIdentity: bindingIdentity("delivery-1"), package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "DETACHED", action: "UNKNOWN" }]; },
      attach() {}, async waitForDelivery() { return undefined; },
      async recover(request: any) { return { kind: "RECOVERY", worktree: workspace, deliveryId: request.deliveryId, state: "RUNNING_CORRELATED" }; },
      async status(request: any) { return { kind: "RECOVERY", worktree: workspace, deliveryId: request.deliveryId, state: "RUNNING_CORRELATED" }; },
      async finishAction() { throw new Error("not used"); }, async answerAction() { throw new Error("not used"); },
    });
    const resolved: string[] = [];
    const runtime: any = await createPluginRuntime({
      configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json"),
    }, {
      moduleLoader: async () => coreApi,
      factory: Object.freeze({ async create() { return application; } }),
      control,
      async resolveConversationWorkspace(agent: { id: string }) {
        const sessionKey = String(agent.id);
        resolved.push(sessionKey);
        if (sessionKey === "rejected-session") throw Object.assign(new Error("unauthorized"), { code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
        return Object.freeze({ sessionKey, workspaceId: "workspace-1", path: workspace });
      },
    } as any);

    await expect(runtime.invokeForSession({ sessionKey: "rejected-session", operation: parseWsrCommand("list"), images: [] }))
      .resolves.toEqual({ kind: "LIST", deliveries: [] });
    await expect(runtime.invokeForSession({ sessionKey: "rejected-session", operation: parseWsrCommand("status delivery-1"), images: [] }))
      .resolves.toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-1" });
    await expect(runtime.invokeForSession({ sessionKey: "rejected-session", agent: { id: "rejected-session" }, operation: parseWsrCommand("recover delivery-1"), images: [] }))
      .resolves.toMatchObject({ kind: "ERROR", code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
    await expect(runtime.invokeForSession({ sessionKey: "rejected-session", operation: parseWsrCommand("abandon delivery-1"), images: [] }))
      .resolves.toMatchObject({ kind: "TERMINAL", deliveryId: "delivery-1" });
    expect(resolved).toEqual(["rejected-session"]);

    await expect(runtime.invokeForSession({
      sessionKey: "accepted-session", agent: { id: "accepted-session" }, operation: parseWsrCommand("create fixture@1.0.0\nrequest"),
      turnText: "/wsr create fixture@1.0.0\nrequest", images: [],
    })).resolves.toMatchObject({ kind: "ERROR", code: "WORKFLOW_NOT_FOUND" });
    expect(resolved).toEqual(["rejected-session", "accepted-session"]);
    expect(requests).toEqual([expect.objectContaining({ worktree: workspace })]);

    await expect(runtime.invokeForSession({
      sessionKey: "accepted-session", agent: { id: "different-session" }, operation: parseWsrCommand("create fixture@1.0.0\nrequest"),
      turnText: "/wsr create fixture@1.0.0\nrequest", images: [],
    })).resolves.toMatchObject({ kind: "ERROR", code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
    expect(resolved).toEqual(["rejected-session", "accepted-session"]);

    await expect(runtime.invokeForSession({
      sessionKey: "rejected-session", agent: { id: "rejected-session" }, operation: parseWsrCommand("create fixture@1.0.0\nrequest"),
      turnText: "/wsr create fixture@1.0.0\nrequest", images: [],
    })).resolves.toMatchObject({ kind: "ERROR", code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
    await runtime.close();
  });

  it("records an Action reply once before rejecting the DSH-I model step", () => {
    const appended: unknown[] = [];
    const message = { source: { kind: "user" }, content: [{ type: "text", text: "ordinary answer" }] };
    recordConsumedActionReply({ session: { append: (...args: unknown[]) => appended.push(args) } }, message);
    expect(appended).toEqual([["user/message", message, { surfaceOp: "append" }]]);
  });

  it("routes an interactive WSR command through a host-owned turn so a blank session becomes a real conversation", async () => {
    const followedUp: unknown[] = [];
    let idleWaits = 0;
    const image = { type: "image", attachment: "attachment-1" };
    const message = await recordWsrCommandInput(
      {
        followup(value: unknown) { followedUp.push(value); },
        async whenIdle() { idleWaits += 1; },
      },
      "create hello-world-workflow@0.1.0\n向我问好、概括本请求；如果存在附件，请确认已经看到它。",
      [image],
      () => "message-wsr-1",
    );

    expect(message).toEqual({
      id: "message-wsr-1",
      role: "user",
      source: { kind: "user", workflowCommand: "wsr" },
      content: [
        { type: "text", text: "/wsr create hello-world-workflow@0.1.0\n向我问好、概括本请求；如果存在附件，请确认已经看到它。" },
        image,
      ],
    });
    expect(followedUp).toEqual([message]);
    expect(idleWaits).toBe(1);
  });

  it("explains that create joined an existing current Delivery instead of creating a new one", () => {
    const presentation = presentationForDshOperation(coreApi, "correlation-1", { operation: "create" }, {
      kind: "RECOVERY", worktree: "/conversation", deliveryId: "delivery-existing", state: "RESULT_UNRESOLVED",
    });
    expect(presentation).toEqual({
      schemaVersion: "wsr.presentation@1.0.0",
      correlation: "correlation-1",
      kind: "delivery-status",
      data: {
        worktree: "/conversation", deliveryId: "delivery-existing", state: "RESULT_UNRESOLVED",
        created: false, reason: "CURRENT_DELIVERY_EXISTS",
      },
    });
  });

  it("rejects invalid profile config before binding, bootstrap, or startup activation effects", async () => {
    let factoryCalls = 0;
    const options = {
      moduleLoader: async () => coreApi,
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
    const coreManifest = JSON.parse(await readFile(path.join(import.meta.dirname, "../../package.json"), "utf8")) as { readonly version: string };
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as any;
    const patch = await readFile(path.join(packageRoot, "cordis.patch.yml"), "utf8");
    const skill = await readFile(path.join(packageRoot, "skills/workflow-execution/SKILL.md"), "utf8");
    const source = await readFile(path.join(packageRoot, "src/plugin.js"), "utf8");
    const client = await readFile(path.join(packageRoot, "lib/client.js"), "utf8");

    // Version expectations follow the core manifest so a version bump does
    // not require editing this test; this also asserts the documented
    // core/intake version-lock (build-release-artifacts enforces the same).
    expect(manifest).toMatchObject({
      name: "wsr-dsh-intake",
      version: coreManifest.version,
      exports: { "./client": "./lib/client.js" },
      dsh: { bundle: { patch: "./cordis.patch.yml" }, compatibility: {
        executionSystem: coreManifest.version, dsh: "0.1.1-rc.2", commands: "0.1.1-rc.2",
        agents: "0.1.1-rc.2", skillFilesystem: "0.1.1-rc.2", toolSkill: "0.1.1-rc.2", tools: "0.1.1-rc.2",
      }, client: { inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-sidebar"], platform: "web" } },
    });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(patch).toContain("id: workflow-execution");
    expect(patch).toContain("name: 'wsr-dsh-intake'");
    expect(patch).toContain("id: skill-filesystem");
    expect(patch).toContain("customSkillDirs");
    expect(patch).toMatch(/id: skill-filesystem[\s\S]*?disabled: false/u);
    expect(patch).toMatch(/id: tool-skill\s+disabled: false/u);
    expect(skill).toContain("workflow_execution_intake");
    expect(skill).toContain("exactly once");
    expect(skill).toContain("/wsr action finish");
    expect(source).toContain('import("wsr-execution")');
    expect(client).toContain('conversation.chat.commandview');
    expect(client).toContain('sidebar.footer.action');
    expect(client).toContain('key: "wsr"');
    expect(client).toContain('data-wsr-presentation');
    expect(source).toContain("recordInput: true");
    expect(source).toContain("session?.header?.cwd");
    expect(source).toContain('"workspaceRegistry"');
    expect(source).toContain("workspace.sessionIds.some");
    expect(source).toContain("executeFromConversationWorkspace");
    expect(source).not.toContain("process.cwd()");
    expect(source).not.toContain("conversationWorktreeFromAgent");
    expect(source).not.toMatch(/(?:src\/(?:delivery|observation|providers|host|coordinator|invocation)|RunnerFactory|DSH-E|ctx\.sessions)/u);
    expect(JSON.stringify(manifest) + patch + skill + source).not.toContain("implementation-workflow@0.3.0");
    expect(JSON.stringify(manifest) + patch + skill + source).not.toContain("system-design-workflow@0.3.0");
  });

  it("persists one-to-one session/Delivery bindings while different worktrees remain parallel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-bindings-"));
    roots.push(root);
    const repository = new IntakeSessionBindingRepository(path.join(root, "bindings.json"));
    await repository.start();
    const identityA = `sha256:${"a".repeat(64)}`;
    const identityB = `sha256:${"b".repeat(64)}`;
    const first = await repository.claim(Object.freeze({ sessionKey: "native-session-a", correlation: "intake-1", deliveryId: "delivery-a", worktree: "/worktree/a", deliveryBindingIdentity: identityA }));
    const second = await repository.claim(Object.freeze({ sessionKey: "native-session-b", correlation: "intake-2", deliveryId: "delivery-b", worktree: "/worktree/b", deliveryBindingIdentity: identityB }));
    expect(await repository.list()).toEqual([first, second]);
    await expect(repository.claim(Object.freeze({ sessionKey: "native-session-c", correlation: "intake-3", deliveryId: "delivery-a", worktree: "/worktree/a", deliveryBindingIdentity: identityA })))
      .rejects.toMatchObject({ code: "DELIVERY_INTAKE_BOUND" });
    await expect(repository.claim(Object.freeze({ sessionKey: "native-session-a", correlation: "intake-1", deliveryId: "delivery-c", worktree: "/worktree/c", deliveryBindingIdentity: `sha256:${"c".repeat(64)}` })))
      .rejects.toMatchObject({ code: "SESSION_INTAKE_BOUND" });

    expect(JSON.parse(await readFile(path.join(root, "bindings.json"), "utf8"))).toMatchObject({
      schemaVersion: "execution.intake-bindings@2.0.0",
      bindings: [{ deliveryBindingIdentity: identityA }, { deliveryBindingIdentity: identityB }],
    });

    const restarted = new IntakeSessionBindingRepository(path.join(root, "bindings.json"));
    await restarted.start();
    expect(await restarted.bySession("native-session-a")).toEqual(first);
    expect(await restarted.byDelivery("delivery-b")).toEqual(second);
    await restarted.markDetached("delivery-a");
    expect(await restarted.byDelivery("delivery-a")).toMatchObject({ state: "DETACHED" });
    const reclaimed = await restarted.claim(Object.freeze({ sessionKey: "native-session-c", correlation: "intake-3", deliveryId: "delivery-a", worktree: "/worktree/a", deliveryBindingIdentity: identityA }));
    expect(reclaimed).toMatchObject({ sessionKey: "native-session-c", correlation: "intake-3", state: "BOUND" });
    expect(await restarted.bySession("native-session-a")).toBeUndefined();
    await restarted.markDetached("delivery-b");
    const resumed = await restarted.claim(Object.freeze({
      sessionKey: "native-session-b", correlation: "intake-2-resumed", deliveryId: "delivery-b",
      worktree: "/worktree/b", deliveryBindingIdentity: identityB,
    }));
    expect(resumed).toMatchObject({ sessionKey: "native-session-b", correlation: "intake-2-resumed", state: "BOUND" });
    expect(JSON.stringify(await restarted.list())).not.toContain("credential");
  });

  it("migrates every v1 binding by an exact recovered Delivery identity or fails closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-binding-migration-"));
    roots.push(root);
    const file = path.join(root, "bindings.json");
    const legacy = { sessionKey: "session-a", correlation: "intake-a", deliveryId: "delivery-a", worktree: "/worktree/a", state: "BOUND" };
    await writeFile(file, `${JSON.stringify({ schemaVersion: "execution.intake-bindings@1.0.0", bindings: [legacy] })}\n`, "utf8");
    const identity = `sha256:${"d".repeat(64)}`;
    const inventory = [{ ...legacy, deliveryBindingIdentity: identity }];

    const migrated = new IntakeSessionBindingRepository(file);
    await migrated.start(inventory);
    await expect(migrated.byDelivery("delivery-a")).resolves.toMatchObject({ deliveryBindingIdentity: identity });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      schemaVersion: "execution.intake-bindings@2.0.0",
      bindings: [{ ...legacy, deliveryBindingIdentity: identity }],
    });

    await writeFile(file, `${JSON.stringify({ schemaVersion: "execution.intake-bindings@1.0.0", bindings: [legacy] })}\n`, "utf8");
    await expect(new IntakeSessionBindingRepository(file).start([]))
      .rejects.toMatchObject({ code: "INTAKE_BINDING_INVARIANT_VIOLATION" });
  });

  it("removes only conclusively stale bindings and fails startup on recovered identity drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-binding-reconcile-"));
    roots.push(root);
    const worktreeSpelling = path.join(root, "worktree");
    await mkdir(worktreeSpelling);
    const worktree = await realpath(worktreeSpelling);
    const application = Object.freeze({
      async start() {}, async execute() { throw new Error("not used"); }, async inspect() { throw new Error("not used"); },
      async cancel() { throw new Error("not used"); }, status() { return { state: "READY" }; }, async close() {},
    });
    const baseControl = {
      async list() { return []; }, attach() {}, async waitForDelivery() { return undefined; },
      async recover() { throw new Error("not used"); }, async status() { throw new Error("not used"); },
      async finishAction() { throw new Error("not used"); }, async answerAction() { throw new Error("not used"); },
    };

    const stale = new IntakeSessionBindingRepository(path.join(root, "stale.json"));
    await stale.start();
    await stale.claim({ sessionKey: "stale-session", correlation: "stale-correlation", deliveryId: "stale-delivery", worktree, deliveryBindingIdentity: bindingIdentity("stale-delivery") });
    const runtime: any = await createPluginRuntime({ configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "stale.json") }, {
      bindings: stale, moduleLoader: async () => coreApi, factory: Object.freeze({ async create() { return application; } }),
      control: Object.freeze({ ...baseControl, async bindingInventory() { return []; } }),
    } as any);
    await expect(runtime.bindings.byDelivery("stale-delivery")).resolves.toBeUndefined();
    await runtime.close();

    const drifted = new IntakeSessionBindingRepository(path.join(root, "drifted.json"));
    await drifted.start();
    await drifted.claim({ sessionKey: "session-a", correlation: "correlation-a", deliveryId: "delivery-a", worktree, deliveryBindingIdentity: bindingIdentity("old") });
    await expect(createPluginRuntime({ configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "drifted.json") }, {
      bindings: drifted, moduleLoader: async () => coreApi, factory: Object.freeze({ async create() { return application; } }),
      control: Object.freeze({ ...baseControl, async bindingInventory() {
        return [{ deliveryId: "delivery-a", worktree, deliveryBindingIdentity: bindingIdentity("new"), package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "DETACHED", action: "UNKNOWN" }];
      } }),
    } as any)).rejects.toMatchObject({ code: "INTAKE_BINDING_INVARIANT_VIOLATION" });
  });

  it("detaches an unavailable restored host session and refuses a live Delivery second claim before Core", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-recovery-"));
    roots.push(root);
    const worktreeSpelling = path.join(root, "worktree");
    await (await import("node:fs/promises")).mkdir(worktreeSpelling);
    const worktree = await realpath(worktreeSpelling);
    const otherWorkspaceSpelling = path.join(root, "other-workspace");
    await mkdir(otherWorkspaceSpelling);
    const otherWorkspace = await realpath(otherWorkspaceSpelling);
    const file = path.join(root, "bindings.json");
    const repository = new IntakeSessionBindingRepository(file);
    await repository.start();
    await repository.claim(Object.freeze({ sessionKey: "stale-session", correlation: "stale-correlation", deliveryId: "delivery-1", worktree, deliveryBindingIdentity: bindingIdentity("delivery-1") }));
    let recoverCalls = 0;
    const control = Object.freeze({
      async list() { return [{ deliveryId: "delivery-1", worktree, deliveryBindingIdentity: bindingIdentity("delivery-1"), package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "DETACHED", action: "UNKNOWN" }]; },
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
      moduleLoader: async () => coreApi,
      sessionAvailable: () => false,
      resolveConversationWorkspace: async (agent: { id: string }) => Object.freeze({
        sessionKey: agent.id, workspaceId: agent.id === "foreign-session" ? "workspace-2" : "workspace-1",
        path: agent.id === "foreign-session" ? otherWorkspace : worktree,
      }),
    } as any);
    expect(await runtime.bindings.byDelivery("delivery-1")).toMatchObject({ state: "DETACHED" });
    const first = await runtime.invokeForSession({ sessionKey: "new-session", agent: { id: "new-session" }, operation: parseWsrCommand("recover"), images: [] });
    expect(first).toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-1" });
    expect(await runtime.bindings.byDelivery("delivery-1")).toMatchObject({ sessionKey: "new-session", state: "BOUND" });
    await expect(runtime.invokeForSession({ sessionKey: "foreign-session", agent: { id: "foreign-session" }, operation: parseWsrCommand("recover delivery-1"), images: [] }))
      .resolves.toMatchObject({ kind: "ERROR", code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
    const second = await runtime.invokeForSession({ sessionKey: "second-session", agent: { id: "second-session" }, operation: parseWsrCommand("recover delivery-1"), images: [] });
    expect(second).toMatchObject({ kind: "ERROR", code: "DELIVERY_INTAKE_BOUND" });
    expect(recoverCalls).toBe(1);
    const occupiedCreate = await Promise.race([
      runtime.invokeForSession({ sessionKey: "third-session", agent: { id: "third-session" }, operation: parseWsrCommand("create fixture@1.0.0\nnew request"), turnText: "/wsr create fixture@1.0.0\nnew request", images: [] }),
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
      { deliveryId: "delivery-running", worktree: worktrees[0]!, deliveryBindingIdentity: bindingIdentity("delivery-running"), package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "BOUND", action: "RUNNING" },
      { deliveryId: "delivery-input", worktree: worktrees[1]!, deliveryBindingIdentity: bindingIdentity("delivery-input"), package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "BOUND", action: "AWAITING_INPUT" },
      { deliveryId: "delivery-wait", worktree: worktrees[2]!, deliveryBindingIdentity: bindingIdentity("delivery-wait"), package: "fixture@1.0.0", lifecycle: "RUNNING_CORRELATED", intakeBinding: "BOUND", action: "WORKFLOW_WAIT" },
      { deliveryId: "delivery-uncertain", worktree: worktrees[3]!, deliveryBindingIdentity: bindingIdentity("delivery-uncertain"), package: "fixture@1.0.0", lifecycle: "START_UNCERTAIN", intakeBinding: "BOUND", action: "UNKNOWN" },
    ];
    const bindings = new IntakeSessionBindingRepository(path.join(root, "bindings.json"));
    await bindings.start();
    for (const [index, item] of inventory.entries()) {
      await bindings.claim(Object.freeze({
        sessionKey: `session-${index}`,
        correlation: `correlation-${index}`,
        deliveryId: item.deliveryId,
        deliveryBindingIdentity: item.deliveryBindingIdentity,
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
      moduleLoader: async () => coreApi,
      factory: Object.freeze({ async create() { return application; } }),
      sessionAvailable: () => true,
    } as any);

    expect(attached).toEqual(inventory.map((item, index) => ({ deliveryId: item.deliveryId, correlation: `correlation-${index}` })));
    expect(startObservedAttachments).toBe(0);
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
    await presentToDshSession(agent, actionOutputPresentation("intake-1", { text: "Question from DSH-E" }), () => "cmd-presentation-1");
    expect(events).toEqual([
      ["command/run", { commandId: "cmd-presentation-1", name: "wsr", source: { kind: "plugin", plugin: "workflow-execution" } }],
      ["command/done", { commandId: "cmd-presentation-1", kind: "success", text: JSON.stringify({
        schemaVersion: "wsr.presentation@1.0.0", correlation: "intake-1", kind: "action-output", data: { content: { text: "Question from DSH-E" } },
      }) }],
    ]);
  });

  it("retains the invocation Agent only for asynchronous presentation after the live registry goes idle", () => {
    const appended: unknown[] = [];
    const agent = Object.freeze({
      id: "session-presentation",
      session: Object.freeze({ append: (...args: unknown[]) => appended.push(args) }),
    });
    const live = new Map<string, typeof agent>([[agent.id, agent]]);
    const router = createSessionPresentationRouter(Object.freeze({ get: (sessionKey: string) => live.get(sessionKey) }));
    router.retain(agent.id, agent);
    live.delete(agent.id);

    router.present(Object.freeze({
      sessionKey: agent.id,
      presentation: createIntakePresentation("correlation-output", "action-output", { content: { text: "done" } }),
    }));
    router.present(Object.freeze({
      sessionKey: agent.id,
      presentation: createIntakePresentation("correlation-terminal", "terminal-result", {
        worktree: "/worktree", deliveryId: "delivery-1", outcome: "SUCCEEDED",
      }),
    }));

    expect(appended).toHaveLength(4);
    expect(() => router.present(Object.freeze({
      sessionKey: agent.id,
      presentation: createIntakePresentation("correlation-late", "action-output", { content: { text: "late" } }),
    }))).toThrow("DSH_INTAKE_SESSION_UNAVAILABLE");
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
        await capturedDependencies.intake.publish(actionOutputPresentation(request.intakeCorrelation, { text: "Question from DSH-E" }));
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
      async waitForDelivery() { return { deliveryId: "delivery-1", worktree, deliveryBindingIdentity: bindingIdentity("delivery-1") }; },
      async recover() { return { kind: "ERROR", code: "DELIVERY_UNKNOWN", message: "DELIVERY_UNKNOWN" }; },
      async status() { return { kind: "ERROR", code: "DELIVERY_UNKNOWN", message: "DELIVERY_UNKNOWN" }; },
      async finishAction(request: any) { finishes.push(request); return { kind: "RECOVERY", worktree, deliveryId: "delivery-1", state: "RUNNING_CORRELATED" }; },
      async answerAction(request: any) { answers.push(request); return { kind: "RECOVERY", worktree, deliveryId: "delivery-1", state: "RUNNING_CORRELATED" }; },
    });
    const factory = Object.freeze({ async create(_file: string, dependencies: any) { capturedDependencies = dependencies; return application; } });
    const runtime: any = await createPluginRuntime({ configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json") }, {
      moduleLoader: async () => coreApi, factory, control,
      present: async (presentation: any) => { presentations.push(presentation); },
      resolveConversationWorkspace: async (agent: { id: string }) => Object.freeze({ sessionKey: agent.id, workspaceId: "workspace-1", path: worktree }),
    } as any);
    const attachmentStore = Object.freeze({ async readImage() { return { ref: { name: "proof.png", mediaType: "image/png" }, data: Uint8Array.from([1, 2, 3]) }; } });
    const result = await runtime.invokeForSession({
      sessionKey: "native-session-private", agent: { id: "native-session-private" },
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
    expect(presentations).toEqual([{ sessionKey: "native-session-private", presentation: {
      schemaVersion: "wsr.presentation@1.0.0", correlation: requests[0].intakeCorrelation,
      kind: "action-output", data: { content: { text: "Question from DSH-E" } },
    } }]);
    expect(await capturedDependencies.attachments.read(requests[0].prompt.attachments[0].contentRef)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await runtime.bindings.bySession("native-session-private")).toMatchObject({ deliveryId: "delivery-1", worktree });

    await expect(runtime.invokeForSession({
      sessionKey: "native-session-private", agent: { id: "native-session-private" },
      operation: parseWsrCommand("create implementation-workflow@0.3.0\nsecond Delivery"),
      turnText: "/wsr create implementation-workflow@0.3.0\nsecond Delivery", images: [], attachmentStore,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: "ERROR", code: "SESSION_INTAKE_BOUND" });
    expect(requests).toHaveLength(1);

    await runtime.answerForSession({ sessionKey: "native-session-private", text: "ordinary answer", images: [], attachmentStore, signal: new AbortController().signal });
    expect(answers).toEqual([{ correlation: requests[0].intakeCorrelation, prompt: { text: "ordinary answer", attachments: [] } }]);
    await runtime.invokeForSession({ sessionKey: "native-session-private", worktree, operation: parseWsrCommand("action finish\nfinal answer"), turnText: "/wsr action finish\nfinal answer", images: [], attachmentStore, signal: new AbortController().signal });
    expect(finishes).toEqual([{ correlation: requests[0].intakeCorrelation, prompt: { text: "final answer", attachments: [] } }]);
    resolveExecution({ kind: "TERMINAL", worktree, deliveryId: "delivery-1", outcome: "SUCCEEDED" });
    await expect.poll(async () => runtime.bindings.bySession("native-session-private")).toBeUndefined();
    await expect.poll(() => presentations).toContainEqual({
      sessionKey: "native-session-private",
      presentation: {
        schemaVersion: "wsr.presentation@1.0.0", correlation: requests[0].intakeCorrelation,
        kind: "terminal-result", data: { worktree, deliveryId: "delivery-1", outcome: "SUCCEEDED" },
      },
    });
    await runtime.close();
  });

  it("closes the Intake gate, reaches a quiescent boundary, then disposes Execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-close-order-"));
    roots.push(root);
    const worktreeSpelling = path.join(root, "worktree");
    await (await import("node:fs/promises")).mkdir(worktreeSpelling);
    const worktree = await realpath(worktreeSpelling);
    let resolveExecution!: (value: any) => void;
    const execution = new Promise<any>((resolve) => { resolveExecution = resolve; });
    let applicationClosed = false;
    const application = Object.freeze({
      async start() {}, async execute() { return execution; }, async inspect() { throw new Error("not used"); }, async cancel() { throw new Error("not used"); },
      status() { return { state: "READY" }; }, async close() { applicationClosed = true; },
    });
    const control = Object.freeze({
      async list() { return []; }, attach() {}, async waitForDelivery() { return { deliveryId: "delivery-close", worktree, deliveryBindingIdentity: bindingIdentity("delivery-close") }; },
      async recover() { throw new Error("not used"); }, async status() { throw new Error("not used"); }, async finishAction() { throw new Error("not used"); }, async answerAction() { throw new Error("not used"); },
    });
    const runtime: any = await createPluginRuntime({ configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json") }, {
      moduleLoader: async () => coreApi,
      factory: Object.freeze({ async create() { return application; } }), control, quiesceTimeoutMs: 1_000,
      resolveConversationWorkspace: async (agent: { id: string }) => Object.freeze({ sessionKey: agent.id, workspaceId: "workspace-1", path: worktree }),
    } as any);
    await runtime.invokeForSession({ sessionKey: "session-close", agent: { id: "session-close" }, operation: parseWsrCommand("create fixture@1.0.0\nwait"), turnText: "/wsr create fixture@1.0.0\nwait", images: [] });
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
    const worktreeSpelling = path.join(root, "worktree");
    await (await import("node:fs/promises")).mkdir(worktreeSpelling);
    const worktree = await realpath(worktreeSpelling);
    const execution = new Promise<never>(() => undefined);
    let closeCalls = 0;
    let cancelCalls = 0;
    const application = Object.freeze({
      async start() {}, async execute() { return execution; }, async inspect() { throw new Error("not used"); },
      async cancel() { cancelCalls += 1; throw new Error("shutdown must not fabricate cancellation"); },
      status() { return { state: "READY" }; }, async close() { closeCalls += 1; },
    });
    const control = Object.freeze({
      async list() { return []; }, attach() {}, async waitForDelivery() { return { deliveryId: "delivery-timeout", worktree, deliveryBindingIdentity: bindingIdentity("delivery-timeout") }; },
      async recover() { throw new Error("not used"); }, async status() { throw new Error("not used"); },
      async finishAction() { throw new Error("not used"); }, async answerAction() { throw new Error("not used"); },
    });
    const runtime: any = await createPluginRuntime({
      configFile: path.join(root, "execution.json"), bindingFile: path.join(root, "bindings.json"),
    }, {
      moduleLoader: async () => coreApi,
      factory: Object.freeze({ async create() { return application; } }), control, quiesceTimeoutMs: 5,
      resolveConversationWorkspace: async (agent: { id: string }) => Object.freeze({ sessionKey: agent.id, workspaceId: "workspace-1", path: worktree }),
    } as any);
    await runtime.invokeForSession({
      sessionKey: "session-timeout", agent: { id: "session-timeout" },
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
      moduleLoader: async () => coreApi,
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
      moduleLoader: async () => coreApi,
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
