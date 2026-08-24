import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { prepareLocalE2E, resolveLocalE2EPreparationInput } from "../../scripts/prepare-local-e2e.js";

describe("local E2E preparation", () => {
  it("resolves the repository-owned default preparation layout", async () => {
    const executionRoot = path.resolve(import.meta.dirname, "../..");
    const input = await resolveLocalE2EPreparationInput(executionRoot);
    expect(input).toMatchObject({
      executionRoot,
      worktree: path.resolve(executionRoot, ".."),
      packageVersion: "0.1.1",
      defaults: { schemaVersion: "execution.config@1.0.0" },
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
        schemaVersion: "execution.config@1.0.0",
        paths: {},
        workflowSource: { kind: "github" },
        runner: { implementationKey: "runner.v1", host: { engine: "langgraph" }, provider: { key: "dsh", maxParallelToolCalls: 4 } },
        observation: { enabled: false }, controls: {}, intake: {},
      },
    }, async (command, args) => {
      mutableCalls.push([command, ...args]);
    });

    expect(calls).toEqual([["pnpm", "release:artifacts", releaseDirectory]]);
    expect(result).toMatchObject({
      version: "0.1.1",
      configFile: path.join(durableDirectory, "execution.json"),
      credentialFile: path.join(durableDirectory, "credentials.yml"),
      coreArchive: path.join(releaseDirectory, "workflow-self-recursive-execution-system-0.1.1.tgz"),
      pluginArchive: path.join(releaseDirectory, "workflow-self-recursive-dsh-intake-0.1.1.tgz"),
    });
    const config = JSON.parse(await readFile(result.configFile, "utf8"));
    expect(config.paths).toEqual({
      repositoryRoot: worktree,
      workspaceRoot: root,
      allowedWorktreeRoots: [root],
      stateRoot: path.join(durableDirectory, "state"),
      credentialStorePath: result.credentialFile,
    });
    expect(config.runner.provider).toMatchObject({
      route: "deepseek", modelId: "deepseek-chat", baseUrl: "https://api.deepseek.com", credentialRef: "DEEPSEEK_API_KEY",
    });
    expect(await readFile(result.credentialFile, "utf8")).toContain("replace-with-the-provider-key");
  });

  it("preserves user-edited durable configuration on repeated preparation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-preserve-"));
    const durableDirectory = path.join(root, "durable");
    const configFile = path.join(durableDirectory, "execution.json");
    const credentialFile = path.join(durableDirectory, "credentials.yml");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(durableDirectory, { recursive: true });
    await writeFile(configFile, "user-config\n");
    await writeFile(credentialFile, "user-secret\n");

    await prepareLocalE2E({
      executionRoot: path.join(root, "execution-system"), worktree: path.join(root, "worktree"),
      releaseDirectory: path.join(root, "release"), durableDirectory, packageVersion: "0.1.1", defaults: {},
    }, async () => undefined);

    expect(await readFile(configFile, "utf8")).toBe("user-config\n");
    expect(await readFile(credentialFile, "utf8")).toBe("user-secret\n");
  });
});
