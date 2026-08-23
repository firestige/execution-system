import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileRunnerActivation } from "../../src/interpreter/compile-runner-activation.js";
import { buildFirstPartyCompileActivation } from "../support/wave4/first-party-package-activation.js";

const repositoryRoot = "/Users/firestige/Projects/workflow-self-recursive";
const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "first-party-package-compile-"));
  roots.push(root);
  const worktree = path.join(root, "workspace");
  await mkdir(worktree);
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: worktree });
  await writeFile(path.join(worktree, "README.md"), "qualification fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: worktree });
  return worktree;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Wave 4 first-party Package Runner projection", () => {
  it.each([
    ["System Design", path.join(repositoryRoot, "workflow-package/system-design/definition")],
    ["Implementation", path.join(repositoryRoot, "workflow-package/implementation/definition")],
  ])("projects and compiles the qualified %s Package without passing raw documents to Runner", async (_name, definitionDirectory) => {
    const worktree = await workspace();
    const workflow = JSON.parse(await readFile(path.join(definitionDirectory, "workflow.json"), "utf8"));
    const actions = JSON.parse(await readFile(path.join(definitionDirectory, "actions.json"), "utf8"));
    const activation = await buildFirstPartyCompileActivation({ definitionDirectory, workspaceDirectory: worktree });

    const compiled = compileRunnerActivation(activation);

    expect(compiled).toMatchObject({ ok: true, value: {
      correlation: {
        packageIdentity: expect.stringContaining("@"),
        snapshotIdentity: expect.stringMatching(/^snapshot\./),
      },
      plan: { control: { entryNode: workflow.graph.start } },
    } });
    if (!compiled.ok) return;
    expect(Object.keys(compiled.value.plan.control.nodes)).toHaveLength(workflow.graph.nodes.length);
    expect(Object.keys(compiled.value.plan.execution.actions)).toHaveLength(actions.actions.length);
    const compiledJson = JSON.stringify(compiled.value);
    expect(compiledJson).not.toContain("package.json");
    expect(compiledJson).not.toContain('"documents"');
    expect(Object.keys(activation)).not.toEqual(expect.arrayContaining([
      "package",
      "snapshot",
      "workflow",
      "actions",
      "routes",
      "artifacts",
    ]));
  });
});
