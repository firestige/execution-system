import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activationBindingDigest, canonicalDigest, type RunnerActivationContext } from "../../src/contracts/index.js";
import { compileRunnerActivation } from "../../src/interpreter/compile-runner-activation.js";
import { buildMinimalRunnerActivation } from "../support/wave4/minimal-admitted-activation.js";

let root = "";
let activation: RunnerActivationContext;
const minimalCorpus = path.join(
  path.dirname(fileURLToPath(new URL("../..", import.meta.url))),
  "system-contracts/workflow-dsl-2-candidate/generated/examples/minimal",
);

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function mutation(change: (draft: any) => void): RunnerActivationContext {
  const draft = structuredClone(activation) as any;
  change(draft);
  for (const executor of Object.values(draft.program.execution.agents) as any[]) {
    executor.sessionCompatibilityIdentity = canonicalDigest(executor.session);
    executor.bindingIdentity = canonicalDigest({ session: executor.session, turn: executor.turn });
  }
  draft.bindingIdentity = activationBindingDigest(draft);
  return freeze(draft as RunnerActivationContext);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "runner-activation-fault-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "candidate\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  activation = await buildMinimalRunnerActivation({
    corpusDirectory: minimalCorpus,
    workspaceDirectory: workspace,
    baseURL: "http://127.0.0.1:1",
  });
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Wave 4 admitted activation fault boundary", () => {
  it("rejects raw Package documents and forbidden admission payloads", () => {
    expect(compileRunnerActivation({ kind: "agentops.package", documents: {} } as never)).toMatchObject({
      ok: false, error: { code: "ACTIVATION_INVALID" },
    });
    expect(compileRunnerActivation(mutation((draft) => { draft.documents = { workflow: "workflow.json" }; }))).toMatchObject({
      ok: false, error: { code: "ACTIVATION_INVALID" },
    });
  });

  it("rejects an unfrozen nested value and a stale activation digest", () => {
    const unfrozen = structuredClone(activation) as RunnerActivationContext;
    expect(compileRunnerActivation(unfrozen)).toMatchObject({ ok: false, error: { code: "ACTIVATION_INVALID" } });
    const stale = freeze({ ...structuredClone(activation), bindingIdentity: `sha256:${"0".repeat(64)}` }) as RunnerActivationContext;
    expect(compileRunnerActivation(stale)).toMatchObject({ ok: false, error: { code: "BINDING_MISMATCH" } });
  });

  it("rejects missing structured completion authority before Provider effects", () => {
    const invalid = mutation((draft) => {
      draft.program.execution.agents["executor.intake"].session.providedCapabilities = ["action-interaction"];
    });
    expect(compileRunnerActivation(invalid)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_CAPABILITY" } });
  });

  it("rejects dangling parallel selection and site-result sources", () => {
    const invalid = mutation((draft) => {
      const parallel = draft.program.control.nodes.find((node: any) => node.id === "node.review");
      parallel.selection.source = { kind: "site-result", site: { kind: "node", nodeIdentity: "node.missing" }, slot: { kind: "whole" } };
    });
    expect(compileRunnerActivation(invalid)).toMatchObject({ ok: false, error: { code: "DATAFLOW_CLOSURE_INVALID" } });
  });
});
