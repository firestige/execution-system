import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  containsInternalActionProtocol,
  dshProductQualificationPaths,
  dshProductQualificationPatch,
  dshProductQualificationSelectors,
  manifestWorkflowPackage,
  prepareDshProductQualificationConfig,
  prepareDirtyQualificationWorkspace,
  verifyDirtyQualificationWorkspace,
} from "../../scripts/qualify-dsh-product-e2e.js";

describe("DSH product qualification workspace layout", () => {
  it("separates process launch cwd, configured worktrees, and an exact registered workspace outside the public roots", () => {
    const root = path.resolve("/tmp/dsh-product-layout");
    const layout = dshProductQualificationPaths(root);

    expect(layout.launchDirectory).not.toBe(layout.helloWorktree);
    expect(layout.launchDirectory).not.toBe(layout.systemWorktree);
    expect(layout.launchDirectory).not.toBe(layout.implementationWorktree);
    expect(layout.launchDirectory).not.toBe(layout.abandonWorktree);
    expect(path.relative(layout.workspaceRoot, layout.helloWorktree)).not.toMatch(/^\.\./u);
    expect(path.relative(layout.workspaceRoot, layout.systemWorktree)).not.toMatch(/^\.\./u);
    expect(path.relative(layout.workspaceRoot, layout.implementationWorktree)).not.toMatch(/^\.\./u);
    expect(path.relative(layout.workspaceRoot, layout.abandonWorktree)).not.toMatch(/^\.\./u);
    expect(path.relative(layout.workspaceRoot, layout.outsideWorktree)).toMatch(/^\.\./u);
    expect(new Set([layout.launchDirectory, layout.helloWorktree, layout.systemWorktree, layout.implementationWorktree, layout.abandonWorktree, layout.outsideWorktree]).size).toBe(6);
  });

  it("rejects internal completion protocol in browser-visible Action output", () => {
    expect(containsInternalActionProtocol("Action output\nHello from the Workflow.")).toBe(false);
    for (const leaked of ["tool-call", "workflow_complete", '"arguments"', "call_00_secret"]) {
      expect(containsInternalActionProtocol(`Action output\n${leaked}`)).toBe(true);
    }
  });

  it("uses bare selectors for both first-party product journeys and retains an exact success regression", () => {
    expect(dshProductQualificationSelectors).toEqual({
      hello: "hello-world-workflow",
      systemDesign: "system-design-workflow",
      implementation: "implementation-workflow",
      exactRegression: "hello-world-workflow@0.2.0",
    });
  });

  it("overrides the installed DSH execution row instead of adding a disconnected patch row", () => {
    expect(dshProductQualificationPatch("/tmp/execution.json", "/tmp/bindings.json")).toBe([
      "- id: workflow-execution",
      "  config:",
      "    configFile: \"/tmp/execution.json\"",
      "    bindingFile: \"/tmp/bindings.json\"",
      "",
    ].join("\n"));
  });

  it("does not inject the retired credential-store path into Execution config v2", () => {
    const config = prepareDshProductQualificationConfig({
      schemaVersion: "execution.config@2.0.0",
      paths: {},
      controls: {},
    }, {
      repositoryRoot: "/tmp/workspaces",
      stateRoot: "/tmp/state",
    });

    expect(config.paths).toEqual({
      repositoryRoot: "/tmp/workspaces",
      workspaceRoot: "/tmp/workspaces",
      allowedWorktreeRoots: ["/tmp/workspaces"],
      stateRoot: "/tmp/state",
    });
    expect(config.controls).toMatchObject({ executionTimeoutMs: 600_000 });
  });

  it("reads the exact Workflow coordinate only from the persisted V2 Manifest", () => {
    expect(manifestWorkflowPackage({
      schemaVersion: "execution.delivery-manifest@2.0.0",
      workflowPackage: { name: "hello-world-workflow", exactVersion: "0.2.0" },
    })).toEqual({ name: "hello-world-workflow", exactVersion: "0.2.0" });
    expect(manifestWorkflowPackage({ resolvedPackage: { name: "legacy", exactVersion: "1.0.0" } })).toBeUndefined();
  });

  it("locks dirty managed inputs while excluding ignored cache from the user object database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-product-dirty-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "qualification@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Qualification"], { cwd: root });
      await writeFile(path.join(root, ".gitignore"), "ignored-cache/\n");
      await writeFile(path.join(root, "README.md"), "baseline\n");
      execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
      await mkdir(path.join(root, "ignored-cache"));

      const baseline = await prepareDirtyQualificationWorkspace(root);

      expect(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" })).toContain(" M README.md");
      expect(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" })).toContain("?? managed-untracked.txt");
      await expect(verifyDirtyQualificationWorkspace(root, baseline)).resolves.toEqual({
        indexUnchanged: true,
        managedDirtyPreserved: true,
        ignoredCachePreserved: true,
        ignoredBlobAbsentFromUserOdb: true,
      });
      expect((await readFile(path.join(root, "ignored-cache", "large-cache.bin"))).byteLength).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
