import path from "node:path";

import { describe, expect, it } from "vitest";

import { containsInternalActionProtocol, dshProductQualificationPaths } from "../../scripts/qualify-dsh-product-e2e.js";

describe("DSH product qualification workspace layout", () => {
  it("separates process launch cwd, configured worktrees, and an exact registered workspace outside the public roots", () => {
    const root = path.resolve("/tmp/dsh-product-layout");
    const layout = dshProductQualificationPaths(root);

    expect(layout.launchDirectory).not.toBe(layout.helloWorktree);
    expect(layout.launchDirectory).not.toBe(layout.systemWorktree);
    expect(path.relative(layout.workspaceRoot, layout.helloWorktree)).not.toMatch(/^\.\./u);
    expect(path.relative(layout.workspaceRoot, layout.systemWorktree)).not.toMatch(/^\.\./u);
    expect(path.relative(layout.workspaceRoot, layout.outsideWorktree)).toMatch(/^\.\./u);
    expect(new Set([layout.launchDirectory, layout.helloWorktree, layout.systemWorktree, layout.outsideWorktree]).size).toBe(4);
  });

  it("rejects internal completion protocol in browser-visible Action output", () => {
    expect(containsInternalActionProtocol("Action output\nHello from the Workflow.")).toBe(false);
    for (const leaked of ["tool-call", "workflow_complete", '"arguments"', "call_00_secret"]) {
      expect(containsInternalActionProtocol(`Action output\n${leaked}`)).toBe(true);
    }
  });
});
