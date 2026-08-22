import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalDigest,
  type ActionInputResponse,
  type AuthorizedInvocationHandle,
  type AuthorizedReadView,
  type AuthorizedWorkspaceCapability,
  type CheckpointRef,
  type CompiledGraphActivation,
  type CustodyAttemptDisposition,
  type CustodyError,
  type EpisodeRef,
  type HostCustody,
  type HostInvocation,
  type InvocationCallError,
  type InvocationDispatch,
  type InvocationDisposition,
  type Knowledge,
  type OwnerRetirementDisposition,
  type Result,
  type SavepointRef,
} from "../../src/contracts/index.js";
import { compileRunnerActivation } from "../../src/interpreter/compile-runner-activation.js";
import { createGitCustody } from "../../src/custody/git-custody.js";
import { FileInvocationJournalStore, createManagedInvocation, type NativeProviderSessionFactory } from "../../src/invocation/index.js";
import { createLangGraphCoordinatorHost } from "../../src/host/langgraph-coordinator-host.js";
import { mutatedRunnerActivation } from "../support/runner-activation-fixtures.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function checkpointDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "formal-g04-host-"));
  directories.push(directory);
  return directory;
}

function gitWorkspace(): { directory: string; tree: string } {
  const directory = checkpointDirectory();
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "G04 Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "g04@example.invalid"], { cwd: directory });
  writeFileSync(path.join(directory, "README.md"), "baseline\n");
  execFileSync("git", ["add", "README.md"], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: directory });
  return { directory, tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: directory, encoding: "utf8" }).trim() };
}

function compiledActivation(mutate: (draft: any) => void): CompiledGraphActivation {
  const activation = mutatedRunnerActivation((draft) => {
    mutate(draft);
    for (const executor of Object.values(draft.program.execution.agents) as any[]) {
      executor.sessionCompatibilityIdentity = canonicalDigest(executor.session);
      executor.bindingIdentity = canonicalDigest({ session: executor.session, turn: executor.turn });
    }
  });
  const compiled = compileRunnerActivation(activation);
  if (!compiled.ok) throw new Error(`fixture did not compile: ${compiled.error.code}`);
  return compiled.value;
}

const known = <T>(value: T): Knowledge<T> => ({ state: "known", value });

class FakeCustody implements HostCustody {
  readonly baseline: SavepointRef = {
    deliveryIdentity: "delivery.fixture",
    savepointIdentity: "savepoint.baseline",
    gitTree: "tree.baseline",
  } as SavepointRef;
  readonly next: SavepointRef = {
    deliveryIdentity: "delivery.fixture",
    savepointIdentity: "savepoint.next",
    gitTree: "tree.next",
  } as SavepointRef;
  readonly calls: string[] = [];
  settlements: Array<{ episode: EpisodeRef; workspace: AuthorizedWorkspaceCapability; hostDecision: "accept" | "reject" }> = [];
  settleResult: CustodyAttemptDisposition = { kind: "accepted", nextSavepoint: known(this.next) };
  baselineOk = true;
  writeOk = true;
  readOk = true;
  settleOk = true;

  async establishBaseline(): Promise<Result<SavepointRef, CustodyError>> {
    this.calls.push("baseline");
    return this.baselineOk ? { ok: true, value: this.baseline } : { ok: false, error: { code: "GIT_STATE_MISMATCH" } };
  }

  async acquireWriteHandle(request: Parameters<HostCustody["acquireWriteHandle"]>[0]): Promise<Result<AuthorizedInvocationHandle, CustodyError>> {
    this.calls.push("write");
    if (!this.writeOk) return { ok: false, error: { code: "CORRELATION_MISMATCH" } };
    return {
      ok: true as const,
      value: {
        handleIdentity: "handle.fixture" as never,
        episode: request.episode,
        savepoint: request.savepoint,
        accessDigest: canonicalDigest(request.access),
      },
    };
  }

  async openReadView(request: Parameters<HostCustody["openReadView"]>[0]) {
    this.calls.push("read");
    if (!this.readOk) return { ok: false as const, error: { code: "READ_VIEW_INVALID" as const } };
    return {
      ok: true as const,
      value: {
        viewIdentity: "view.fixture",
        episode: request.episode,
        source: request.source,
        accessDigest: canonicalDigest(request.access),
      } as AuthorizedReadView,
    };
  }

  async settleWorkspaceAttempt(request: Parameters<HostCustody["settleWorkspaceAttempt"]>[0]) {
    this.calls.push(`settle:${request.hostDecision}`);
    this.settlements.push(request);
    return this.settleOk
      ? { ok: true as const, value: this.settleResult }
      : { ok: false as const, error: { code: "CORRELATION_MISMATCH" as const } };
  }

  async validateReadView(view: AuthorizedReadView) {
    this.calls.push("validate-read");
    return { ok: true as const, value: { kind: "current" as const, view } };
  }
}

type InvocationFactory = (dispatch: InvocationDispatch) => InvocationDisposition;

class FakeInvocation implements HostInvocation {
  readonly dispatches: InvocationDispatch[] = [];
  readonly continuations: Array<{ episode: EpisodeRef; response: ActionInputResponse }> = [];
  constructor(
    readonly onStart: InvocationFactory,
    readonly onContinue: (episode: EpisodeRef, response: ActionInputResponse) => InvocationDisposition = () => {
      throw new Error("unexpected continuation");
    },
  ) {}

  async start(dispatch: InvocationDispatch): Promise<Result<InvocationDisposition, InvocationCallError>> {
    this.dispatches.push(dispatch);
    return { ok: true, value: this.onStart(dispatch) };
  }

  async continueWithInput(request: Parameters<HostInvocation["continueWithInput"]>[0]): Promise<Result<InvocationDisposition, InvocationCallError>> {
    this.continuations.push(request);
    return { ok: true, value: this.onContinue(request.episode, request.response) };
  }
}

function completed(dispatch: InvocationDispatch, result: unknown): InvocationDisposition {
  return {
    kind: "completed",
    episode: dispatch.episode,
    result: result as never,
    session: {
      bindingIdentity: "session-binding.fixture" as never,
      affinity: dispatch.session,
      generation: 1,
    },
    interactionReceipts: [],
    journal: { identity: "journal.fixture" as never, episode: dispatch.episode },
  };
}

function actionActivation(): CompiledGraphActivation {
  return compiledActivation((draft) => {
    draft.initial.state.values = { prompt: "ship it" };
    draft.program.execution.actions["action.fixture"].inputSchema = {
      type: "object",
      required: ["prompt"],
      properties: { prompt: { type: "string" } },
      additionalProperties: false,
    };
    draft.program.execution.actions["action.fixture"].resultSchema = {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string" } },
      additionalProperties: false,
    };
    draft.program.dataflow.edges = [
      {
        source: { kind: "state", field: "prompt" },
        target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "property", name: "prompt" } },
      },
      {
        source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "property", name: "answer" } },
        target: { kind: "state", field: "answer" },
      },
    ];
  });
}

