import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentProviderRunnerFactory,
  canonicalDigest,
  RunnerFactory,
  type AgentProviderRunnerFactoryConfig,
  type AgentProviderSessionOpenRequest,
  type AgentProviderSessionFactory,
  type RunnerFactoryConfig,
} from "../../src/index.js";
import { mutatedRunnerActivation } from "../support/runner-activation-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureConfig(): Promise<RunnerFactoryConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "runner-factory-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "runner fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  const credentialPath = path.join(root, "credentials.yml");
  await writeFile(credentialPath, "version: 1\nrefs:\n  WALKING_SKELETON_KEY: synthetic-secret\n", "utf8");
  await chmod(credentialPath, 0o600);

  return Object.freeze({
    schemaVersion: "runner.factory@1.0.0",
    stateDirectory: path.join(root, "coordinator"),
    custody: Object.freeze({
      recordsDirectory: path.join(root, "custody"),
      publication: Object.freeze({
        targetIdentity: "publication-target.walking-skeleton",
        repositoryPath: workspace,
        ref: "refs/heads/candidate",
      }),
    }),
    provider: Object.freeze({
      key: "dsh-headless",
      configuration: Object.freeze({
        providerIdentity: "dsh-headless",
        workspaceDirectory: workspace,
        sessionStorageDirectory: path.join(root, "sessions"),
        credentialStore: Object.freeze({ path: credentialPath, watch: false }),
        maxParallelToolCalls: 1,
      }),
    }),
    invocation: Object.freeze({ journalDirectory: path.join(root, "journals") }),
    host: Object.freeze({ engine: "langgraph", checkpointDirectory: path.join(root, "checkpoints") }),
    implementationIdentity: "implementation.runner.langgraph-dsh",
  });
}

const dependencies = Object.freeze({
  interaction: Object.freeze({
    async publish() { return { ok: true as const, value: undefined }; },
    async requestInput() { throw new Error("walking skeleton does not request Action input"); },
  }),
  workflow: Object.freeze({
    async request() { throw new Error("walking skeleton does not enter Workflow Wait"); },
  }),
  observation: Object.freeze({ async observe() {} }),
  startCorrelation: Object.freeze({ async acknowledge() { return { ok: true as const, value: undefined }; } }),
  hostOperations: Object.freeze({}),
});

describe("RunnerFactory", () => {
  it("creates one exact public ExecutionRuntimeAdapter from closed immutable configuration", async () => {
    const factory = new RunnerFactory();
    const config = await fixtureConfig();

    const adapter = await factory.create(config, dependencies);

    expect(Object.keys(adapter).sort()).toEqual(["cancel", "execute", "inspect"]);
    expect(config).toEqual(expect.objectContaining({
      schemaVersion: "runner.factory@1.0.0",
      provider: { key: "dsh-headless", configuration: expect.any(Object) },
      host: { engine: "langgraph", checkpointDirectory: expect.any(String) },
    }));
    await factory.dispose(adapter);
    await factory.dispose(adapter);
  });

  it("fails closed for unknown Provider selection without fallback", async () => {
    const factory = new RunnerFactory();
    const config = await fixtureConfig();
    const unknown = Object.freeze({
      ...config,
      provider: Object.freeze({ ...config.provider, key: "copilot-sdk" }),
    });

    await expect(factory.create(unknown as never, dependencies)).rejects.toMatchObject({
      code: "RUNNER_FACTORY_SELECTION_MISMATCH",
    });
  });

  it("rejects nested accessors without invoking them", async () => {
    const factory = new RunnerFactory();
    const config = await fixtureConfig();
    let reads = 0;
    const provider = Object.freeze(Object.defineProperties({}, {
      key: { enumerable: true, get() { reads += 1; return "dsh-headless"; } },
      configuration: { enumerable: true, value: config.provider.configuration },
    }));
    const candidate = Object.freeze({ ...config, provider });

    await expect(factory.create(candidate as never, dependencies)).rejects.toMatchObject({
      code: "RUNNER_FACTORY_CONFIGURATION_INVALID",
    });
    expect(reads).toBe(0);
  });

  it("rejects an accessor-backed Host operation catalog before creating a Provider", async () => {
    const factory = new RunnerFactory();
    const config = await fixtureConfig();
    let reads = 0;
    const hostOperations = Object.freeze(Object.defineProperty({}, "validator.test", {
      enumerable: true,
      get() { reads += 1; return Object.freeze({ async execute() { return { accepted: true, value: null }; } }); },
    }));

    await expect(factory.create(config, Object.freeze({ ...dependencies, hostOperations }) as never)).rejects.toMatchObject({
      code: "RUNNER_FACTORY_CONFIGURATION_INVALID",
    });
    expect(reads).toBe(0);
  });

  it("requires the externally wired one-way Observation port", async () => {
    const factory = new RunnerFactory();
    const config = await fixtureConfig();
    const { observation: _observation, ...missing } = dependencies;
    await expect(factory.create(config, Object.freeze(missing) as never)).rejects.toMatchObject({
      code: "RUNNER_FACTORY_CONFIGURATION_INVALID",
    });
  });

  it("contains exact Provider startup failure and publishes no adapter", async () => {
    const factory = new RunnerFactory();
    const config = await fixtureConfig();
    await writeFile(config.provider.configuration.credentialStore.path, "not: [valid", "utf8");

    await expect(factory.create(config, dependencies)).rejects.toMatchObject({
      code: "RUNNER_FACTORY_STARTUP_FAILED",
    });
  });
});

