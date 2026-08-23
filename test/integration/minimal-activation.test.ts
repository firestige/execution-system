import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileRunnerActivation } from "../../src/interpreter/compile-runner-activation.js";
import { buildMinimalRunnerActivation } from "../support/wave4/minimal-admitted-activation.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-activation-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "minimal candidate\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  return workspace;
}

describe("Wave 4 minimal admitted activation", () => {
  it("projects the upstream raw corpus into a deeply frozen G00 shape and compiles its routing topology", async () => {
    const activation = await buildMinimalRunnerActivation({
      corpusDirectory: "/Users/firestige/Projects/workflow-self-recursive/system-contracts/workflow-dsl/examples/minimal",
      workspaceDirectory: await workspace(),
      baseURL: "http://127.0.0.1:1",
    });

    expect(Object.isFrozen(activation)).toBe(true);
    expect(Object.isFrozen(activation.program.execution.agents["executor.intake" as never])).toBe(true);
    expect(activation).not.toHaveProperty("documents");
    const compiled = compileRunnerActivation(activation);
    expect(compiled).toMatchObject({ ok: true, value: {
      plan: {
        control: {
          entryNode: "node.intake",
          ordinarySuccessor: { "node.intake": "decision.intake", "node.review": "decision.review", "node.finalize": "SUCCESS" },
          decisions: { "decision.intake": {}, "decision.review": {}, "decision.review-selection": {}, "decision.wait-confirm": {} },
        },
        execution: { sites: {
          "node:node.intake": {},
          "parallel-branch:node.review:branch.blackbox": {},
          "parallel-branch:node.review:branch.whitebox": {},
          "parallel-join:node.review": {},
          "node:node.finalize": {},
        } },
      },
    } });
  });
});
