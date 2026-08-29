import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvocationDispatch } from "../../../src/contracts/index.js";
import { canonicalDigest } from "../../../src/contracts/index.js";
import {
  COPILOT_PROVIDER_IDENTITY, COPILOT_RUNTIME_VERSION, createCopilotAgentProviderFactory,
  resolveInstalledCopilotSdkRuntime,
  type CopilotSdkClient, type CopilotSdkRuntimeBinding, type CopilotSdkSession, type CopilotSdkSessionConfiguration,
} from "../../../src/providers/copilot/index.js";
import { AgentProviderFactoryRegistry } from "../../../src/providers/provider.js";
import { createCopilotAgentProviderFactory as publicCopilotFactory } from "../../../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
type Scenario = "complete" | "input" | "timeout" | "process-error";

class FakeSession implements CopilotSdkSession {
  readonly abort = vi.fn(async () => undefined);
  readonly disconnect = vi.fn(async () => undefined);
  constructor(readonly sessionId: string, private readonly config: CopilotSdkSessionConfiguration, private readonly scenario: Scenario) {}
  async sendAndWait(message: Readonly<{ prompt: string }>): Promise<unknown> {
    if (this.scenario === "timeout") return await new Promise(() => undefined);
    if (this.scenario === "process-error") throw new Error("transport exited");
    this.config.onEvent?.({ type: "assistant.message", data: { content: `frame:${message.prompt}` } });
    const name = this.scenario === "input" ? "workflow_request_input" : "workflow_complete";
    const tool = this.config.tools.find((candidate) => candidate.name === name);
    if (tool?.handler === undefined) throw new Error("missing terminal tool");
    if (this.scenario === "input") await tool.handler({ requestIdentity: "request-1", prompt: "approve?", responseSchema: { type: "string" } });
    else await tool.handler({ result: { accepted: true } });
  }
}

class FakeClient implements CopilotSdkClient {
  readonly start = vi.fn(async () => undefined);
  readonly getStatus = vi.fn(async () => ({ version: COPILOT_RUNTIME_VERSION, protocolVersion: 1 }));
  readonly getAuthStatus = vi.fn(async () => ({ isAuthenticated: true, authType: "user" as const }));
  readonly listModels = vi.fn(async () => [{ id: "gpt-5.3-codex" }]);
  readonly stop = vi.fn(async () => [] as Error[]);
  readonly forceStop = vi.fn(async () => undefined);
  readonly createSession = vi.fn(async (config: CopilotSdkSessionConfiguration) => this.make(config.sessionId ?? "generated", config));
  readonly resumeSession = vi.fn(async (sessionId: string, config: CopilotSdkSessionConfiguration) => this.make(sessionId, config));
  readonly getSessionMetadata = vi.fn(async (sessionId: string) => ({ sessionId }));
  readonly configurations: CopilotSdkSessionConfiguration[] = [];
  readonly sessions: FakeSession[] = [];
  constructor(readonly scenario: Scenario = "complete") {}
  private make(sessionId: string, config: CopilotSdkSessionConfiguration) {
    this.configurations.push(config);
    const session = new FakeSession(sessionId, config, this.scenario);
    this.sessions.push(session);
    return session;
  }
}

function runtime(client: FakeClient, overrides: Partial<CopilotSdkRuntimeBinding> = {}): CopilotSdkRuntimeBinding {
  return Object.freeze({
    wrapperPackageName: "@github/copilot", wrapperPackageVersion: COPILOT_RUNTIME_VERSION,
    platformPackageName: `@github/copilot-${process.platform}-${process.arch}`, platformPackageVersion: COPILOT_RUNTIME_VERSION,
    createClient: vi.fn(() => client), ...overrides,
  });
}

