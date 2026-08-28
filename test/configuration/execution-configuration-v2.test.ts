import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDeliveryConfigProjectionV2,
  loadExecutionInstallationConfigV2,
  validateExecutionInstallationConfigV2,
} from "../../src/configuration/index.js";

async function deployment() {
  const root = await mkdtemp(join(tmpdir(), "execution-config-v2-"));
  const repositoryRoot = join(root, "repository");
  const workspaceRoot = join(root, "workspace");
  const worktreeRoot = join(workspaceRoot, "worktrees");
  const stateRoot = join(root, "state");
  await Promise.all([
    mkdir(repositoryRoot),
    mkdir(worktreeRoot, { recursive: true }),
    mkdir(stateRoot),
  ]);
  return { root, repositoryRoot, workspaceRoot, worktreeRoot, stateRoot };
}

function input(paths: Awaited<ReturnType<typeof deployment>>) {
  return {
    schemaVersion: "execution.config@2.0.0",
    paths: {
      repositoryRoot: paths.repositoryRoot,
      workspaceRoot: paths.workspaceRoot,
      allowedWorktreeRoots: [paths.worktreeRoot],
      stateRoot: paths.stateRoot,
    },
    workflowSource: {
      kind: "github",
      repository: "firestige/workflow-package",
      releasesBaseUrl: "https://api.github.com/repos/firestige/workflow-package/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    },
    runner: {
      implementationKey: "runner.v2",
      host: { engine: "langgraph" },
      provider: {
        identity: "provider.dsh",
        defaultModel: { provider: "deepseek-official", model: "deepseek-chat" },
        maxParallelToolCalls: 4,
      },
    },
    observation: {
      enabled: false,
      timeoutMs: 1000,
      maxBatchRecords: 512,
      maxBatchBytes: 4_194_304,
      flushIntervalMs: 1000,
      shutdownFlushMs: 3000,
      serviceName: "workflow-self-recursive-execution",
    },
    controls: {
      startupTimeoutMs: 30_000,
      executionTimeoutMs: 3_600_000,
      shutdownTimeoutMs: 10_000,
      maxConcurrentDeliveries: 4,
      allowExplicitRefresh: false,
      diagnosticMaxBytes: 4096,
    },
    intake: { maxCorrelationBytes: 256, maxOutputBytes: 8192 },
  } as const;
}

async function load(document: unknown, agentProviderIdentity = "provider.dsh") {
  const paths = await deployment();
  const path = join(paths.root, "execution.json");
  await writeFile(path, JSON.stringify(document));
  return loadExecutionInstallationConfigV2(path, Object.freeze({ agentProviderIdentity }));
}

describe("Execution configuration 2.0", () => {
  it("loads WSR-owned settings without reading or representing Provider configuration", async () => {
    const paths = await deployment();
    const path = join(paths.root, "execution.json");
    await writeFile(path, JSON.stringify(input(paths)));

    const loaded = await loadExecutionInstallationConfigV2(path, { agentProviderIdentity: "provider.dsh" });

    expect(loaded.config).toMatchObject({
      schemaVersion: "execution.config@2.0.0",
      runner: {
        implementationKey: "runner.v2",
        provider: {
          identity: "provider.dsh",
          defaultModel: { provider: "deepseek-official", model: "deepseek-chat" },
          maxParallelToolCalls: 4,
        },
      },
    });
    expect(loaded.installationConfigIdentity).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const serialized = JSON.stringify(loaded.config);
    for (const forbidden of ["credentialStorePath", "credentialRef", "baseUrl", "apiKey", "token"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects every removed 1.0 Provider/credential field and mixed-version shape", async () => {
    const paths = await deployment();
    const valid = input(paths);
    const candidates = [
      { ...valid, paths: { ...valid.paths, credentialStorePath: join(paths.root, "credentials.json") } },
      { ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, key: "dsh" } } },
      { ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, route: "deepseek-official" } } },
      { ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, modelId: "deepseek-chat" } } },
      { ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, baseUrl: "https://api.example" } } },
      { ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, credentialRef: "PROVIDER_KEY" } } },
      { ...valid, runner: { ...valid.runner, implementationKey: "runner.v1" } },
    ];

    for (const candidate of candidates) await expect(load(candidate)).rejects.toMatchObject({
      code: expect.stringMatching(/^CONFIG_(UNKNOWN_KEY|RUNNER_INVALID)$/u),
    });
  });

  it("requires the configured Agent Provider identity to match the supplied factory capability", async () => {
    const paths = await deployment();
    await expect(load(input(paths), "provider.other")).rejects.toMatchObject({
      code: "CONFIG_PROVIDER_INVALID",
      fieldPaths: ["runner.provider.identity"],
    });
  });

  it("validates the closed exact default model selection without probing a model catalog", async () => {
    const paths = await deployment();
    const valid = input(paths);
    const candidates = [
      { ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, defaultModel: { provider: "bad route", model: "model" } } } },
      { ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, defaultModel: { provider: "route", model: "" } } } },
      { ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, defaultModel: { provider: "route", model: "model", fallback: "other" } } } },
    ];
    for (const candidate of candidates) await expect(load(candidate)).rejects.toMatchObject({ code: expect.stringMatching(/^CONFIG_(PROVIDER_INVALID|UNKNOWN_KEY)$/u) });

    await expect(load({
      ...valid,
      runner: { ...valid.runner, provider: { ...valid.runner.provider, defaultModel: { provider: "private-route", model: "unlisted-dynamic-model" } } },
    })).resolves.toMatchObject({ config: { runner: { provider: { defaultModel: { model: "unlisted-dynamic-model" } } } } });
  });

  it("projects only WSR-owned recovery inputs and excludes the admission-only default model", async () => {
    const paths = await deployment();
    const path = join(paths.root, "execution.json");
    await writeFile(path, JSON.stringify(input(paths)));
    const loaded = await loadExecutionInstallationConfigV2(path, { agentProviderIdentity: "provider.dsh" });

    const projection = createDeliveryConfigProjectionV2(loaded.config);

    expect(projection).toMatchObject({
      value: {
        schemaVersion: "execution.delivery-config@2.0.0",
        runner: {
          implementationKey: "runner.v2",
          host: { engine: "langgraph" },
          provider: { identity: "provider.dsh", maxParallelToolCalls: 4 },
        },
      },
      identity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const serialized = JSON.stringify(projection);
    for (const forbidden of ["defaultModel", "workflowSource", "observation", paths.stateRoot, "credential", "baseUrl"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("preflights an explicit adapter source and enabled loopback Observation endpoint", async () => {
    const paths = await deployment();
    const adapterConfigFile = join(paths.root, "workflow-adapter.json");
    const configFile = join(paths.root, "execution.json");
    await writeFile(adapterConfigFile, "{}\n");
    const canonicalAdapterConfigFile = await realpath(adapterConfigFile);
    await writeFile(configFile, JSON.stringify({
      ...input(paths),
      workflowSource: {
        kind: "adapter",
        adapterKey: "source.local",
        adapterConfigFile,
      },
      observation: {
        ...input(paths).observation,
        enabled: true,
        endpoint: "http://127.0.0.1:4318/v1/traces/",
      },
    }));

    await expect(loadExecutionInstallationConfigV2(configFile, {
      agentProviderIdentity: "provider.dsh",
    })).resolves.toMatchObject({
      config: {
        workflowSource: {
          kind: "adapter",
          adapterKey: "source.local",
          adapterConfigFile: canonicalAdapterConfigFile,
        },
        observation: { enabled: true, endpoint: "http://127.0.0.1:4318/v1/traces" },
      },
    });
  });

  it("fails closed across placeholder, topology, source, endpoint, type, and range violations", async () => {
    const paths = await deployment();
    const valid = input(paths);
    const cases: readonly [unknown, string][] = [
      [null, "CONFIG_TYPE_INVALID"],
      [{ ...valid, schemaVersion: "__REQUIRED__:schema" }, "CONFIG_REQUIRED_INPUT_MISSING"],
      [{ ...valid, schemaVersion: "execution.config@1.0.0" }, "CONFIG_SCHEMA_VERSION_UNSUPPORTED"],
      [{ ...valid, paths: { ...valid.paths, packageStoreRoot: join(paths.root, "packages") } }, "CONFIG_DERIVED_KEY_FORBIDDEN"],
      [{ ...valid, paths: { ...valid.paths, allowedWorktreeRoots: [] } }, "CONFIG_PATH_OUT_OF_SCOPE"],
      [{ ...valid, paths: { ...valid.paths, allowedWorktreeRoots: [paths.worktreeRoot, paths.worktreeRoot] } }, "CONFIG_PATH_OUT_OF_SCOPE"],
      [{ ...valid, workflowSource: { ...valid.workflowSource, adapterKey: "source.local" } }, "CONFIG_SOURCE_INVALID"],
      [{ ...valid, workflowSource: { ...valid.workflowSource, repository: "invalid" } }, "CONFIG_SOURCE_INVALID"],
      [{ ...valid, workflowSource: { ...valid.workflowSource, releasesBaseUrl: "not-a-url" } }, "CONFIG_URL_INVALID"],
      [{ ...valid, workflowSource: { ...valid.workflowSource, releasesBaseUrl: "https://user@example.test/releases" } }, "CONFIG_URL_INVALID"],
      [{ ...valid, workflowSource: { kind: "adapter", repository: "owner/repo" } }, "CONFIG_SOURCE_INVALID"],
      [{ ...valid, workflowSource: { kind: "adapter", adapterKey: "source.local", adapterConfigFile: "relative.json" } }, "CONFIG_SOURCE_INVALID"],
      [{ ...valid, workflowSource: { kind: "unknown" } }, "CONFIG_SOURCE_INVALID"],
      [{ ...valid, observation: { ...valid.observation, enabled: true } }, "CONFIG_OBSERVATION_INVALID"],
      [{ ...valid, observation: { ...valid.observation, enabled: true, endpoint: "https://example.test/v1/traces" } }, "CONFIG_OBSERVATION_ENDPOINT_INVALID"],
      [{ ...valid, controls: { ...valid.controls, allowExplicitRefresh: "false" } }, "CONFIG_TYPE_INVALID"],
      [{ ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, maxParallelToolCalls: 0 } } }, "CONFIG_RANGE_INVALID"],
    ];

    for (const [candidate, code] of cases) {
      expect(() => validateExecutionInstallationConfigV2(candidate, {
        agentProviderIdentity: "provider.dsh",
      })).toThrow(expect.objectContaining({ code }));
    }

    await expect(loadExecutionInstallationConfigV2("relative.json", {
      agentProviderIdentity: "provider.dsh",
    })).rejects.toMatchObject({ code: "CONFIG_PATH_INVALID" });
    await expect(loadExecutionInstallationConfigV2(join(paths.root, "missing.json"), {
      agentProviderIdentity: "provider.dsh",
    })).rejects.toMatchObject({ code: "CONFIG_PATH_INVALID" });

    const unresolvedPathConfig = join(paths.root, "unresolved-path.json");
    await writeFile(unresolvedPathConfig, JSON.stringify({
      ...valid,
      paths: {
        ...valid.paths,
        allowedWorktreeRoots: [join(paths.workspaceRoot, "missing-worktree")],
      },
    }));
    await expect(loadExecutionInstallationConfigV2(unresolvedPathConfig, {
      agentProviderIdentity: "provider.dsh",
    })).rejects.toMatchObject({ code: "CONFIG_PATH_INVALID" });

    const outsideWorktree = join(paths.root, "outside-worktree");
    const linkedWorktree = join(paths.workspaceRoot, "linked-worktree");
    await mkdir(outsideWorktree);
    await symlink(outsideWorktree, linkedWorktree, "dir");
    const escapedPathConfig = join(paths.root, "escaped-path.json");
    await writeFile(escapedPathConfig, JSON.stringify({
      ...valid,
      paths: { ...valid.paths, allowedWorktreeRoots: [linkedWorktree] },
    }));
    await expect(loadExecutionInstallationConfigV2(escapedPathConfig, {
      agentProviderIdentity: "provider.dsh",
    })).rejects.toMatchObject({ code: "CONFIG_PATH_OUT_OF_SCOPE" });
  });
});