describe("AgentProviderRunnerFactory", () => {
  it("runs one Delivery through two exact Role-owned Provider realms and releases their shared owner", async () => {
    const historical = await fixtureConfig();
    const config: AgentProviderRunnerFactoryConfig = Object.freeze({
      schemaVersion: "runner.factory@2.0.0",
      stateDirectory: historical.stateDirectory,
      custody: historical.custody,
      invocation: historical.invocation,
      host: historical.host,
      implementationIdentity: "implementation.runner.langgraph-agent-providers",
    });
    const openedRoles: string[] = [];
    const provider = (identity: "copilot-sdk" | "codex-cli"): AgentProviderSessionFactory => Object.freeze({
      async open({ dispatch }: AgentProviderSessionOpenRequest) {
        openedRoles.push(`${identity}:${dispatch.executor.session.roleIdentity}`);
        return Object.freeze({
          opaqueIdentity: `${identity}:${dispatch.executor.session.roleIdentity}`,
          async run() { return Object.freeze([{ kind: "structured-completion" as const, result: Object.freeze({}) }]); },
          async persist() {},
          async cancel() {},
          async dispose() {},
        });
      },
      async restore() { throw new Error("not used"); },
    });
    let ownerDisposals = 0;
    const factory = new AgentProviderRunnerFactory();
    const activation = mutatedRunnerActivation((draft) => {
      const first = structuredClone(draft.program.execution.agents["executor.fixture"]);
      first.identity = "executor.copilot";
      first.session.roleIdentity = "role.copilot";
      first.session.driver.providerIdentity = "copilot-sdk";
      first.turn.access = [{ mode: "read", path: "README.md" }];
      first.sessionCompatibilityIdentity = canonicalDigest(first.session);
      first.bindingIdentity = canonicalDigest({ session: first.session, turn: first.turn });
      const second = structuredClone(first);
      second.identity = "executor.codex";
      second.session.roleIdentity = "role.codex";
      second.session.driver.providerIdentity = "codex-cli";
      second.sessionCompatibilityIdentity = canonicalDigest(second.session);
      second.bindingIdentity = canonicalDigest({ session: second.session, turn: second.turn });
      draft.program.control.nodes = [
        { id: "node.copilot", kind: "action", action: "action.copilot" },
        { id: "node.codex", kind: "action", action: "action.codex" },
      ];
      draft.program.control.entryNode = "node.copilot";
      draft.program.control.ordinarySuccessor = [
        { id: "edge.codex", from: "node.copilot", to: "node.codex" },
        { id: "edge.done", from: "node.codex", to: "terminal.success" },
      ];
      draft.program.execution.actions = {
        "action.copilot": { identity: "action.copilot", purpose: "copilot", inputSchema: { kind: "ABSENT" }, resultSchema: {}, gate: { freeTextBypass: "prohibited" } },
        "action.codex": { identity: "action.codex", purpose: "codex", inputSchema: { kind: "ABSENT" }, resultSchema: {}, gate: { freeTextBypass: "prohibited" } },
      };
      draft.program.execution.sites = [
        { site: { kind: "node", nodeIdentity: "node.copilot" }, actionIdentity: "action.copilot", executor: { kind: "agent", identity: "executor.copilot", requiredCapabilities: ["structured-completion"] } },
        { site: { kind: "node", nodeIdentity: "node.codex" }, actionIdentity: "action.codex", executor: { kind: "agent", identity: "executor.codex", requiredCapabilities: ["structured-completion"] } },
      ];
      draft.program.execution.agents = { "executor.copilot": first, "executor.codex": second };
      draft.initial.state.values = { input: {} };
      draft.initial.state.identity = canonicalDigest({ manifest: draft.correlation.manifestBindingIdentity, state: draft.initial.state.values });
      draft.program.dataflow.edges = [
        { source: { kind: "state", field: "input" }, target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.copilot" }, slot: { kind: "whole" } } },
        { source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.copilot" }, slot: { kind: "whole" } }, target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.codex" }, slot: { kind: "whole" } } },
      ];
      draft.initial.workspace.canonicalWorktreePath = historical.custody.publication.repositoryPath;
      draft.initial.workspace.admittedGitTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: historical.custody.publication.repositoryPath, encoding: "utf8" }).trim();
    });

    const adapter = await factory.create(config, Object.freeze({
      ...dependencies,
      providerSessions: Object.freeze({ "copilot-sdk": provider("copilot-sdk"), "codex-cli": provider("codex-cli") }),
      providerOwner: Object.freeze({ async dispose() { ownerDisposals += 1; } }),
    }));
    const result = await adapter.execute({ interfaceVersion: "execution.runtime-adapter@1.0.0", activation });

    expect(result, JSON.stringify({ result, openedRoles })).toMatchObject({ ok: true, value: { kind: "terminal", outcome: "COMPLETED" } });
    expect(openedRoles).toEqual(["copilot-sdk:role.copilot", "codex-cli:role.codex"]);
    await factory.dispose(adapter);
    await factory.dispose(adapter);
    expect(ownerDisposals).toBe(1);
  });
});