async function fixture(scenario: Scenario = "complete") {
  const root = await mkdtemp(join(tmpdir(), "wsr-copilot-provider-")); temporaryDirectories.push(root);
  const workspacePath = join(root, "worktree"); const instructionsPath = join(root, "instructions.md");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  const workspace = await realpath(workspacePath);
  await writeFile(join(workspace, "src", "input.txt"), "original", "utf8");
  await writeFile(instructionsPath, "Act only as the admitted reviewer.", "utf8");
  const client = new FakeClient(scenario); const binding = runtime(client);
  const factory = createCopilotAgentProviderFactory({ resolveRuntime: async () => binding, turnTimeoutMs: 20 });
  const registry = new AgentProviderFactoryRegistry([factory]);
  const descriptor = registry.admit({ identity: COPILOT_PROVIDER_IDENTITY, version: COPILOT_RUNTIME_VERSION }, ["structured-completion"]);
  const request = Object.freeze({
    schemaVersion: "execution.agent-provider-delivery-realm-request@2.0.0" as const, deliveryId: "delivery-1",
    manifestBindingIdentity: `sha256:${"a".repeat(64)}`, canonicalWorktree: workspace,
    providerIdentity: descriptor.identity, providerVersion: descriptor.version, providerDescriptorDigest: descriptor.descriptorDigest,
    maxParallelToolCalls: 2,
    roleBindings: Object.freeze([Object.freeze({ roleId: "role.reviewer", modelProviderId: "github-copilot", modelId: "gpt-5.3-codex" })]),
  });
  const lease = await factory.acquire(request);
  return { root, workspace, instructionsPath, client, binding, factory, descriptor, request, lease };
}

function dispatch(input: { workspace: string; instructionsPath: string; roleId?: string; modelId?: string; access?: readonly { mode: "read" | "write"; path: string }[] }): InvocationDispatch {
  const instructions = "Act only as the admitted reviewer."; const access = input.access ?? [{ mode: "write" as const, path: "src/**" }];
  const value = {
    episode: { thread: { delivery: { deliveryIdentity: "delivery-1", manifestBindingIdentity: `sha256:${"a".repeat(64)}`, activationBindingIdentity: `sha256:${"b".repeat(64)}` }, threadIdentity: "thread-1" }, site: { kind: "node", nodeIdentity: "node-1" }, invocationIdentity: "invocation-1", attemptIdentity: "attempt-1" },
    plan: { actionIdentity: "action.review", executorIdentity: "executor.review", bindingIdentity: `sha256:${"c".repeat(64)}` },
    action: { identity: "action.review", purpose: "Return the typed review decision", inputSchema: { type: "object" }, resultSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false }, gate: { kind: "none" } },
    executor: { identity: "executor.review", bindingIdentity: `sha256:${"d".repeat(64)}`, sessionCompatibilityIdentity: `sha256:${"e".repeat(64)}`, session: {
      roleIdentity: input.roleId ?? "role.reviewer", routeIdentity: "route.review",
      agent: { resourceIdentity: "agent.review", contentIdentity: `sha256:${"1".repeat(64)}`, projectionIdentity: `sha256:${"2".repeat(64)}`, localReadOnlyPath: input.instructionsPath },
      model: { resourceIdentity: "model.review", contentIdentity: `sha256:${"3".repeat(64)}`, projectionIdentity: `sha256:${"4".repeat(64)}`, providerModelIdentity: input.modelId ?? "gpt-5.3-codex", configuration: {} },
      driver: { resourceIdentity: "driver.copilot", projectionIdentity: `sha256:${"5".repeat(64)}`, providerIdentity: "copilot-sdk", configuration: {} },
      instructions: { resourceIdentity: "instruction.review", contentIdentity: `sha256:${createHash("sha256").update(instructions).digest("hex")}`, localReadOnlyPath: input.instructionsPath },
      tools: [{ resourceIdentity: "tool.workspace", contentIdentity: `sha256:${"6".repeat(64)}`, localReadOnlyPath: { kind: "ABSENT" }, configuration: { toolName: "workspace_files", workspaceAccess: true } }],
      providedCapabilities: ["structured-completion", "action-interaction"], policy: { identity: "session.review", scope: { kind: "episode" }, isolation: "isolated" },
    }, turn: { access } }, input: { review: "current change" },
    workspace: { kind: "write", handle: { handleIdentity: "handle-1", episode: undefined, savepoint: { identity: "savepoint-1", delivery: undefined, gitTree: "tree-1" }, accessDigest: `sha256:${"7".repeat(64)}` } },
    session: { identity: "affinity-1", delivery: undefined, sessionCompatibilityIdentity: `sha256:${"e".repeat(64)}`, scopeValueIdentity: `sha256:${"8".repeat(64)}`, isolation: "isolated" },
  } as unknown as InvocationDispatch;
  const mutable = value as any;
  mutable.workspace.handle.episode = mutable.episode; mutable.workspace.handle.savepoint.delivery = mutable.episode.thread.delivery; mutable.session.delivery = mutable.episode.thread.delivery;
  mutable.executor.sessionCompatibilityIdentity = canonicalDigest(mutable.executor.session);
  mutable.executor.bindingIdentity = canonicalDigest({ session: mutable.executor.session, turn: mutable.executor.turn });
  mutable.plan.bindingIdentity = canonicalDigest({ site: mutable.episode.site, action: mutable.action, executorBindingIdentity: mutable.executor.bindingIdentity });
  mutable.session.sessionCompatibilityIdentity = mutable.executor.sessionCompatibilityIdentity;
  mutable.session.identity = canonicalDigest({ deliveryIdentity: mutable.session.delivery.deliveryIdentity, sessionCompatibilityIdentity: mutable.session.sessionCompatibilityIdentity, scopeValueIdentity: mutable.session.scopeValueIdentity, isolation: mutable.session.isolation });
  mutable.workspace.handle.accessDigest = canonicalDigest(mutable.executor.turn.access); return value;
}

