import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { prepareLocalE2E, resolveLocalE2EPreparationInput } from "../../scripts/prepare-local-e2e.js";
import { validateExecutionInstallationConfigV2 } from "../../src/configuration/index.js";

describe("local E2E preparation", () => {
  it("resolves the repository-owned default preparation layout", async () => {
    const executionRoot = path.resolve(import.meta.dirname, "../..");
    const coreManifest = JSON.parse(await readFile(path.join(executionRoot, "package.json"), "utf8")) as { readonly version: string };
    const input = await resolveLocalE2EPreparationInput(executionRoot);
    expect(input).toMatchObject({
      executionRoot,
      worktree: path.resolve(executionRoot, ".."),
      packageVersion: coreManifest.version,
      defaults: { schemaVersion: "execution.config@2.0.0" },
    });
    expect(input.releaseDirectory).toBe(path.join(input.worktree, "tmp/local-e2e/release"));
    expect(input.durableDirectory).toBe(path.resolve(input.worktree, "../wsr-local"));
  });

  it("builds verified artifacts and initializes deployment-specific local files in one operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-prepare-"));
    const executionRoot = path.join(root, "execution-system");
    const worktree = path.join(root, "workflow-self-recursive");
    const releaseDirectory = path.join(worktree, "tmp/local-e2e/release");
    const durableDirectory = path.join(root, "wsr-local");
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    await writeFile(path.join(root, "package.json"), "{}").catch(() => undefined);

    const result = await prepareLocalE2E({
      executionRoot,
      worktree,
      releaseDirectory,
      durableDirectory,
      packageVersion: "0.1.1",
      defaults: {
        schemaVersion: "execution.config@2.0.0",
        paths: {},
        workflowSource: { kind: "github" },
        runner: { implementationKey: "runner.v2", host: { engine: "langgraph" }, maxParallelToolCalls: 4 },
        observation: { enabled: false }, controls: {}, intake: {},
      },
    }, async (command, args) => {
      mutableCalls.push([command, ...args]);
    });

    expect(calls).toEqual([["pnpm", "release:artifacts", releaseDirectory]]);
    expect(result).toMatchObject({
      version: "0.1.1",
      configFile: path.join(durableDirectory, "execution.json"),
      coreArchive: path.join(releaseDirectory, "wsr-execution-0.1.1.tgz"),
      pluginArchive: path.join(releaseDirectory, "wsr-dsh-intake-0.1.1.tgz"),
    });
    const config = JSON.parse(await readFile(result.configFile, "utf8"));
    expect(config.paths).toEqual({
      repositoryRoot: worktree,
      workspaceRoot: worktree,
      allowedWorktreeRoots: [worktree],
      stateRoot: path.join(durableDirectory, "state"),
    });
    expect(config.runner).toEqual({ implementationKey: "runner.v2", host: { engine: "langgraph" }, maxParallelToolCalls: 4 });
  });

  it("generates paths accepted by the frozen configuration boundary", async () => {
    const executionRoot = path.resolve(import.meta.dirname, "../..");
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-valid-config-"));
    const worktree = path.join(root, "workspace/repository");
    const durableDirectory = path.join(path.dirname(worktree), "wsr-local");
    await (await import("node:fs/promises")).mkdir(worktree, { recursive: true });
    const defaults = JSON.parse(await readFile(path.join(executionRoot, "config/defaults/execution.default.json"), "utf8"));

    const result = await prepareLocalE2E({
      executionRoot,
      worktree,
      releaseDirectory: path.join(root, "release"),
      durableDirectory,
      packageVersion: "0.1.1",
      defaults,
    }, async () => undefined);

    const config = JSON.parse(await readFile(result.configFile, "utf8"));
    expect(() => validateExecutionInstallationConfigV2(config)).not.toThrow();
  });

  it("repairs only legacy generated path scope while preserving user configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-repair-config-"));
    const worktree = path.join(root, "workspace/repository");
    const durableDirectory = path.join(root, "workspace/wsr-local");
    const configFile = path.join(durableDirectory, "execution.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(durableDirectory, { recursive: true });
    await writeFile(configFile, `${JSON.stringify({
      schemaVersion: "execution.config@2.0.0",
      paths: {
        repositoryRoot: worktree,
        workspaceRoot: path.dirname(worktree),
        allowedWorktreeRoots: [path.dirname(worktree)],
        stateRoot: path.join(durableDirectory, "state"),
      },
      runner: { implementationKey: "runner.v2", host: { engine: "langgraph" }, maxParallelToolCalls: 8 },
    }, null, 2)}\n`);

    await prepareLocalE2E({
      executionRoot: path.join(root, "execution-system"), worktree,
      releaseDirectory: path.join(root, "release"), durableDirectory, packageVersion: "0.1.1", defaults: {},
    }, async () => undefined);

    const repaired = JSON.parse(await readFile(configFile, "utf8"));
    expect(repaired.paths.workspaceRoot).toBe(worktree);
    expect(repaired.paths.allowedWorktreeRoots).toEqual([worktree]);
    expect(repaired.paths.stateRoot).toBe(path.join(durableDirectory, "state"));
    expect(repaired.runner.maxParallelToolCalls).toBe(8);
  });

  it("preserves user-edited durable configuration on repeated preparation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-preserve-"));
    const durableDirectory = path.join(root, "durable");
    const configFile = path.join(durableDirectory, "execution.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(durableDirectory, { recursive: true });
    await writeFile(configFile, "user-config\n");

    await prepareLocalE2E({
      executionRoot: path.join(root, "execution-system"), worktree: path.join(root, "worktree"),
      releaseDirectory: path.join(root, "release"), durableDirectory, packageVersion: "0.1.1", defaults: {},
    }, async () => undefined);

    expect(await readFile(configFile, "utf8")).toBe("user-config\n");
  });

  it("does not rewrite a valid user-owned path layout that is not the legacy generated shape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-custom-paths-"));
    const durableDirectory = path.join(root, "durable");
    const configFile = path.join(durableDirectory, "execution.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(durableDirectory, { recursive: true });
    const userConfig = `${JSON.stringify({
      paths: {
        repositoryRoot: path.join(root, "repository"),
        workspaceRoot: path.join(root, "custom-workspace"),
        allowedWorktreeRoots: [path.join(root, "custom-workspace/worktrees")],
        stateRoot: path.join(root, "state"),
      },
    }, null, 2)}\n`;
    await writeFile(configFile, userConfig);

    await prepareLocalE2E({
      executionRoot: path.join(root, "execution-system"), worktree: path.join(root, "worktree"),
      releaseDirectory: path.join(root, "release"), durableDirectory, packageVersion: "0.1.1", defaults: {},
    }, async () => undefined);

    expect(await readFile(configFile, "utf8")).toBe(userConfig);
  });
});