function workflowWaitActivation(): CompiledGraphActivation {
  return compiledActivation((draft) => {
    draft.program.control.entryNode = "node.wait";
    draft.program.control.nodes = [{ id: "node.wait", kind: "wait", wait: "approval", continuationSource: true }];
    draft.program.control.ordinarySuccessor = [];
    draft.program.control.decisions = [{
      identity: "decision.resume",
      source: { kind: "control-result", controlIdentity: "control.approval", slot: { kind: "property", name: "approved" } },
      selector: { kind: "case-map", cases: [{ value: true, target: "terminal.success" }, { value: false, target: "terminal.cancel" }] },
    }];
    draft.program.control.controls = [{
      identity: "control.approval",
      nodeIdentity: "node.wait",
      kind: "user",
      resultSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } }, additionalProperties: false },
      correlation: { identitySource: "deliveryIdentity", staleRejected: true, duplicateRejected: true },
      expiry: { mode: "incomplete", maxRenewals: 0 },
      resumeDecision: "decision.resume",
    }];
    draft.program.control.terminals = [
      { id: "terminal.success", kind: "success", meaning: "approved" },
      { id: "terminal.cancel", kind: "cancelled", meaning: "declined" },
    ];
    draft.program.execution.sites = [];
    draft.program.execution.actions = {};
    draft.program.execution.agents = {};
    draft.program.dataflow.edges = [{
      source: { kind: "state", field: "request" },
      target: { kind: "control-input", controlIdentity: "control.approval", slot: { kind: "whole" } },
    }];
    draft.initial.state.values = { request: { message: "approve" } };
  });
}