describe("Copilot SDK Agent Provider", () => {
  it("publishes the production factory through the package root", () => {
    expect(publicCopilotFactory).toBe(createCopilotAgentProviderFactory);
  });

  it("imports the bundled SDK only from the exact wrapper/platform package pair", async () => {
    const binding = await resolveInstalledCopilotSdkRuntime();
    expect(binding).toMatchObject({
      wrapperPackageName: "@github/copilot",
      wrapperPackageVersion: COPILOT_RUNTIME_VERSION,
      platformPackageName: `@github/copilot-${process.platform}-${process.arch}`,
      platformPackageVersion: COPILOT_RUNTIME_VERSION,
    });
    expect(binding.createClient).toBeTypeOf("function");
  });

  it("uses exact local runtime/login, frozen Role/model, canonical cwd, scoped tools, and typed completion", async () => {
    const prepared = await fixture(); const native = await prepared.lease.adapter.sessions.open({ dispatch: dispatch(prepared), signal: new AbortController().signal });
    expect(await native.run({ review: "current change" })).toEqual([{ kind: "output", content: expect.stringContaining("current change") }, { kind: "structured-completion", result: { accepted: true } }]);
    expect(prepared.client.start).toHaveBeenCalledOnce(); expect(prepared.client.getAuthStatus).toHaveBeenCalledOnce();
    const clientOptions = (prepared.binding.createClient as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(clientOptions).toMatchObject({ mode: "empty", useLoggedInUser: true, workingDirectory: prepared.workspace });
    expect(clientOptions).not.toHaveProperty("gitHubToken");
    const config = prepared.client.configurations[0]!;
    expect(config).toMatchObject({ model: "gpt-5.3-codex", workingDirectory: prepared.workspace, remoteSession: "off", skipCustomInstructions: true });
    expect(config.systemMessage.content).toContain("role.reviewer"); expect(config.systemMessage.content).toContain("route.review"); expect(config.systemMessage.content).toContain("action.review");
    expect(config.availableTools).toEqual(["workflow_complete", "workflow_request_input", "workspace_files"]);
    expect(config.tools.map((tool) => tool.name)).toEqual(["workflow_complete", "workflow_request_input", "workspace_files"]);
    expect(JSON.stringify(config)).not.toMatch(/credential|token|api.?key/iu);
    await native.persist(); await native.dispose(); await prepared.lease.dispose();
  });

  it("fails closed before session effects for a different Role/model or inexact SDK binding", async () => {
    const prepared = await fixture();
    await expect(prepared.lease.adapter.sessions.open({ dispatch: dispatch({ ...prepared, roleId: "role.engineer" }), signal: new AbortController().signal })).rejects.toThrow("Role binding");
    await expect(prepared.lease.adapter.sessions.open({ dispatch: dispatch({ ...prepared, modelId: "other-model" }), signal: new AbortController().signal })).rejects.toThrow("model binding");
    expect(prepared.client.createSession).not.toHaveBeenCalled(); await prepared.lease.dispose();
    const bad = createCopilotAgentProviderFactory({ resolveRuntime: async () => runtime(new FakeClient(), { platformPackageVersion: "1.0.79" }), turnTimeoutMs: 20 });
    const descriptor = new AgentProviderFactoryRegistry([bad]).descriptors()[0]!;
    await expect(bad.acquire({ ...prepared.request, providerDescriptorDigest: descriptor.descriptorDigest })).rejects.toThrow("exact runtime");
  });

  it("fails closed when local login, model, or observed version is unavailable", async () => {
    const prepared = await fixture(); await prepared.lease.dispose();
    for (const mutate of [
      (client: FakeClient) => client.getAuthStatus.mockResolvedValue({ isAuthenticated: false, authType: "user" }),
      (client: FakeClient) => client.listModels.mockResolvedValue([{ id: "different-model" }]),
      (client: FakeClient) => client.getStatus.mockResolvedValue({ version: "1.0.79" as typeof COPILOT_RUNTIME_VERSION, protocolVersion: 1 }),
    ]) {
      const client = new FakeClient(); mutate(client);
      const factory = createCopilotAgentProviderFactory({ resolveRuntime: async () => runtime(client), turnTimeoutMs: 20 });
      const descriptor = new AgentProviderFactoryRegistry([factory]).descriptors()[0]!;
      await expect(factory.acquire({ ...prepared.request, providerDescriptorDigest: descriptor.descriptorDigest })).rejects.toThrow();
      expect(client.stop).toHaveBeenCalledOnce();
    }

    const failedStart = new FakeClient();
    failedStart.start.mockRejectedValueOnce(new Error("startup failed"));
    failedStart.stop.mockRejectedValueOnce(new Error("cleanup failed"));
    const factory = createCopilotAgentProviderFactory({ resolveRuntime: async () => runtime(failedStart), turnTimeoutMs: 20 });
    const descriptor = new AgentProviderFactoryRegistry([factory]).descriptors()[0]!;
    await expect(factory.acquire({ ...prepared.request, providerDescriptorDigest: descriptor.descriptorDigest })).rejects.toThrow("startup failed");
    expect(failedStart.forceStop).toHaveBeenCalledOnce();
  });

  it("projects only admitted workspace access and rejects ambient permissions", async () => {
    const prepared = await fixture(); const native = await prepared.lease.adapter.sessions.open({ dispatch: dispatch(prepared), signal: new AbortController().signal });
    const config = prepared.client.configurations[0]!; const tool = config.tools.find((candidate) => candidate.name === "workspace_files")!;
    expect(await tool.handler?.({ operation: "read", path: "src/input.txt" })).toEqual({ content: "original" });
    expect(await tool.handler?.({ operation: "write", path: "src/output.txt", content: "bounded" })).toEqual({ written: true });
    expect(await readFile(join(prepared.workspace, "src", "output.txt"), "utf8")).toBe("bounded");
    expect(await tool.handler?.({ operation: "list", path: "src" })).toMatchObject({ entries: expect.arrayContaining([{ name: "input.txt", kind: "file" }]) });
    await expect(tool.handler?.({ operation: "read", path: "../outside.txt" })).rejects.toThrow("admitted path");
    await expect(tool.handler?.({ operation: "write", path: "src/missing.txt" })).rejects.toThrow("requires content");
    expect(await config.onPermissionRequest?.({ kind: "shell", fullCommandText: "echo bypass" }, { sessionId: native.opaqueIdentity })).toEqual({ kind: "reject", feedback: "operation is outside the admitted Action tool scope" });
    await native.dispose(); await prepared.lease.dispose();
  });

  it("suspends for typed input and resumes only the compatible session", async () => {
    const prepared = await fixture("input"); const value = dispatch(prepared);
    const native = await prepared.lease.adapter.sessions.open({ dispatch: value, signal: new AbortController().signal });
    expect(await native.run({ review: "needs input" })).toContainEqual({ kind: "input-request", requestIdentity: "request-1", prompt: "approve?", responseSchema: { type: "string" } });
    await native.persist(); await native.dispose();
    const restored = await prepared.lease.adapter.sessions.restore({ opaqueIdentity: native.opaqueIdentity, dispatch: value, signal: new AbortController().signal });
    expect(restored.opaqueIdentity).toBe(native.opaqueIdentity);
    expect(prepared.client.resumeSession).toHaveBeenCalledWith(native.opaqueIdentity, expect.objectContaining({ model: "gpt-5.3-codex", workingDirectory: prepared.workspace }));
    await restored.dispose();
    await expect(prepared.lease.adapter.sessions.restore({ opaqueIdentity: native.opaqueIdentity, dispatch: dispatch({ ...prepared, modelId: "other-model" }), signal: new AbortController().signal })).rejects.toThrow();
    await prepared.lease.dispose();
  });

  it("normalizes timeout, cancellation, process, startup, and result uncertainty", async () => {
    const timed = await fixture("timeout"); const timedSession = await timed.lease.adapter.sessions.open({ dispatch: dispatch(timed), signal: new AbortController().signal });
    expect(await timedSession.run({ slow: true })).toContainEqual({ kind: "provider-failed", code: "PROVIDER_TIMED_OUT", detail: "Copilot turn timed out" });
    expect(timed.client.sessions[0]!.abort).toHaveBeenCalledOnce(); await timedSession.cancel(); expect(timed.client.sessions[0]!.abort).toHaveBeenCalledTimes(2);
    await timedSession.dispose(); await timed.lease.dispose();
    const exited = await fixture("process-error"); const exitedSession = await exited.lease.adapter.sessions.open({ dispatch: dispatch(exited), signal: new AbortController().signal });
    expect(await exitedSession.run({ fail: true })).toEqual([{ kind: "provider-failed", code: "PROVIDER_EXITED", detail: "Copilot runtime exited during the turn" }]);
    await exitedSession.dispose(); await exited.lease.dispose();
    const starting = await fixture(); starting.client.createSession.mockRejectedValueOnce(new Error("response lost"));
    await expect(starting.lease.adapter.sessions.open({ dispatch: dispatch(starting), signal: new AbortController().signal })).rejects.toThrow("session start is uncertain"); await starting.lease.dispose();
    const uncertain = await fixture(); const uncertainSession = await uncertain.lease.adapter.sessions.open({ dispatch: dispatch(uncertain), signal: new AbortController().signal });
    uncertain.client.getSessionMetadata.mockRejectedValueOnce(new Error("response lost")); await uncertainSession.run({ accepted: true });
    await expect(uncertainSession.persist()).rejects.toThrow("result persistence is uncertain"); await uncertainSession.dispose(); await uncertain.lease.dispose();
  });

  it("teardown is idempotent and isolates Delivery realms", async () => {
    const first = await fixture(); const session = await first.lease.adapter.sessions.open({ dispatch: dispatch(first), signal: new AbortController().signal });
    await first.lease.dispose(); await first.lease.dispose();
    expect(first.client.sessions[0]!.disconnect).toHaveBeenCalledOnce(); expect(first.client.stop).toHaveBeenCalledOnce();
    await expect(first.lease.adapter.sessions.open({ dispatch: dispatch(first), signal: new AbortController().signal })).rejects.toThrow("disposed"); await session.dispose();
    const second = await fixture(); expect(second.client).not.toBe(first.client); await second.lease.dispose();
  });

  it("rejects malformed realm/session inputs and incompatible native identities", async () => {
    expect(() => createCopilotAgentProviderFactory({ turnTimeoutMs: 0 })).toThrow("timeout");
    const prepared = await fixture();
    await prepared.lease.dispose();
    await expect(prepared.factory.acquire({ ...prepared.request, providerIdentity: "provider.other" })).rejects.toThrow("realm request");
    await expect(prepared.factory.acquire({ ...prepared.request, roleBindings: [] })).rejects.toThrow("realm request");

    const wrongStart = await fixture();
    wrongStart.client.createSession.mockImplementationOnce(async (config) => new FakeSession("wrong-session", config, "complete"));
    await expect(wrongStart.lease.adapter.sessions.open({ dispatch: dispatch(wrongStart), signal: new AbortController().signal })).rejects.toThrow("incompatible identity");
    await wrongStart.lease.dispose();

    const wrongResume = await fixture();
    const value = dispatch(wrongResume);
    const original = await wrongResume.lease.adapter.sessions.open({ dispatch: value, signal: new AbortController().signal });
    await original.dispose();
    wrongResume.client.resumeSession.mockImplementationOnce(async (_id, config) => new FakeSession("wrong-session", config, "complete"));
    await expect(wrongResume.lease.adapter.sessions.restore({ opaqueIdentity: original.opaqueIdentity, dispatch: value, signal: new AbortController().signal })).rejects.toThrow("incompatible identity");
    await wrongResume.lease.dispose();
  });

  it("fails closed on instruction/tool scope drift and proves runtime cleanup fallback", async () => {
    const instructionsDrift = await fixture();
    await writeFile(instructionsDrift.instructionsPath, "changed after admission", "utf8");
    await expect(instructionsDrift.lease.adapter.sessions.open({ dispatch: dispatch(instructionsDrift), signal: new AbortController().signal })).rejects.toThrow("instruction identity");
    instructionsDrift.client.stop.mockResolvedValueOnce([new Error("graceful stop failed")]);
    await instructionsDrift.lease.dispose();
    expect(instructionsDrift.client.forceStop).toHaveBeenCalledOnce();

    const noWorkspace = await fixture();
    const value = dispatch(noWorkspace) as any;
    value.workspace = { kind: "none" };
    await expect(noWorkspace.lease.adapter.sessions.open({ dispatch: value, signal: new AbortController().signal })).rejects.toThrow("workspace tool");
    await noWorkspace.lease.dispose();
  });

  it("maps SDK error/cancel events and missing persistence evidence to typed outcomes", async () => {
    for (const [event, code] of [
      [{ type: "session.error", data: { message: "opaque" } }, "PROVIDER_PROTOCOL_ERROR"],
      [{ type: "abort", data: {} }, "PROVIDER_CANCELLED"],
    ] as const) {
      const prepared = await fixture();
      const native = await prepared.lease.adapter.sessions.open({ dispatch: dispatch(prepared), signal: new AbortController().signal });
      const config = prepared.client.configurations[0]!;
      const original = prepared.client.sessions[0]!.sendAndWait.bind(prepared.client.sessions[0]!);
      prepared.client.sessions[0]!.sendAndWait = async (message) => { config.onEvent(event); return original(message); };
      expect(await native.run({ event: true })).toContainEqual(expect.objectContaining({ kind: "provider-failed", code }));
      prepared.client.getSessionMetadata.mockResolvedValueOnce(undefined as any);
      await expect(native.persist()).rejects.toThrow("persistence is uncertain");
      await native.dispose(); await prepared.lease.dispose();
    }
  });

  it("fails closed for invalid terminal, path, cancellation, and recovery inputs", async () => {
    const prepared = await fixture(); const value = dispatch(prepared);
    const aborted = new AbortController(); aborted.abort();
    await expect(prepared.lease.adapter.sessions.open({ dispatch: value, signal: aborted.signal })).rejects.toThrow("cancelled");

    const native = await prepared.lease.adapter.sessions.open({ dispatch: value, signal: new AbortController().signal });
    const config = prepared.client.configurations[0]!;
    const interaction = config.tools.find((tool) => tool.name === "workflow_request_input")!;
    await expect(interaction.handler?.({ requestIdentity: "", responseSchema: {} })).rejects.toThrow("input request is invalid");
    const workspace = config.tools.find((tool) => tool.name === "workspace_files")!;
    await expect(workspace.handler?.({ operation: "read", path: prepared.instructionsPath })).rejects.toThrow("relative admitted path");
    await expect(workspace.handler?.({ operation: "read", path: "outside.txt" })).rejects.toThrow("outside the admitted path scope");
    await expect(workspace.handler?.({ operation: "delete", path: "src/input.txt" })).rejects.toThrow("write requires content");
    (native as unknown as { accept(event: unknown): void }).accept({ type: "assistant.message", data: { content: "buffered" } });

    await native.dispose();
    await expect(native.run({ disposed: true })).rejects.toThrow("session is disposed");
    await native.cancel();
    prepared.client.resumeSession.mockRejectedValueOnce(new Error("response lost"));
    await expect(prepared.lease.adapter.sessions.restore({ opaqueIdentity: native.opaqueIdentity, dispatch: value, signal: new AbortController().signal })).rejects.toThrow("recovery is uncertain");
    await prepared.lease.dispose();
  });
});
