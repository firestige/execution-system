import { describe, expect, it } from "vitest";

import {
  ActivationContractError,
  assertFrozenJsonValue,
  canonicalDigest,
  executionSiteKey,
  validateRunnerActivation,
  validateSelectedBranches,
} from "../../src/contracts/index.js";
import { mutatedRunnerActivation, validRunnerActivation } from "../support/runner-activation-fixtures.js";
import type { BranchId, NodeId } from "../../src/contracts/primitives.js";

describe("replacement G00 Runner activation boundary", () => {
  it("accepts a deeply frozen fully admitted activation with a matching identity", () => {
    const activation = validRunnerActivation();
    expect(validateRunnerActivation(activation)).toBe(activation);
  });

  it("rejects a binding whose canonical content identity is stale", () => {
    const activation = validRunnerActivation({ bindingIdentity: `sha256:${"0".repeat(64)}` });
    expect(() => validateRunnerActivation(activation)).toThrowError(
      expect.objectContaining<Partial<ActivationContractError>>({ code: "BINDING_MISMATCH" }),
    );
  });

  it("rejects empty, duplicate, and unknown parallel selections before effect", () => {
    const declared = ["branch.problem", "branch.architecture", "branch.quality"];
    expect(() => validateSelectedBranches([], declared)).toThrowError(/non-empty/);
    expect(() => validateSelectedBranches(["branch.problem", "branch.problem"], declared)).toThrowError(/duplicate/);
    expect(() => validateSelectedBranches(["branch.future"], declared)).toThrowError(/unknown/);
    expect(validateSelectedBranches(["branch.quality"], declared)).toEqual(["branch.quality"]);
  });

  it("uses canonical object ordering and preserves semantic array order", () => {
    expect(canonicalDigest({ b: 2, a: ["x", "y"] })).toBe(canonicalDigest({ a: ["x", "y"], b: 2 }));
    expect(canonicalDigest({ a: ["x", "y"] })).not.toBe(canonicalDigest({ a: ["y", "x"] }));
  });

  it("rejects mutable, malformed, forbidden, native, and secret activation surfaces", () => {
    expect(() => validateRunnerActivation(null)).toThrowError(expect.objectContaining({ code: "INVALID_ACTIVATION" }));
    expect(() => validateRunnerActivation({})).toThrowError(expect.objectContaining({ code: "NOT_DEEPLY_FROZEN" }));
    expect(() => validateRunnerActivation(Object.freeze({ documents: [] }))).toThrowError(expect.objectContaining({ code: "FORBIDDEN_FIELD" }));
    expect(() => validateRunnerActivation(Object.freeze({ threadId: "native" }))).toThrowError(expect.objectContaining({ code: "NATIVE_IDENTITY_LEAK" }));
    expect(() => validateRunnerActivation(Object.freeze({ credential: "redacted" }))).toThrowError(expect.objectContaining({ code: "SECRET_LEAK" }));
    expect(() => validateRunnerActivation(Object.freeze({ schemaVersion: "runner.activation@0" }))).toThrowError(expect.objectContaining({ code: "INVALID_ACTIVATION" }));
  });

  it("validates frozen JSON and all canonical execution-site keys", () => {
    expect(() => assertFrozenJsonValue(Object.freeze({ value: true }))).not.toThrow();
    expect(() => assertFrozenJsonValue({ value: true })).toThrowError(expect.objectContaining({ code: "NOT_DEEPLY_FROZEN" }));
    expect(executionSiteKey({ kind: "node", nodeIdentity: "node.a" as NodeId })).toBe("node:node.a");
    expect(executionSiteKey({ kind: "parallel-join", nodeIdentity: "node.p" as NodeId })).toBe("parallel-join:node.p");
    expect(executionSiteKey({ kind: "parallel-branch", nodeIdentity: "node.p" as NodeId, branchIdentity: "branch.a" as BranchId })).toBe("parallel-branch:node.p:branch.a");
  });

  it("rejects unresolved executors, capability mismatch, and duplicate data sinks", () => {
    expect(() => validateRunnerActivation(mutatedRunnerActivation(draft => { draft.program.execution.sites[0].executor.identity = "executor.missing"; }))).toThrowError(/unresolved executor/);
    expect(() => validateRunnerActivation(mutatedRunnerActivation(draft => { draft.program.execution.sites[0].executor.requiredCapabilities.push("action-interaction"); }))).toThrowError(/capability mismatch/);
    expect(() => validateRunnerActivation(mutatedRunnerActivation(draft => {
      const edge = { source: { kind: "state", field: "one" }, target: { kind: "state", field: "sink" } };
      draft.program.dataflow.edges = [edge, structuredClone(edge)];
    }))).toThrowError(/duplicate data sink/);
  });
});
