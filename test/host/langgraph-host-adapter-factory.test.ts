import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileRunnerActivation } from "../../src/interpreter/compile-runner-activation.js";
import { createGitCustody } from "../../src/custody/git-custody.js";
import { FileInvocationJournalStore, createManagedInvocation } from "../../src/invocation/index.js";
import type { HostCustody, HostInvocation } from "../../src/contracts/index.js";
import {
  LangGraphWorkflowHostAdapterFactory,
  type LangGraphWorkflowHostConfiguration,
} from "../../src/host/index.js";
import { mutatedRunnerActivation } from "../support/runner-activation-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "langgraph-host-factory-"));
  roots.push(root);
  return root;
}

const invocation = Object.freeze({
  async start() { throw new Error("creation must not start a Delivery"); },
  async continueWithInput() { throw new Error("creation must not resume a Delivery"); },
}) as unknown as HostInvocation;

const custody = Object.freeze({
  async establishBaseline() { throw new Error("creation must not establish a baseline"); },
  async acquireWriteHandle() { throw new Error("creation must not acquire a write handle"); },
  async openReadView() { throw new Error("creation must not open a read view"); },
  async settleWorkspaceAttempt() { throw new Error("creation must not settle a workspace"); },
  async validateReadView() { throw new Error("creation must not validate a read view"); },
}) as HostCustody;

function exactConfiguration(checkpointDirectory: string): LangGraphWorkflowHostConfiguration {
  return Object.freeze({ engine: "langgraph", checkpointDirectory });
}