describe("LangGraph CoordinatorHost", () => {
  it("runs a compiled Action through real G01 plan indexes and real HostCustody ordering", async () => {
    const custody = new FakeCustody();
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, { answer: "done" }));
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });

    const result = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "terminal-proposal",
        proposal: {
          proposedOutcome: "COMPLETED",
          reason: "DECLARED_TERMINAL",
          result: { state: "known", value: { content: { prompt: "ship it", answer: "done" } } },
        },
      },
    });
    expect(invocation.dispatches).toHaveLength(1);
    expect(invocation.dispatches[0]?.input).toEqual({ prompt: "ship it" });
    expect(invocation.dispatches[0]?.workspace.kind).toBe("read");
    expect(custody.calls).toEqual(["baseline", "read", "settle:accept"]);
    if (result.ok && result.value.kind === "terminal-proposal") {
      expect(result.value.proposal.checkpoint.savepoint).toEqual(known(custody.next));
    }
  });

  it("integrates with the formal G02 GitCustody capability instead of a production custody fake", async () => {
    const workspace = gitWorkspace();
    const compiled = compiledActivation((draft) => {
      draft.initial.workspace.canonicalWorktreePath = workspace.directory;
      draft.initial.workspace.admittedGitTree = workspace.tree;
      draft.program.execution.agents["executor.fixture"].turn.access = [{ mode: "read", path: "README.md" }];
    });
    const custody = createGitCustody({ recordsDirectory: checkpointDirectory() as never });
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, {}));
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });

    const result = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });

    expect(result).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED" } } });
    expect(invocation.dispatches[0]?.workspace.kind).toBe("read");
    if (result.ok && result.value.kind === "terminal-proposal") {
      expect(result.value.proposal.checkpoint.savepoint).toMatchObject({ state: "known", value: { gitTree: workspace.tree } });
    }
  });

  it("dispatches the exact G01 plan and G02 signed capability through formal G03 ManagedInvocation", async () => {
    const compiled = compiledActivation((draft) => {
      draft.program.execution.agents["executor.fixture"].session.driver.configuration = {
        providerRoute: "deepseek",
        credentialRef: "DEEPSEEK_API_KEY",
      };
    });
    const root = checkpointDirectory();
    const provider: NativeProviderSessionFactory = {
      async open() {
        return {
          opaqueIdentity: "native.host-collaboration",
          async run() { return [{ kind: "structured-completion", result: { answer: "production-g03" } }]; },
          async persist() {},
          async cancel() {},
          async dispose() {},
        };
      },
      async restore() { throw new Error("fresh episode does not restore"); },
    };
    const managed = createManagedInvocation({
      providers: { "dsh-headless": provider },
      credentials: { async acquire() { return { material: { apiKey: "test-only" }, async release() {} }; } },
      journal: new FileInvocationJournalStore(path.join(root, "invocation-journals")),
      validateResult: () => true,
      authorizeRetirement: () => true,
    });
    const custody = new FakeCustody();
    let managedResult: unknown;
    const productionInvocation: HostInvocation = {
      start: async (dispatch, output) => {
        managedResult = await managed.host.start(dispatch, output);
        return managedResult as ReturnType<HostInvocation["start"]> extends Promise<infer Value> ? Value : never;
      },
      continueWithInput: (request, output) => managed.host.continueWithInput(request, output),
    };
    const host = createLangGraphCoordinatorHost({ invocation: productionInvocation, custody, checkpointDirectory: path.join(root, "host") });

    const result = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });

    expect(managedResult).toEqual({ ok: true, value: expect.objectContaining({ kind: "completed", result: { answer: "production-g03" } }) });
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED", result: { state: "known", value: { content: {} } } } },
    });
    expect(custody.settlements[0]?.hostDecision).toBe("accept");
  });

  it("rejects a malformed Action result before Custody accepts and before data edges commit", async () => {
    const custody = new FakeCustody();
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, { wrong: true }));
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });

    const result = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "terminal-proposal",
        proposal: {
          proposedOutcome: "FAILED",
          reason: "ACTION_FAILED",
          result: { state: "unknown", owner: "host" },
        },
      },
    });
    expect(custody.settlements[0]?.hostDecision).toBe("reject");
    const inspection = await host.inspect(result.ok && result.value.kind === "terminal-proposal"
      ? result.value.proposal.thread
      : ({} as never));
    expect(inspection).toMatchObject({ ok: true, value: { checkpoint: { state: "known" } } });
    expect(JSON.stringify(inspection)).not.toContain('"answer"');
  });

  it("does not commit a Host-accepted result when Custody independently rejects workspace scope", async () => {
    const custody = new FakeCustody();
    custody.settleResult = { kind: "scope-violation-restored", restoredSavepoint: custody.baseline };
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, { answer: "must-not-commit" }));
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });

    const result = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });

    expect(custody.settlements[0]?.hostDecision).toBe("accept");
    expect(result).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "FAILED", reason: "ACTION_FAILED", result: { state: "unknown" } } } });
    expect(JSON.stringify(result)).not.toContain("must-not-commit");
  });

  it("rejects an unmaterializable outgoing property before Custody forms a next savepoint", async () => {
    const compiled = compiledActivation((draft) => {
      draft.program.execution.actions["action.fixture"].resultSchema = { type: "object" };
      draft.program.dataflow.edges = [{
        source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "property", name: "optional" } },
        target: { kind: "state", field: "committed" },
      }];
    });
    const custody = new FakeCustody();
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation((dispatch) => completed(dispatch, {})),
      custody,
      checkpointDirectory: checkpointDirectory(),
    });

    const result = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });

    expect(custody.settlements[0]?.hostDecision).toBe("reject");
    expect(result).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "FAILED" } } });
  });

  it.each([
    ["allOf", { allOf: [{ type: "object" }, { required: ["ok"] }] }, { ok: true }, "COMPLETED"],
    ["anyOf", { anyOf: [{ type: "string" }, { type: "number" }] }, 4, "COMPLETED"],
    ["oneOf exactly one", { oneOf: [{ type: "string" }, { type: "number" }] }, "yes", "COMPLETED"],
    ["oneOf ambiguous", { oneOf: [{ type: "number" }, { type: "integer" }] }, 1, "FAILED"],
    ["const", { const: "exact" }, "other", "FAILED"],
    ["enum", { enum: ["a", "b"] }, "b", "COMPLETED"],
    ["null", { type: "null" }, null, "COMPLETED"],
    ["array items", { type: "array", items: { type: "integer" } }, [1, 2], "COMPLETED"],
    ["array item mismatch", { type: "array", items: { type: "integer" } }, [1, 2.5], "FAILED"],
    ["required", { type: "object", required: ["answer"] }, {}, "FAILED"],
    ["property", { type: "object", properties: { answer: { type: "boolean" } } }, { answer: "yes" }, "FAILED"],
    ["closed object", { type: "object", properties: { answer: { type: "boolean" } }, additionalProperties: false }, { answer: true, extra: true }, "FAILED"],
  ])("validates the admitted result schema construct %s before acceptance", async (_label, schema, invocationResult, outcome) => {
    const compiled = compiledActivation((draft) => {
      draft.program.execution.actions["action.fixture"].resultSchema = schema;
    });
    const custody = new FakeCustody();
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation((dispatch) => completed(dispatch, invocationResult)),
      custody,
      checkpointDirectory: checkpointDirectory(),
    });

    const result = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });

    expect(result).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: outcome } } });
    expect(custody.settlements[0]?.hostDecision).toBe(outcome === "COMPLETED" ? "accept" : "reject");
  });

  it("establishes baseline before a write handle and materializes a data-bound session affinity", async () => {
    const compiled = compiledActivation((draft) => {
      draft.initial.state.values = { goalIdentity: "goal.42" };
      draft.program.execution.agents["executor.fixture"].turn.access = [{ mode: "write", path: "src" }];
      draft.program.execution.agents["executor.fixture"].session.policy.scope = { kind: "data-bound", source: { kind: "state", field: "goalIdentity" } };
    });
    const custody = new FakeCustody();
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, {}));
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });

    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true });
    expect(custody.calls.slice(0, 2)).toEqual(["baseline", "write"]);
    expect(invocation.dispatches[0]?.workspace.kind).toBe("write");
    expect(invocation.dispatches[0]?.session.scopeValueIdentity).toBe(canonicalDigest("goal.42"));
  });

  it("uses no workspace capability when the admitted turn has no access", async () => {
    const compiled = compiledActivation((draft) => {
      draft.program.execution.agents["executor.fixture"].turn.access = [];
    });
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, {}));
    const host = createLangGraphCoordinatorHost({ invocation, custody: new FakeCustody(), checkpointDirectory: checkpointDirectory() });
    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true });
    expect(invocation.dispatches[0]?.workspace).toEqual({ kind: "none" });
  });

  it.each([
    ["baseline", (custody: FakeCustody) => { custody.baselineOk = false; }, (draft: any) => {}],
    ["read view", (custody: FakeCustody) => { custody.readOk = false; }, (draft: any) => {}],
    ["write handle", (custody: FakeCustody) => { custody.writeOk = false; }, (draft: any) => { draft.program.execution.agents["executor.fixture"].turn.access = [{ mode: "write", path: "src" }]; }],
  ])("fails closed when Custody cannot authorize %s", async (_label, arrangeCustody, mutate) => {
    const custody = new FakeCustody();
    arrangeCustody(custody);
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation((dispatch) => completed(dispatch, {})),
      custody,
      checkpointDirectory: checkpointDirectory(),
    });
    expect(await host.start(compiledActivation(mutate), { publish: async () => ({ ok: true, value: undefined }) })).toEqual({
      ok: false,
      error: { code: "CHECKPOINT_ORDER_VIOLATION" },
    });
  });

  it("executes a closed Host operation, its deterministic Gate and an immutable Artifact edge", async () => {
    const compiled = compiledActivation((draft) => {
      draft.initial.state.values = { input: "transform" };
      draft.program.execution.actions["action.fixture"].inputSchema = { type: "string" };
      draft.program.execution.actions["action.fixture"].resultSchema = { type: "object", required: ["artifact"] };
      draft.program.execution.actions["action.fixture"].gate.deterministic = ["validator.pass"];
      draft.program.execution.hostOperations["host.transform"] = {
        identity: "host.transform",
        contractIdentity: "host-contract.transform",
        configuration: { suffix: "!" },
        requiredCapabilities: ["deterministic-transformation"],
      };
      draft.program.execution.sites[0].executor = { kind: "host-operation", identity: "host.transform" };
      draft.program.execution.agents = {};
      draft.program.dataflow.edges = [
        { source: { kind: "state", field: "input" }, target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "whole" } } },
        { source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "property", name: "artifact" } }, target: { kind: "artifact", artifactIdentity: "artifact.output" } },
      ];
    });
    const invocation = new FakeInvocation(() => { throw new Error("Host operation must not invoke Provider"); });
    const host = createLangGraphCoordinatorHost({
      invocation,
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
      hostOperations: {
        "host-contract.transform": { execute: async (input, configuration) => ({ accepted: true, value: { artifact: `${input}${configuration.suffix}` } }) },
        "validator.pass": { execute: async (input) => ({ accepted: true, value: input }) },
      },
    });

    const result = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });

    expect(result).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { result: { state: "known", value: { artifacts: { "artifact.output": { contentIdentity: canonicalDigest("transform!") } } } } } } });
    expect(invocation.dispatches).toHaveLength(0);
  });

  it.each([
    ["missing operation handler", {}, "ACTIVATION_MISMATCH"],
    ["operation rejection", { "host-contract.transform": { execute: async () => ({ accepted: false, value: {} }) } }, undefined],
  ])("fails closed for %s", async (_label, hostOperations, expectedError) => {
    const compiled = compiledActivation((draft) => {
      draft.program.execution.hostOperations["host.transform"] = { identity: "host.transform", contractIdentity: "host-contract.transform", configuration: {}, requiredCapabilities: ["deterministic-transformation"] };
      draft.program.execution.sites[0].executor = { kind: "host-operation", identity: "host.transform" };
      draft.program.execution.agents = {};
    });
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation(() => { throw new Error("unexpected invocation"); }),
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
      hostOperations,
    });
    const result = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });
    if (expectedError !== undefined) expect(result).toEqual({ ok: false, error: { code: expectedError } });
    else expect(result).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "FAILED" } } });
  });

  it("allows a Host-operation selector to choose only one admitted target", async () => {
    const compiled = compiledActivation((draft) => {
      draft.program.control.entryNode = "node.wait";
      draft.program.control.nodes = [{ id: "node.wait", kind: "wait", wait: "choice", continuationSource: true }];
      draft.program.control.ordinarySuccessor = [];
      draft.program.control.decisions = [{
        identity: "decision.select",
        source: { kind: "control-result", controlIdentity: "control.choice", slot: { kind: "property", name: "choice" } },
        selector: { kind: "host-operation", operationIdentity: "host.select", allowedTargets: ["terminal.success"] },
      }];
      draft.program.control.controls = [{ identity: "control.choice", nodeIdentity: "node.wait", kind: "user", resultSchema: { type: "object", required: ["choice"] }, correlation: { identitySource: "deliveryIdentity", staleRejected: true, duplicateRejected: true }, expiry: { mode: "incomplete", maxRenewals: 0 }, resumeDecision: "decision.select" }];
      draft.program.execution.actions = {};
      draft.program.execution.sites = [];
      draft.program.execution.agents = {};
      draft.program.execution.hostOperations["host.select"] = { identity: "host.select", contractIdentity: "host-contract.select", configuration: {}, requiredCapabilities: ["deterministic-selection"] };
    });
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation(() => { throw new Error("Workflow Wait must not invoke"); }),
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
      hostOperations: { "host-contract.select": { execute: async () => ({ accepted: true, value: "terminal.success" }) } },
    });
    const started = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });
    if (!started.ok || started.value.kind !== "workflow-wait") throw new Error("expected Workflow Wait");
    const content = { choice: "ship" };
    expect(await host.resumeWorkflow({
      thread: started.value.wait.checkpoint.thread,
      result: { controlIdentity: started.value.wait.request.controlIdentity, correlationIdentity: started.value.wait.request.correlationIdentity, content, contentIdentity: canonicalDigest(content) },
    }, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED" } } });
  });

  it.each([
    ["missing site", (compiled: any) => { delete compiled.plan.execution.sites["node:node.action"]; }, "ACTIVATION_MISMATCH"],
    ["missing action", (compiled: any) => { delete compiled.plan.execution.actions["action.fixture"]; }, "ACTIVATION_MISMATCH"],
    ["missing input source", (compiled: any) => { compiled.plan.dataflow.incomingBySite["node:node.action"][0].source.field = "missing"; }, "DATAFLOW_BINDING_INVALID"],
    ["missing invocation plan", (compiled: any) => { delete compiled.plan.execution.agentInvocations["node:node.action"]; }, "ACTIVATION_MISMATCH"],
    ["missing successor", (compiled: any) => { delete compiled.plan.control.ordinarySuccessor["node.action"]; }, "ILLEGAL_SUCCESSOR"],
  ])("fails closed against a corrupted post-compile %s", async (_label, corrupt, code) => {
    const compiled = structuredClone(actionActivation()) as any;
    corrupt(compiled);
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation((dispatch) => completed(dispatch, { answer: "done" })),
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
    });
    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toEqual({ ok: false, error: { code } });
  });

  it("restores workspace and proposes Action failure when the Invocation call itself fails", async () => {
    const custody = new FakeCustody();
    const invocation: HostInvocation = {
      start: async () => ({ ok: false, error: { code: "PROVIDER_NOT_IMPLEMENTED" } }),
      continueWithInput: async () => ({ ok: false, error: { code: "SESSION_STATE_UNKNOWN" } }),
    };
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });
    expect(await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({
      ok: true,
      value: { kind: "terminal-proposal", proposal: { proposedOutcome: "FAILED", reason: "ACTION_FAILED" } },
    });
    expect(custody.settlements[0]?.hostDecision).toBe("reject");
  });

  it("routes Invocation failure through the exact declared nonretryable-failure edge", async () => {
    const compiled = compiledActivation((draft) => {
      draft.program.control.nodes.push({ id: "node.cleanup", kind: "cleanup", disposition: "failure", action: "action.cleanup" });
      draft.program.control.eventSuccessor = [{ id: "event.failure", from: "node.action", event: "nonretryable-failure", to: "node.cleanup" }];
      draft.program.control.ordinarySuccessor.push({ id: "edge.cleanup", from: "node.cleanup", to: "terminal.success" });
      draft.program.execution.actions["action.cleanup"] = { identity: "action.cleanup", purpose: "declared cleanup", inputSchema: { kind: "ABSENT" }, resultSchema: {}, gate: { freeTextBypass: "prohibited" } };
      draft.program.execution.sites.push({ site: { kind: "node", nodeIdentity: "node.cleanup" }, actionIdentity: "action.cleanup", executor: { kind: "agent", identity: "executor.fixture", requiredCapabilities: ["structured-completion"] } });
    });
    const invocation = new FakeInvocation((dispatch) => dispatch.episode.site.nodeIdentity === "node.action"
      ? ({ kind: "failed", episode: dispatch.episode, failure: { code: "PROVIDER_EXITED", retry: "never", detail: {} }, session: { state: "unknown", owner: "invocation", reason: "PROCESS_EXIT_UNOBSERVED" }, journal: { identity: "journal.failure", episode: dispatch.episode } } as InvocationDisposition)
      : completed(dispatch, {}));
    const host = createLangGraphCoordinatorHost({ invocation, custody: new FakeCustody(), checkpointDirectory: checkpointDirectory() });

    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({
      ok: true,
      value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED" } },
    });
    expect(invocation.dispatches.map((dispatch) => dispatch.episode.site.nodeIdentity)).toEqual(["node.action", "node.cleanup"]);
  });

  it("routes Host-operation rejection through the exact declared nonretryable-failure edge", async () => {
    const compiled = compiledActivation((draft) => {
      draft.program.control.nodes.push({ id: "node.cleanup", kind: "cleanup", disposition: "failure", action: "action.cleanup" });
      draft.program.control.eventSuccessor = [{ id: "event.failure", from: "node.action", event: "nonretryable-failure", to: "node.cleanup" }];
      draft.program.control.ordinarySuccessor.push({ id: "edge.cleanup", from: "node.cleanup", to: "terminal.success" });
      draft.program.execution.actions["action.cleanup"] = { identity: "action.cleanup", purpose: "declared cleanup", inputSchema: { kind: "ABSENT" }, resultSchema: {}, gate: { freeTextBypass: "prohibited" } };
      draft.program.execution.hostOperations["host.reject"] = { identity: "host.reject", contractIdentity: "host-contract.reject", configuration: {}, requiredCapabilities: ["deterministic-transformation"] };
      draft.program.execution.sites[0].executor = { kind: "host-operation", identity: "host.reject" };
      draft.program.execution.sites.push({ site: { kind: "node", nodeIdentity: "node.cleanup" }, actionIdentity: "action.cleanup", executor: { kind: "agent", identity: "executor.fixture", requiredCapabilities: ["structured-completion"] } });
    });
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, {}));
    const host = createLangGraphCoordinatorHost({
      invocation,
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
      hostOperations: { "host-contract.reject": { execute: async () => ({ accepted: false, value: {} }) } },
    });

    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({
      ok: true,
      value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED" } },
    });
    expect(invocation.dispatches.map((dispatch) => dispatch.episode.site.nodeIdentity)).toEqual(["node.cleanup"]);
  });

  it("fails closed when a corrupted event successor leaves the declared target universe", async () => {
    const compiled = structuredClone(actionActivation()) as any;
    compiled.plan.control.eventSuccessor["node.action"] = { "nonretryable-failure": "node.unknown" };
    const invocation: HostInvocation = {
      start: async () => ({ ok: false, error: { code: "PROVIDER_NOT_IMPLEMENTED" } }),
      continueWithInput: async () => ({ ok: false, error: { code: "SESSION_STATE_UNKNOWN" } }),
    };
    const host = createLangGraphCoordinatorHost({ invocation, custody: new FakeCustody(), checkpointDirectory: checkpointDirectory() });
    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toEqual({ ok: false, error: { code: "ILLEGAL_SUCCESSOR" } });
  });

  it.each([
    ["minimum", { type: "number", minimum: 5 }, 4],
    ["decimal multipleOf", { type: "number", multipleOf: 0.1 }, 0.31],
    ["pattern", { type: "string", pattern: "^[A-Z]+$" }, "lower"],
    ["not", { not: { const: "forbidden" } }, "forbidden"],
    ["unknown keyword", { type: "string", vendorConstraint: true }, "value"],
  ])("fails closed for exact JSON Schema constraint %s", async (_label, schema, resultValue) => {
    const compiled = compiledActivation((draft) => { draft.program.execution.actions["action.fixture"].resultSchema = schema; });
    const custody = new FakeCustody();
    const host = createLangGraphCoordinatorHost({ invocation: new FakeInvocation((dispatch) => completed(dispatch, resultValue)), custody, checkpointDirectory: checkpointDirectory() });
    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "FAILED" } } });
    expect(custody.settlements[0]?.hostDecision).toBe("reject");
  });

  it("accepts an exact decimal JSON Schema multiple", async () => {
    const compiled = compiledActivation((draft) => { draft.program.execution.actions["action.fixture"].resultSchema = { type: "number", multipleOf: 0.1 }; });
    const custody = new FakeCustody();
    const host = createLangGraphCoordinatorHost({ invocation: new FakeInvocation((dispatch) => completed(dispatch, 0.3)), custody, checkpointDirectory: checkpointDirectory() });
    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED" } } });
    expect(custody.settlements[0]?.hostDecision).toBe("accept");
  });

  it("validates the admitted JSON Schema vocabulary deterministically", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:g04:result",
      $anchor: "result",
      title: "Host result",
      description: "Exercises the admitted deterministic vocabulary",
      readOnly: true,
      $defs: { boundedEven: { type: "integer", multipleOf: 2, minimum: 2, maximum: 8, exclusiveMinimum: 0, exclusiveMaximum: 10 } },
      type: "object",
      minProperties: 7,
      maxProperties: 8,
      required: ["kind", "payload", "age", "name", "tags", "choice", "nullable"],
      properties: {
        kind: { enum: ["a", "b"] },
        payload: { type: "boolean" },
        age: { $ref: "#/$defs/boundedEven" },
        name: { allOf: [{ type: "string" }, { minLength: 2, maxLength: 8 }, { pattern: "^[A-Z]+$" }], not: { const: "FORBIDDEN" } },
        tags: { type: "array", minItems: 2, maxItems: 3, uniqueItems: true, prefixItems: [{ const: "A" }], items: { type: "string" }, contains: { const: "B" }, minContains: 1, maxContains: 1 },
        choice: { oneOf: [{ const: "x" }, { const: "y" }], anyOf: [{ type: "string" }, { type: "null" }] },
        nullable: { type: ["null", "string"] },
      },
      patternProperties: { "^x-": { type: "number" } },
      additionalProperties: false,
      propertyNames: { pattern: "^(kind|payload|age|name|tags|choice|nullable|x-extra)$" },
      dependentRequired: { kind: ["payload"] },
      if: { properties: { kind: { const: "a" } } },
      then: { properties: { payload: { const: true } } },
      else: { properties: { payload: { const: false } } },
    };
    const compiled = compiledActivation((draft) => { draft.program.execution.actions["action.fixture"].resultSchema = schema; });
    const value = { kind: "a", payload: true, age: 6, name: "ALPHA", tags: ["A", "B"], choice: "x", nullable: null, "x-extra": 1 };
    const custody = new FakeCustody();
    const host = createLangGraphCoordinatorHost({ invocation: new FakeInvocation((dispatch) => completed(dispatch, value)), custody, checkpointDirectory: checkpointDirectory() });
    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED" } } });
    expect(custody.settlements[0]?.hostDecision).toBe("accept");
  });

  it.each([
    ["annotation type", { $schema: 1 }],
    ["boolean annotation type", { readOnly: "yes" }],
    ["numeric constraint type", { minimum: "zero" }],
    ["multipleOf positivity", { multipleOf: 0 }],
    ["cardinality constraint", { minItems: -1 }],
    ["regular expression", { pattern: "[" }],
    ["empty type union", { type: [] }],
    ["unknown type", { type: "date" }],
    ["empty enum", { enum: [] }],
    ["examples array", { examples: "not-an-array" }],
    ["unresolved reference", { $ref: "#/missing" }],
    ["applicator array", { allOf: {} }],
    ["applicator schema", { not: 1 }],
    ["tuple schema", { prefixItems: {} }],
    ["items schema", { items: 1 }],
    ["additional property schema", { additionalProperties: 1 }],
    ["properties map", { properties: [] }],
    ["duplicate required keys", { required: ["x", "x"] }],
    ["dependent required map", { dependentRequired: { x: "y" } }],
  ])("fails closed for malformed JSON Schema definition: %s", async (_label, schema) => {
    const compiled = compiledActivation((draft) => { draft.program.execution.actions["action.fixture"].resultSchema = schema; });
    const custody = new FakeCustody();
    const host = createLangGraphCoordinatorHost({ invocation: new FakeInvocation((dispatch) => completed(dispatch, {})), custody, checkpointDirectory: checkpointDirectory() });
    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "FAILED" } } });
    expect(custody.settlements[0]?.hostDecision).toBe("reject");
  });

  it.each([
    ["known restore failure", known(new FakeCustody().baseline)],
    ["unknown restore state", { state: "unknown", owner: "custody", reason: "CALL_INTERRUPTED" }],
  ])("returns Intervention when Invocation failure cannot prove workspace restoration: %s", async (_label, state) => {
    const custody = new FakeCustody();
    custody.settleResult = { kind: "restore-failed", state } as CustodyAttemptDisposition;
    const invocation: HostInvocation = {
      start: async () => ({ ok: false, error: { code: "PROVIDER_NOT_IMPLEMENTED" } }),
      continueWithInput: async () => ({ ok: false, error: { code: "SESSION_STATE_UNKNOWN" } }),
    };
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });
    expect(await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true, value: { kind: "intervention", intervention: { reason: "INVARIANT_VIOLATION" } } });
  });

  it.each(["failed", "invalid", "unknown"])("treats Invocation %s as non-completion and rejects the workspace", async (kind) => {
    const custody = new FakeCustody();
    const invocation = new FakeInvocation((dispatch) => ({
      kind,
      episode: dispatch.episode,
      ...(kind === "failed" ? { failure: { code: "PROVIDER_EXITED", retry: "never", detail: {} }, session: { state: "unknown", owner: "invocation", reason: "PROCESS_EXIT_UNOBSERVED" }, journal: { identity: "journal.fixture", episode: dispatch.episode } }
        : kind === "invalid" ? { violation: { code: "TURN_ENDED_WITHOUT_DISPOSITION", detail: {} }, session: { bindingIdentity: "session.fixture", affinity: dispatch.session, generation: 1 }, journal: { identity: "journal.fixture", episode: dispatch.episode } }
          : { uncertainty: { state: "unknown", owner: "invocation", reason: "PROCESS_EXIT_UNOBSERVED" }, session: { state: "unknown", owner: "invocation", reason: "PROCESS_EXIT_UNOBSERVED" }, journal: { state: "unknown", owner: "invocation", reason: "PROCESS_EXIT_UNOBSERVED" } }),
    } as InvocationDisposition));
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });
    expect(await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "FAILED" } } });
    expect(custody.settlements[0]?.hostDecision).toBe("reject");
  });

  it.each([
    ["restore failure", { kind: "restore-failed", state: known(new FakeCustody().baseline) }],
    ["unknown savepoint", { kind: "accepted", nextSavepoint: { state: "unknown", owner: "custody", reason: "CALL_INTERRUPTED" } }],
  ])("returns Intervention for an uncertain Custody disposition: %s", async (_label, disposition) => {
    const custody = new FakeCustody();
    custody.settleResult = disposition as CustodyAttemptDisposition;
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation((dispatch) => completed(dispatch, { answer: "done" })),
      custody,
      checkpointDirectory: checkpointDirectory(),
    });
    expect(await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({
      ok: true,
      value: { kind: "intervention", intervention: { reason: "INVARIANT_VIOLATION" } },
    });
  });

  it("maps a declared cancelled terminal to an explicit CANCELLED proposal reason", async () => {
    const compiled = compiledActivation((draft) => {
      draft.program.control.ordinarySuccessor = [{ id: "edge.cancel", from: "node.action", to: "terminal.cancel" }];
      draft.program.control.terminals = [{ id: "terminal.cancel", kind: "cancelled", meaning: "cancelled" }];
    });
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation((dispatch) => completed(dispatch, {})),
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
    });

    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({
      ok: true,
      value: { kind: "terminal-proposal", proposal: { proposedOutcome: "CANCELLED", reason: "CANCELLED" } },
    });
  });

  it("persists Action input as a same-episode suspension and resumes through continueWithInput", async () => {
    const custody = new FakeCustody();
    const invocation = new FakeInvocation(
      (dispatch) => ({
        kind: "awaiting-input",
        episode: dispatch.episode,
        request: {
          identity: "interaction.fixture" as never,
          episode: dispatch.episode,
          prompt: { question: "approve?" },
          responseSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } },
        },
        session: { bindingIdentity: "session-binding.fixture" as never, affinity: dispatch.session, generation: 1 },
        journal: { identity: "journal.fixture" as never, episode: dispatch.episode },
      }),
      (episode) => completed({ ...invocation.dispatches[0]!, episode }, { answer: "done" }),
    );
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });

    const started = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });
    expect(started).toMatchObject({ ok: true, value: { kind: "action-input" } });
    if (!started.ok || started.value.kind !== "action-input") throw new Error("expected Action suspension");

    const resumed = await host.resumeAction({
      thread: started.value.wait.checkpoint.thread,
      episode: started.value.wait.episode,
      response: {
        requestIdentity: started.value.wait.request.identity,
        content: { approved: true },
        contentIdentity: canonicalDigest({ approved: true }),
      },
    }, { publish: async () => ({ ok: true, value: undefined }) });

    expect(resumed).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED" } } });
    expect(invocation.continuations).toHaveLength(1);
    expect(invocation.continuations[0]?.episode).toEqual(invocation.dispatches[0]?.episode);
    expect(custody.calls.filter((call) => call === "baseline")).toHaveLength(1);
  });

  it("rejects an Action response that fails the exact pending response schema before continuation", async () => {
    const custody = new FakeCustody();
    const invocation = new FakeInvocation((dispatch) => ({
      kind: "awaiting-input",
      episode: dispatch.episode,
      request: {
        identity: "interaction.schema" as never,
        episode: dispatch.episode,
        prompt: "approve?",
        responseSchema: {
          type: "object",
          required: ["approved"],
          properties: { approved: { type: "boolean" } },
          additionalProperties: false,
        },
      },
      session: { bindingIdentity: "session-binding.fixture" as never, affinity: dispatch.session, generation: 1 },
      journal: { identity: "journal.fixture" as never, episode: dispatch.episode },
    }));
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: checkpointDirectory() });
    const started = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });
    if (!started.ok || started.value.kind !== "action-input") throw new Error("expected Action suspension");

    const response = { approved: "yes" };
    const resumed = await host.resumeAction({
      thread: started.value.wait.checkpoint.thread,
      episode: started.value.wait.episode,
      response: {
        requestIdentity: started.value.wait.request.identity,
        content: response,
        contentIdentity: canonicalDigest(response),
      },
    }, { publish: async () => ({ ok: true, value: undefined }) });

    expect(resumed).toEqual({ ok: false, error: { code: "ACTION_INPUT_MISMATCH" } });
    expect(invocation.continuations).toHaveLength(0);
  });

  it("keeps Workflow Wait correlation and resume separate from Action input", async () => {
    const compiled = compiledActivation((draft) => {
      draft.program.control.entryNode = "node.wait";
      draft.program.control.nodes = [{ id: "node.wait", kind: "wait", wait: "approval", continuationSource: true }];
      draft.program.control.ordinarySuccessor = [];
      draft.program.control.decisions = [{
        identity: "decision.resume",
        source: { kind: "control-result", controlIdentity: "control.approval", slot: { kind: "property", name: "approved" } },
        selector: { kind: "case-map", cases: [{ value: true, target: "terminal.success" }, { value: false, target: "terminal.cancel" }] },
      }];
      draft.program.control.controls = [{
        identity: "control.approval",
        nodeIdentity: "node.wait",
        kind: "user",
        resultSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } }, additionalProperties: false },
        correlation: { identitySource: "deliveryIdentity", staleRejected: true, duplicateRejected: true },
        expiry: { mode: "incomplete", maxRenewals: 0 },
        resumeDecision: "decision.resume",
      }];
      draft.program.control.terminals = [
        { id: "terminal.success", kind: "success", meaning: "approved" },
        { id: "terminal.cancel", kind: "cancelled", meaning: "declined" },
      ];
      draft.program.execution.sites = [];
      draft.program.execution.actions = {};
      draft.program.execution.agents = {};
      draft.program.dataflow.edges = [{
        source: { kind: "state", field: "request" },
        target: { kind: "control-input", controlIdentity: "control.approval", slot: { kind: "whole" } },
      }];
      draft.initial.state.values = { request: { message: "approve" } };
    });
    const invocation = new FakeInvocation(() => { throw new Error("Workflow Wait must not invoke a Provider"); });
    const host = createLangGraphCoordinatorHost({ invocation, custody: new FakeCustody(), checkpointDirectory: checkpointDirectory() });

    const started = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });
    expect(started).toMatchObject({ ok: true, value: { kind: "workflow-wait", wait: { request: { content: { message: "approve" } } } } });
    if (!started.ok || started.value.kind !== "workflow-wait") throw new Error("expected Workflow Wait");
    const resumed = await host.resumeWorkflow({
      thread: started.value.wait.checkpoint.thread,
      result: {
        controlIdentity: started.value.wait.request.controlIdentity,
        correlationIdentity: started.value.wait.request.correlationIdentity,
        content: { approved: true },
        contentIdentity: canonicalDigest({ approved: true }),
      },
    }, { publish: async () => ({ ok: true, value: undefined }) });

    expect(resumed).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { proposedOutcome: "COMPLETED" } } });
    expect(invocation.dispatches).toHaveLength(0);
  });

  it.each([
    ["unknown thread", (request: any) => { request.thread.threadIdentity = "thread.unknown"; }],
    ["wrong control", (request: any) => { request.result.controlIdentity = "control.wrong"; }],
    ["wrong correlation", (request: any) => { request.result.correlationIdentity = "correlation.wrong"; }],
    ["stale digest", (request: any) => { request.result.contentIdentity = `sha256:${"0".repeat(64)}`; }],
    ["schema mismatch", (request: any) => { request.result.content = { approved: "yes" }; request.result.contentIdentity = canonicalDigest(request.result.content); }],
  ])("rejects Workflow Wait resume with %s before control-result effects", async (_label, mutate) => {
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation(() => { throw new Error("Workflow Wait must not invoke"); }),
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
    });
    const started = await host.start(workflowWaitActivation(), { publish: async () => ({ ok: true, value: undefined }) });
    if (!started.ok || started.value.kind !== "workflow-wait") throw new Error("expected Workflow Wait");
    const request: any = {
      thread: structuredClone(started.value.wait.checkpoint.thread),
      result: {
        controlIdentity: started.value.wait.request.controlIdentity,
        correlationIdentity: started.value.wait.request.correlationIdentity,
        content: { approved: true },
        contentIdentity: canonicalDigest({ approved: true }),
      },
    };
    mutate(request);
    expect(await host.resumeWorkflow(request, { publish: async () => ({ ok: true, value: undefined }) })).toEqual({ ok: false, error: { code: "CONTROL_MISMATCH" } });
  });

  it("rejects a control result whose admitted decision no longer yields a declared successor", async () => {
    const compiled = structuredClone(workflowWaitActivation()) as any;
    compiled.plan.control.decisions["decision.resume"].selector.cases = [];
    const host = createLangGraphCoordinatorHost({
      invocation: new FakeInvocation(() => { throw new Error("Workflow Wait must not invoke"); }),
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
    });
    const started = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });
    if (!started.ok || started.value.kind !== "workflow-wait") throw new Error("expected Workflow Wait");
    const content = { approved: true };
    expect(await host.resumeWorkflow({
      thread: started.value.wait.checkpoint.thread,
      result: {
        controlIdentity: started.value.wait.request.controlIdentity,
        correlationIdentity: started.value.wait.request.correlationIdentity,
        content,
        contentIdentity: canonicalDigest(content),
      },
    }, { publish: async () => ({ ok: true, value: undefined }) })).toEqual({ ok: false, error: { code: "ILLEGAL_SUCCESSOR" } });
  });

  it.each([
    ["default-all", undefined, ["branch.a", "branch.b"]],
    ["declared subset", ["branch.b"], ["branch.b"]],
  ])("runs a parallel selected barrier over %s branches and joins only after every selected result", async (_label, selection, expected) => {
    const compiled = compiledActivation((draft) => {
      draft.program.control.entryNode = "node.parallel";
      draft.program.control.nodes = [{
        id: "node.parallel",
        kind: "parallel",
        branches: [
          { id: "branch.a", action: "action.fixture", required: true },
          { id: "branch.b", action: "action.fixture", required: true },
        ],
        maxConcurrency: 2,
        ...(selection === undefined ? {} : { selection: { source: { kind: "state", field: "selected" } } }),
        join: { action: "action.join" },
      }];
      draft.program.control.ordinarySuccessor = [{ id: "edge.done", from: "node.parallel", to: "terminal.success" }];
      draft.program.execution.actions["action.fixture"].inputSchema = { kind: "ABSENT" };
      draft.program.execution.actions["action.fixture"].resultSchema = { type: "object" };
      draft.program.execution.actions["action.join"] = {
        identity: "action.join",
        purpose: "join selected branches",
        inputSchema: { type: "object" },
        resultSchema: { type: "object", required: ["selected"], properties: { selected: { type: "array", items: { type: "string" } } } },
        gate: { freeTextBypass: "prohibited" },
      };
      draft.program.execution.hostOperations["host.join"] = {
        identity: "host.join",
        contractIdentity: "host-contract.join",
        configuration: {},
        requiredCapabilities: ["deterministic-transformation"],
      };
      draft.program.execution.sites = [
        { site: { kind: "parallel-branch", nodeIdentity: "node.parallel", branchIdentity: "branch.a" }, actionIdentity: "action.fixture", executor: { kind: "agent", identity: "executor.fixture", requiredCapabilities: ["structured-completion"] } },
        { site: { kind: "parallel-branch", nodeIdentity: "node.parallel", branchIdentity: "branch.b" }, actionIdentity: "action.fixture", executor: { kind: "agent", identity: "executor.fixture", requiredCapabilities: ["structured-completion"] } },
        { site: { kind: "parallel-join", nodeIdentity: "node.parallel" }, actionIdentity: "action.join", executor: { kind: "host-operation", identity: "host.join" } },
      ];
      draft.program.dataflow.edges = [
        { source: { kind: "site-result", site: { kind: "parallel-branch", nodeIdentity: "node.parallel", branchIdentity: "branch.a" }, slot: { kind: "whole" } }, target: { kind: "site-input", site: { kind: "parallel-join", nodeIdentity: "node.parallel" }, slot: { kind: "property", name: "branch.a" } } },
        { source: { kind: "site-result", site: { kind: "parallel-branch", nodeIdentity: "node.parallel", branchIdentity: "branch.b" }, slot: { kind: "whole" } }, target: { kind: "site-input", site: { kind: "parallel-join", nodeIdentity: "node.parallel" }, slot: { kind: "property", name: "branch.b" } } },
        { source: { kind: "site-result", site: { kind: "parallel-join", nodeIdentity: "node.parallel" }, slot: { kind: "property", name: "selected" } }, target: { kind: "state", field: "joined" } },
      ];
      draft.initial.state.values = selection === undefined ? {} : { selected: selection };
    });
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, { branch: dispatch.episode.site.kind === "parallel-branch" ? dispatch.episode.site.branchIdentity : "unexpected" }));
    const host = createLangGraphCoordinatorHost({
      invocation,
      custody: new FakeCustody(),
      checkpointDirectory: checkpointDirectory(),
      hostOperations: {
        "host-contract.join": {
          execute: async (input) => ({ accepted: true, value: { selected: Object.keys(input as Record<string, unknown>).sort() } }),
        },
      },
    });

    const result = await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) });

    expect(result).toMatchObject({ ok: true, value: { kind: "terminal-proposal", proposal: { result: { state: "known", value: { content: { joined: expected } } } } } });
    expect(invocation.dispatches.map((dispatch) => dispatch.episode.site.kind === "parallel-branch" ? dispatch.episode.site.branchIdentity : "unexpected")).toEqual(expected);
  });

  it.each([[[]], [["branch.unknown"]], [["branch.a", "branch.a"]]])("fails closed before effects for invalid selected branch set %j", async (selected: string[]) => {
    const compiled = compiledActivation((draft) => {
      draft.program.control.entryNode = "node.parallel";
      draft.program.control.nodes = [{
        id: "node.parallel",
        kind: "parallel",
        branches: [{ id: "branch.a", action: "action.fixture", required: true }],
        maxConcurrency: 1,
        selection: { source: { kind: "state", field: "selected" } },
        join: {},
      }];
      draft.program.control.ordinarySuccessor[0].from = "node.parallel";
      draft.program.execution.sites[0].site = { kind: "parallel-branch", nodeIdentity: "node.parallel", branchIdentity: "branch.a" };
      draft.initial.state.values = { selected };
    });
    const invocation = new FakeInvocation((dispatch) => completed(dispatch, {}));
    const host = createLangGraphCoordinatorHost({ invocation, custody: new FakeCustody(), checkpointDirectory: checkpointDirectory() });

    expect(await host.start(compiled, { publish: async () => ({ ok: true, value: undefined }) })).toEqual({ ok: false, error: { code: "DATAFLOW_BINDING_INVALID" } });
    expect(invocation.dispatches).toHaveLength(0);
  });

  it("stops, inspects, recovers and retires only the exact host-owned thread", async () => {
    const custody = new FakeCustody();
    const invocation = new FakeInvocation((dispatch) => ({
      kind: "awaiting-input",
      episode: dispatch.episode,
      request: { identity: "interaction.fixture" as never, episode: dispatch.episode, prompt: "input", responseSchema: {} },
      session: { bindingIdentity: "session-binding.fixture" as never, affinity: dispatch.session, generation: 1 },
      journal: { identity: "journal.fixture" as never, episode: dispatch.episode },
    }));
    const directory = checkpointDirectory();
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: directory });
    const started = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });
    if (!started.ok || started.value.kind !== "action-input") throw new Error("expected suspension");
    const thread = started.value.wait.checkpoint.thread;

    expect(await host.stop({ thread, reason: "RECOVERY" })).toMatchObject({ ok: true, value: { state: { state: "known", value: "stopped" } } });
    expect(await host.inspect(thread)).toMatchObject({ ok: true, value: { pendingSite: { state: "known", value: { kind: "node" } } } });

    const replacement = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: directory });
    expect(await replacement.recover({
      thread,
      directive: "continue",
      checkpoint: known(started.value.wait.checkpoint),
      savepoint: started.value.wait.checkpoint.savepoint,
    })).toMatchObject({ ok: true, value: { kind: "action-input" } });

    const wrongAuthorization = {
      identity: "retirement.fixture",
      delivery: { ...thread.delivery, activationBindingIdentity: `sha256:${"0".repeat(64)}` },
    } as never;
    expect(await replacement.retire({ thread, authorization: wrongAuthorization })).toEqual({ ok: false, error: { code: "RETIREMENT_NOT_AUTHORIZED" } });
    const authorization = { identity: "retirement.fixture", delivery: thread.delivery } as never;
    const retired = await replacement.retire({ thread, authorization });
    expect(retired).toEqual({ ok: true, value: { owner: "host", authorization, state: "retired" } });
    expect(await replacement.inspect(thread)).toEqual({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
    const afterResponseLoss = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: directory });
    expect(await afterResponseLoss.retire({ thread, authorization })).toEqual(retired);
    const retirementDatabase = new DatabaseSync(path.join(directory, "host-checkpoints.sqlite"), { readOnly: true });
    const tombstone = retirementDatabase.prepare("SELECT phase, fact, cleanup_count FROM host_retirements").get() as { phase: string; fact: string; cleanup_count: number };
    retirementDatabase.close();
    expect({ phase: tombstone.phase, fact: JSON.parse(tombstone.fact), cleanupCount: tombstone.cleanup_count }).toEqual({
      phase: "complete",
      fact: { owner: "host", authorization, state: "retired" },
      cleanupCount: 1,
    });
    const mismatchedAuthorization = { identity: "retirement.other", delivery: thread.delivery } as never;
    expect(await afterResponseLoss.retire({ thread, authorization: mismatchedAuthorization })).toEqual({ ok: false, error: { code: "RETIREMENT_NOT_AUTHORIZED" } });
  });

  it("serializes concurrent retirement and replays one exact Host fact", async () => {
    const custody = new FakeCustody();
    const invocation = new FakeInvocation((dispatch) => ({
      kind: "awaiting-input",
      episode: dispatch.episode,
      request: { identity: "interaction.concurrent-retirement" as never, episode: dispatch.episode, prompt: "input", responseSchema: {} },
      session: { bindingIdentity: "session-binding.concurrent-retirement" as never, affinity: dispatch.session, generation: 1 },
      journal: { identity: "journal.concurrent-retirement" as never, episode: dispatch.episode },
    }));
    const directory = checkpointDirectory();
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: directory });
    const overlappingHost = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: directory });
    const started = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });
    if (!started.ok || started.value.kind !== "action-input") throw new Error("expected suspension");
    const thread = started.value.wait.checkpoint.thread;
    const authorization = { identity: "retirement.concurrent", delivery: thread.delivery } as never;
    const mismatchedAuthorization = { identity: "retirement.concurrent-other", delivery: thread.delivery } as never;

    const first = host.retire({ thread, authorization });
    const exactReplay = overlappingHost.retire({ thread, authorization });
    const mismatch = overlappingHost.retire({ thread, authorization: mismatchedAuthorization });

    const [firstResult, replayResult, mismatchResult] = await Promise.all([first, exactReplay, mismatch]);
    expect(firstResult).toEqual({ ok: true, value: { owner: "host", authorization, state: "retired" } });
    expect(replayResult).toEqual(firstResult);
    expect(mismatchResult).toEqual({ ok: false, error: { code: "RETIREMENT_NOT_AUTHORIZED" } });
    expect(await host.inspect(thread)).toEqual({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
    const retirementDatabase = new DatabaseSync(path.join(directory, "host-checkpoints.sqlite"), { readOnly: true });
    expect(retirementDatabase.prepare("SELECT cleanup_count FROM host_retirements").get()).toEqual({ cleanup_count: 1 });
    retirementDatabase.close();
  });

  it("recovers a durable pending retirement claim for the exact thread", async () => {
    const custody = new FakeCustody();
    const invocation = new FakeInvocation((dispatch) => ({
      kind: "awaiting-input",
      episode: dispatch.episode,
      request: { identity: "interaction.pending-retirement" as never, episode: dispatch.episode, prompt: "input", responseSchema: {} },
      session: { bindingIdentity: "session-binding.pending-retirement" as never, affinity: dispatch.session, generation: 1 },
      journal: { identity: "journal.pending-retirement" as never, episode: dispatch.episode },
    }));
    const directory = checkpointDirectory();
    const host = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: directory });
    const started = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });
    if (!started.ok || started.value.kind !== "action-input") throw new Error("expected suspension");
    const thread = started.value.wait.checkpoint.thread;
    const authorization = { identity: "retirement.pending", delivery: thread.delivery } as never;
    const retirementDatabase = new DatabaseSync(path.join(directory, "host-checkpoints.sqlite"));
    retirementDatabase.prepare("INSERT INTO host_retirements (thread_key, thread_id, authorization, phase, fact, cleanup_count) VALUES (?, ?, ?, 'retiring', NULL, 0)")
      .run(canonicalDigest(thread), thread.threadIdentity, JSON.stringify(authorization));
    retirementDatabase.close();

    const recoveringHost = createLangGraphCoordinatorHost({ invocation, custody, checkpointDirectory: directory });
    expect(await recoveringHost.retire({ thread, authorization })).toEqual({ ok: true, value: { owner: "host", authorization, state: "retired" } });
    expect(await recoveringHost.inspect(thread)).toEqual({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
    const verificationDatabase = new DatabaseSync(path.join(directory, "host-checkpoints.sqlite"), { readOnly: true });
    expect(verificationDatabase.prepare("SELECT phase, cleanup_count FROM host_retirements").get()).toEqual({ phase: "complete", cleanup_count: 1 });
    verificationDatabase.close();
  });

  it("fails closed for unknown inspection/stop and stale recovery facts, and admits explicit intervention", async () => {
    const invocation = new FakeInvocation((dispatch) => ({
      kind: "awaiting-input",
      episode: dispatch.episode,
      request: { identity: "interaction.recovery" as never, episode: dispatch.episode, prompt: "input", responseSchema: {} },
      session: { bindingIdentity: "session.recovery" as never, affinity: dispatch.session, generation: 1 },
      journal: { identity: "journal.recovery" as never, episode: dispatch.episode },
    }));
    const host = createLangGraphCoordinatorHost({ invocation, custody: new FakeCustody(), checkpointDirectory: checkpointDirectory() });
    const started = await host.start(actionActivation(), { publish: async () => ({ ok: true, value: undefined }) });
    if (!started.ok || started.value.kind !== "action-input") throw new Error("expected suspension");
    const thread = started.value.wait.checkpoint.thread;
    const unknownThread = { ...thread, threadIdentity: "thread.unknown" } as never;
    expect(await host.inspect(unknownThread)).toEqual({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
    expect(await host.stop({ thread: unknownThread, reason: "RECOVERY" })).toEqual({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
    expect(await host.recover({
      thread,
      directive: "continue",
      checkpoint: known({ ...started.value.wait.checkpoint, stateIdentity: `sha256:${"0".repeat(64)}` }),
      savepoint: started.value.wait.checkpoint.savepoint,
    })).toEqual({ ok: false, error: { code: "RECOVERY_NOT_ADMITTED" } });
    expect(await host.recover({
      thread,
      directive: "restart-from-savepoint",
      checkpoint: known(started.value.wait.checkpoint),
      savepoint: { state: "unknown", owner: "host", reason: "CHECKPOINT_DISPOSITION_UNOBSERVED" },
    })).toEqual({ ok: false, error: { code: "RECOVERY_NOT_ADMITTED" } });
    expect(await host.recover({
      thread,
      directive: "intervene",
      checkpoint: known(started.value.wait.checkpoint),
      savepoint: started.value.wait.checkpoint.savepoint,
    })).toMatchObject({ ok: true, value: { kind: "intervention", intervention: { reason: "RECOVERY_EXHAUSTED" } } });
  });
});
