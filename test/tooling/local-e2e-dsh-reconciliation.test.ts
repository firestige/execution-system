import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  reconcileLocalE2EDshProfile,
  resolveLocalE2EProfileReinstall,
} from "../../scripts/prepare-local-e2e.js";

describe("local E2E DSH profile reconciliation", () => {
  it("enables profile reinstall only through the explicit CLI switch", () => {
    expect(resolveLocalE2EProfileReinstall([])).toBe(false);
    expect(resolveLocalE2EProfileReinstall(["--reinstall-dsh-profile"])).toBe(true);
  });

  it("preserves existing profile modules unless reinstall is explicitly requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-dsh-preserve-modules-"));
    const dshHome = path.join(root, "dsh-home");
    const profileDirectory = path.join(dshHome, "profiles/web");
    const modulesMarker = path.join(profileDirectory, "node_modules/.modules.yaml");
    const configFile = path.join(root, "execution.json");
    const bindingFile = path.join(root, "bindings.json");
    await mkdir(path.dirname(modulesMarker), { recursive: true });
    await writeFile(modulesMarker, "nodeLinker: isolated\n");
    await writeFile(path.join(profileDirectory, "cordis.patch.yml"), "[]\n");

    await reconcileLocalE2EDshProfile({
      dshHome, profile: "web", worktree: root, coreArchive: "core.tgz", pluginArchive: "plugin.tgz",
      configFile, bindingFile,
    }, async (_command, args) => args[0] === "plugin" ? "" : `${configFile}\n${bindingFile}\n`);

    expect(await readFile(modulesMarker, "utf8")).toBe("nodeLinker: isolated\n");
  });

  it("removes only existing profile modules when reinstall is explicitly requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-e2e-dsh-reinstall-modules-"));
    const dshHome = path.join(root, "dsh-home");
    const profileDirectory = path.join(dshHome, "profiles/web");
    const modulesDirectory = path.join(profileDirectory, "node_modules");
    const configFile = path.join(root, "execution.json");
    const bindingFile = path.join(root, "bindings.json");
    await mkdir(modulesDirectory, { recursive: true });
    await writeFile(path.join(modulesDirectory, ".modules.yaml"), "nodeLinker: isolated\n");
    await writeFile(path.join(profileDirectory, "package.json"), "{\"dependencies\":{}}\n");
    await writeFile(path.join(profileDirectory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(path.join(profileDirectory, "cordis.yml"), "- id: web-runtime\n");
    await writeFile(path.join(profileDirectory, "cordis.patch.yml"), "[]\n");

    await reconcileLocalE2EDshProfile({
      dshHome, profile: "web", worktree: root, coreArchive: "core.tgz", pluginArchive: "plugin.tgz",
      configFile, bindingFile, reinstallProfile: true,
    }, async (_command, args) => args[0] === "plugin" ? "" : `${configFile}\n${bindingFile}\n`);

    await expect(stat(modulesDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(profileDirectory, "package.json"), "utf8")).toBe("{\"dependencies\":{}}\n");
    expect(await readFile(path.join(profileDirectory, "pnpm-lock.yaml"), "utf8")).toBe("lockfileVersion: '9.0'\n");
    expect(await readFile(path.join(profileDirectory, "cordis.yml"), "utf8")).toBe("- id: web-runtime\n");
  });

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

    expect(calls.slice(0, 4)).toEqual([
      ["plugin", "--profile", "web", "config", "get", "--json", "allowBuilds"],
      ["plugin", "--profile", "web", "config", "set", "--location=project", "--json", "allowBuilds", '{"better-sqlite3":true}'],
      ["plugin", "--profile", "web", "add", "--workspace-root", path.join(root, "core.tgz")],
      ["plugin", "--profile", "web", "add", "--workspace-root", path.join(root, "plugin.tgz")],
    ]);
    expect(calls[4]).toEqual(["--profile", "web", "--dump-config"]);
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
    expect(calls.slice(0, 7)).toEqual([
      ["plugin", "--profile", "web", "config", "get", "--json", "allowBuilds"],
      ["plugin", "--profile", "web", "config", "set", "--location=project", "--json", "allowBuilds", '{"better-sqlite3":true}'],
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
