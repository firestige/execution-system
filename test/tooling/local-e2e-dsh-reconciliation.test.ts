import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { reconcileLocalE2EDshProfile } from "../../scripts/prepare-local-e2e.js";

describe("local E2E DSH profile reconciliation", () => {
  it("installs exact local artifacts into a fresh profile and appends only the owned override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-dsh-fresh-"));
    const dshHome = path.join(root, "dsh-home");
    const profileDirectory = path.join(dshHome, "profiles/web");
    const configFile = path.join(root, "durable/execution.json");
    const bindingFile = path.join(root, "durable/dsh-intake-bindings.json");
    const calls: string[][] = [];

    const result = await reconcileLocalE2EDshProfile({
      dshHome, profile: "web", worktree: root,
      coreArchive: path.join(root, "core.tgz"), pluginArchive: path.join(root, "plugin.tgz"),
      configFile, bindingFile,
    }, async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "plugin") {
        await mkdir(profileDirectory, { recursive: true });
        try {
          await writeFile(path.join(profileDirectory, "cordis.patch.yml"), "# fresh DSH user patch\n[]\n", { flag: "wx" });
        } catch { /* the second package add reuses the initialized profile */ }
        return "";
      }
      return `- id: workflow-execution\n  config:\n    configFile: ${configFile}\n    bindingFile: ${bindingFile}\n`;
    });

    expect(calls.slice(0, 2)).toEqual([
      ["plugin", "--profile", "web", "add", "--workspace-root", path.join(root, "core.tgz")],
      ["plugin", "--profile", "web", "add", "--workspace-root", path.join(root, "plugin.tgz")],
    ]);
    expect(calls[2]).toEqual(["--profile", "web", "--dump-config"]);
    expect(result).toMatchObject({ profile: "web", operation: "RECONCILED" });
    const patch = await readFile(path.join(profileDirectory, "cordis.patch.yml"), "utf8");
    expect(patch).toContain("# fresh DSH user patch");
    expect(patch).toContain(`- id: workflow-execution\n  config:\n    configFile: ${JSON.stringify(configFile)}\n    bindingFile: ${JSON.stringify(bindingFile)}`);
  });

  it("replaces the owned row idempotently while preserving every unrelated user-patch byte", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-dsh-existing-"));
    const dshHome = path.join(root, "dsh-home");
    const profileDirectory = path.join(dshHome, "profiles/web");
    const patchFile = path.join(profileDirectory, "cordis.patch.yml");
    const prefix = "# keep this comment\n- id: web-runtime\n  config:\n    printUrl: true\n";
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(path.join(profileDirectory, "package.json"), JSON.stringify({
      dependencies: {
        "@workflow-self-recursive/execution-system": "0.1.1",
        "@workflow-self-recursive/dsh-intake": "0.1.1",
      },
    }));
    await writeFile(patchFile, `${prefix}- id: workflow-execution\n  config:\n    configFile: /old/config.json\n    bindingFile: /old/bindings.json\n- id: unrelated\n  disabled: true\n`);
    const input = {
      dshHome, profile: "web", worktree: root,
      coreArchive: path.join(root, "core.tgz"), pluginArchive: path.join(root, "plugin.tgz"),
      configFile: path.join(root, "new/config.json"), bindingFile: path.join(root, "new/bindings.json"),
    } as const;
    const calls: string[][] = [];
    const run = async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "plugin" ? "" : `${input.configFile}\n${input.bindingFile}\n`;
    };

    await reconcileLocalE2EDshProfile(input, run);
    const once = await readFile(patchFile, "utf8");
    await reconcileLocalE2EDshProfile(input, run);
    const twice = await readFile(patchFile, "utf8");

    expect(twice).toBe(once);
    expect(twice).toContain(prefix);
    expect(twice).toContain("- id: unrelated\n  disabled: true\n");
    expect(twice).not.toContain("/old/");
    expect(calls.slice(0, 5)).toEqual([
      ["plugin", "--profile", "web", "remove", "--workspace-root", "@workflow-self-recursive/dsh-intake"],
      ["plugin", "--profile", "web", "remove", "--workspace-root", "@workflow-self-recursive/execution-system"],
      ["plugin", "--profile", "web", "add", "--workspace-root", path.join(root, "core.tgz")],
      ["plugin", "--profile", "web", "add", "--workspace-root", path.join(root, "plugin.tgz")],
      ["--profile", "web", "--dump-config"],
    ]);
  });

  it("fails when the composed profile still contains unresolved required values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-dsh-invalid-"));
    const dshHome = path.join(root, "dsh-home");
    const profileDirectory = path.join(dshHome, "profiles/web");
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(path.join(profileDirectory, "cordis.patch.yml"), "[]\n");
    await expect(reconcileLocalE2EDshProfile({
      dshHome, profile: "web", worktree: root, coreArchive: "core.tgz", pluginArchive: "plugin.tgz",
      configFile: path.join(root, "config.json"), bindingFile: path.join(root, "bindings.json"),
    }, async (_command, args) => args[0] === "plugin" ? "" : "/__REQUIRED__/execution-config.yaml\n"))
      .rejects.toThrowError("DSH_LOCAL_E2E_PROFILE_INVALID");
  });

  it("repairs the empty-list marker left beside an owned row by an interrupted older preparation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-dsh-repair-"));
    const dshHome = path.join(root, "dsh-home");
    const profileDirectory = path.join(dshHome, "profiles/web");
    const patchFile = path.join(profileDirectory, "cordis.patch.yml");
    const configFile = path.join(root, "execution.json");
    const bindingFile = path.join(root, "bindings.json");
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(patchFile, "# DSH template\n[]\n- id: workflow-execution\n  config:\n    configFile: /old/config.json\n    bindingFile: /old/bindings.json\n");

    await reconcileLocalE2EDshProfile({
      dshHome, profile: "web", worktree: root, coreArchive: "core.tgz", pluginArchive: "plugin.tgz",
      configFile, bindingFile,
    }, async (_command, args) => args[0] === "plugin" ? "" : `${configFile}\n${bindingFile}\n`);

    const patch = await readFile(patchFile, "utf8");
    expect(patch).toContain("# DSH template\n");
    expect(patch).not.toMatch(/^\s*\[\]\s*$/mu);
    expect(patch).toContain("- id: workflow-execution");
  });
});