describe("LangGraph Workflow Host Adapter Factory", () => {
  it("creates a new Host and its private checkpoint substrate from one exact immutable configuration", async () => {
    const root = temporaryRoot();
    const checkpointDirectory = path.join(root, "checkpoints");
    const configuration = exactConfiguration(checkpointDirectory);
    const factory = new LangGraphWorkflowHostAdapterFactory();

    const host = await factory.create(configuration, Object.freeze({ invocation, custody }));

    expect(factory.engine).toBe("langgraph");
    expect(host).toEqual(expect.objectContaining({
      start: expect.any(Function),
      resumeWorkflow: expect.any(Function),
      resumeAction: expect.any(Function),
      stop: expect.any(Function),
      inspect: expect.any(Function),
      recover: expect.any(Function),
      retire: expect.any(Function),
    }));
    expect(existsSync(path.join(checkpointDirectory, "host-checkpoints.sqlite"))).toBe(true);
    expect(configuration).toEqual({ engine: "langgraph", checkpointDirectory });
  });

  it.each([
    ["unknown engine", Object.freeze({ engine: "ambient-host", checkpointDirectory: "/tmp/unused" }), "WORKFLOW_HOST_FACTORY_SELECTION_MISMATCH"],
    ["mutable configuration", { engine: "langgraph", checkpointDirectory: "/tmp/unused" }, "WORKFLOW_HOST_CONFIGURATION_INVALID"],
    ["inexact extra key", Object.freeze({ engine: "langgraph", checkpointDirectory: "/tmp/unused", fallback: "ambient-host" }), "WORKFLOW_HOST_CONFIGURATION_INVALID"],
    ["relative checkpoint root", Object.freeze({ engine: "langgraph", checkpointDirectory: "relative/checkpoints" }), "WORKFLOW_HOST_CONFIGURATION_INVALID"],
  ])("fails closed before startup for %s", async (_label, candidate, code) => {
    const factory = new LangGraphWorkflowHostAdapterFactory();

    await expect(factory.create(candidate as never, Object.freeze({ invocation, custody }))).rejects.toMatchObject({ code });
  });

  it("rejects accessor, symbol and custom-prototype configuration without invoking accessors", async () => {
    const factory = new LangGraphWorkflowHostAdapterFactory();
    let accessorReads = 0;
    const accessorConfiguration = Object.freeze(Object.defineProperties({}, {
      engine: { enumerable: true, get() { accessorReads += 1; return "langgraph"; } },
      checkpointDirectory: { enumerable: true, value: "/tmp/unused" },
    }));
    const symbolConfiguration = Object.freeze({ engine: "langgraph", checkpointDirectory: "/tmp/unused", [Symbol("fallback")]: "ambient" });
    const prototypeConfiguration = Object.freeze(Object.assign(Object.create({ fallback: "ambient" }), {
      engine: "langgraph",
      checkpointDirectory: "/tmp/unused",
    }));

    for (const candidate of [accessorConfiguration, symbolConfiguration, prototypeConfiguration]) {
      await expect(factory.create(candidate as never, Object.freeze({ invocation, custody }))).rejects.toMatchObject({ code: "WORKFLOW_HOST_CONFIGURATION_INVALID" });
    }
    expect(accessorReads).toBe(0);
  });

  it("rejects a preconstructed Host or any other inexact assembly capability", async () => {
    const root = temporaryRoot();
    const factory = new LangGraphWorkflowHostAdapterFactory();
    const preconstructed = { start: async () => { throw new Error("must not be selected"); } };

    await expect(factory.create(
      exactConfiguration(path.join(root, "checkpoints")),
      Object.freeze({ invocation, custody, host: preconstructed }) as never,
    )).rejects.toMatchObject({ code: "WORKFLOW_HOST_CONFIGURATION_INVALID" });
    expect(existsSync(path.join(root, "checkpoints"))).toBe(false);
  });

  it("rejects incomplete assembly capabilities before publishing a partial Host", async () => {
    const root = temporaryRoot();
    const factory = new LangGraphWorkflowHostAdapterFactory();

    await expect(factory.create(
      exactConfiguration(path.join(root, "checkpoints")),
      Object.freeze({ invocation: {}, custody }) as never,
    )).rejects.toMatchObject({ code: "WORKFLOW_HOST_CONFIGURATION_INVALID" });
    expect(existsSync(path.join(root, "checkpoints"))).toBe(false);
  });

  it("rejects inexact dependency containers without reading accessors", async () => {
    const factory = new LangGraphWorkflowHostAdapterFactory();
    let reads = 0;
    const accessorDependencies = Object.defineProperties(Object.create({ fallback: "ambient" }), {
      invocation: { enumerable: true, get() { reads += 1; return invocation; } },
      custody: { enumerable: true, value: custody },
    });
    const symbolDependencies = { invocation, custody, [Symbol("fallback")]: "ambient" };
    const prototypeDependencies = Object.assign(Object.create({ fallback: "ambient" }), { invocation, custody });

    for (const candidate of [accessorDependencies, symbolDependencies, prototypeDependencies]) {
      await expect(factory.create(exactConfiguration("/tmp/unused"), candidate as never)).rejects.toMatchObject({
        code: "WORKFLOW_HOST_CONFIGURATION_INVALID",
      });
    }
    expect(reads).toBe(0);
  });

  it("rejects accessor, inherited, symbol and extra Invocation or Custody capabilities without reading accessors", async () => {
    const factory = new LangGraphWorkflowHostAdapterFactory();
    let reads = 0;
    const accessorInvocation = Object.defineProperties(Object.create({ fallback: "ambient" }), {
      start: { enumerable: true, get() { reads += 1; return invocation.start; } },
      continueWithInput: { enumerable: true, value: invocation.continueWithInput },
    });
    const inheritedInvocation = Object.create(invocation);
    const symbolInvocation = { ...invocation, [Symbol("fallback")]: "ambient" };
    const extraInvocation = { ...invocation, inspect: async () => undefined };
    const accessorCustody = Object.defineProperties(Object.create({ fallback: "ambient" }), {
      establishBaseline: { enumerable: true, get() { reads += 1; return custody.establishBaseline; } },
      acquireWriteHandle: { enumerable: true, value: custody.acquireWriteHandle },
      openReadView: { enumerable: true, value: custody.openReadView },
      settleWorkspaceAttempt: { enumerable: true, value: custody.settleWorkspaceAttempt },
      validateReadView: { enumerable: true, value: custody.validateReadView },
    });
    const inheritedCustody = Object.create(custody);
    const symbolCustody = { ...custody, [Symbol("fallback")]: "ambient" };
    const extraCustody = { ...custody, inspect: async () => undefined };

    for (const candidate of [accessorInvocation, inheritedInvocation, symbolInvocation, extraInvocation]) {
      await expect(factory.create(exactConfiguration("/tmp/unused"), { invocation: candidate, custody } as never)).rejects.toMatchObject({
        code: "WORKFLOW_HOST_CONFIGURATION_INVALID",
      });
    }
    for (const candidate of [accessorCustody, inheritedCustody, symbolCustody, extraCustody]) {
      await expect(factory.create(exactConfiguration("/tmp/unused"), { invocation, custody: candidate } as never)).rejects.toMatchObject({
        code: "WORKFLOW_HOST_CONFIGURATION_INVALID",
      });
    }
    expect(reads).toBe(0);
  });

  it("rejects inexact Host-operation catalogs and handlers without reading accessors", async () => {
    const factory = new LangGraphWorkflowHostAdapterFactory();
    const handler = { async execute() { return { accepted: true, value: null }; } };
    let catalogReads = 0;
    let handlerReads = 0;
    const accessorCatalog = Object.defineProperty(Object.create({ fallback: handler }), "operation.fixture", {
      enumerable: true,
      get() { catalogReads += 1; return handler; },
    });
    const prototypeCatalog = Object.assign(Object.create({ fallback: handler }), { "operation.fixture": handler });
    const symbolCatalog = { "operation.fixture": handler, [Symbol("fallback")]: handler };
    const accessorHandler = Object.defineProperty(Object.create({ fallback: "ambient" }), "execute", {
      enumerable: true,
      get() { handlerReads += 1; return handler.execute; },
    });
    const inheritedHandler = Object.create(handler);
    const symbolHandler = { ...handler, [Symbol("fallback")]: "ambient" };
    const extraHandler = { ...handler, priority: 1 };

    for (const candidate of [accessorCatalog, prototypeCatalog, symbolCatalog]) {
      await expect(factory.create(exactConfiguration("/tmp/unused"), { invocation, custody, hostOperations: candidate } as never)).rejects.toMatchObject({
        code: "WORKFLOW_HOST_CONFIGURATION_INVALID",
      });
    }
    for (const candidate of [accessorHandler, inheritedHandler, symbolHandler, extraHandler]) {
      await expect(factory.create(exactConfiguration("/tmp/unused"), {
        invocation,
        custody,
        hostOperations: { "operation.fixture": candidate },
      } as never)).rejects.toMatchObject({ code: "WORKFLOW_HOST_CONFIGURATION_INVALID" });
    }
    expect(catalogReads).toBe(0);
    expect(handlerReads).toBe(0);
  });

  it("accepts real G02 and G03 producer capabilities through exact composition facades", async () => {
    const root = temporaryRoot();
    const managed = createManagedInvocation({
      providers: {},
      credentials: { async acquire() { throw new Error("creation must not acquire credentials"); } },
      journal: new FileInvocationJournalStore(path.join(root, "journals")),
      resultValidator: { validate: () => true },
    });
    const gitCustody = createGitCustody({ recordsDirectory: path.join(root, "custody") as never });
    const invocationFacade: HostInvocation = Object.freeze({
      start: managed.host.start.bind(managed.host),
      continueWithInput: managed.host.continueWithInput.bind(managed.host),
    });
    const custodyFacade: HostCustody = Object.freeze({
      establishBaseline: gitCustody.establishBaseline.bind(gitCustody),
      acquireWriteHandle: gitCustody.acquireWriteHandle.bind(gitCustody),
      openReadView: gitCustody.openReadView.bind(gitCustody),
      settleWorkspaceAttempt: gitCustody.settleWorkspaceAttempt.bind(gitCustody),
      validateReadView: gitCustody.validateReadView.bind(gitCustody),
    });
    const factory = new LangGraphWorkflowHostAdapterFactory();

    await expect(factory.create(
      exactConfiguration(path.join(root, "checkpoints")),
      Object.freeze({ invocation: invocationFacade, custody: custodyFacade }),
    )).resolves.toEqual(expect.objectContaining({ start: expect.any(Function) }));
  });

  it("snapshots the exact Host-operation implementation at creation and forbids in-flight substitution", async () => {
    const root = temporaryRoot();
    const runtimeCustody = Object.freeze({
      ...custody,
      async establishBaseline() {
        return { ok: true, value: { deliveryIdentity: "delivery.fixture", savepointIdentity: "savepoint.factory", gitTree: "tree.fixture" } };
      },
    }) as unknown as HostCustody;
    const handler = {
      async execute() { return { accepted: true, value: { marker: "original" } }; },
    };
    const factory = new LangGraphWorkflowHostAdapterFactory();
    const host = await factory.create(
      exactConfiguration(path.join(root, "checkpoints")),
      Object.freeze({ invocation, custody: runtimeCustody, hostOperations: { "host-contract.factory": handler } }),
    );
    handler.execute = async () => ({ accepted: true, value: { marker: "substituted" } });
    const activation = mutatedRunnerActivation((draft) => {
      draft.program.execution.actions["action.fixture"].resultSchema = { type: "object", required: ["marker"] };
      draft.program.execution.hostOperations["host.factory"] = {
        identity: "host.factory",
        contractIdentity: "host-contract.factory",
        configuration: {},
        requiredCapabilities: ["deterministic-transformation"],
      };
      draft.program.execution.sites[0].executor = { kind: "host-operation", identity: "host.factory" };
      draft.program.execution.agents = {};
      draft.program.dataflow.edges = [{
        source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "property", name: "marker" } },
        target: { kind: "state", field: "marker" },
      }];
    });
    const compiled = compileRunnerActivation(activation);
    if (!compiled.ok) throw new Error(`factory fixture did not compile: ${compiled.error.code}`);

    expect(await host.start(compiled.value, { publish: async () => ({ ok: true, value: undefined }) })).toMatchObject({
      ok: true,
      value: { kind: "terminal-proposal", proposal: { result: { state: "known", value: { content: { marker: "original" } } } } },
    });
  });

  it("reports exact LangGraph startup failure without fallback or partial Host publication", async () => {
    const root = temporaryRoot();
    const occupiedPath = path.join(root, "occupied");
    writeFileSync(occupiedPath, "not a directory", "utf8");
    const factory = new LangGraphWorkflowHostAdapterFactory();

    await expect(factory.create(
      exactConfiguration(occupiedPath),
      Object.freeze({ invocation, custody }),
    )).rejects.toMatchObject({ code: "WORKFLOW_HOST_ADAPTER_STARTUP_FAILED", engine: "langgraph" });
  });
});
