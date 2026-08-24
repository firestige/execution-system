import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExactProviderFactoryRegistry,
} from "../../src/composition/runner-factory.js";
import { RunnerFactory, type RunnerFactoryConfig } from "../../src/index.js";

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

  it("rejects duplicate Provider factory keys before creating any adapter", () => {
    expect(() => new ExactProviderFactoryRegistry([
      new (class { readonly key = "dsh-headless" as const; async create(): Promise<never> { throw new Error("must not create"); } })(),
      new (class { readonly key = "dsh-headless" as const; async create(): Promise<never> { throw new Error("must not create"); } })(),
    ])).toThrow(/duplicate Provider factory/);
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
