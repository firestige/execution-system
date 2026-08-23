import { describe, expect, it } from "vitest";

import type { ExecutionSiteRef, RunnerActivationContext } from "../../../src/contracts/index.js";
import {
  ValidationActionUnavailableError,
  createMinimalValidationActionAdapter,
  type ValidationActionExpectation,
} from "./validation-action-adapter.js";

const correlation = Object.freeze({
  deliveryIdentity: "delivery.validation-protocol",
  taskIdentity: "task.validation-protocol",
  manifestBindingIdentity: `sha256:${"1".repeat(64)}`,
  packageIdentity: "minimal-review@1.0.0",
  packageDigest: `sha256:${"2".repeat(64)}`,
  snapshotIdentity: "snapshot.minimal-review.1",
  snapshotDigest: `sha256:${"3".repeat(64)}`,
  workflowIdentity: "minimal-review@1.0.0",
  runtimeProfileIdentity: "runtime-profile.runner.langgraph-dsh",
}) as RunnerActivationContext["correlation"];

const intake = Object.freeze({
  validatorIdentity: "validator.intake-checks",
  actionIdentity: "action.intake",
  site: Object.freeze({ kind: "node", nodeIdentity: "node.intake" }) as ExecutionSiteRef,
}) satisfies ValidationActionExpectation;

describe("Wave 4 typed validation action adapter", () => {
  it("accepts one exact typed and correlated declared validation action", async () => {
    const adapter = createMinimalValidationActionAdapter({ correlation, expectations: [intake] });

    await expect(adapter.invoke({
      ...intake,
      correlation,
      input: Object.freeze({ status: "confirmed", authorityMap: Object.freeze({}) }),
    })).resolves.toEqual({ kind: "accepted" });
    expect(adapter.records()).toEqual([expect.objectContaining({
      validatorIdentity: "validator.intake-checks",
      actionIdentity: "action.intake",
      site: { kind: "node", nodeIdentity: "node.intake" },
      correlation,
      disposition: { kind: "accepted" },
    })]);
  });

  it("fails closed before recording effects for stale correlation or identity", async () => {
    const adapter = createMinimalValidationActionAdapter({ correlation, expectations: [intake] });

    await expect(adapter.invoke({
      ...intake,
      actionIdentity: "action.stale",
      correlation,
      input: Object.freeze({ status: "confirmed" }),
    })).resolves.toEqual({ kind: "unavailable", reason: "VALIDATION_ACTION_MISMATCH" });
    await expect(adapter.invoke({
      ...intake,
      correlation: Object.freeze({ ...correlation, deliveryIdentity: "delivery.stale" }) as RunnerActivationContext["correlation"],
      input: Object.freeze({ status: "confirmed" }),
    })).resolves.toEqual({ kind: "unavailable", reason: "VALIDATION_ACTION_MISMATCH" });
    expect(adapter.records()).toEqual([]);
  });

  it("rejects duplicate disposition and exposes no unregistered handler", async () => {
    const adapter = createMinimalValidationActionAdapter({ correlation, expectations: [intake] });
    const request = { ...intake, correlation, input: Object.freeze({ status: "confirmed" }) } as const;

    await expect(adapter.invoke(request)).resolves.toEqual({ kind: "accepted" });
    await expect(adapter.invoke(request)).resolves.toEqual({ kind: "unavailable", reason: "VALIDATION_ACTION_DUPLICATE" });
    expect(adapter.hostOperations["validator.unknown"]).toBeUndefined();
    expect(adapter.records()).toHaveLength(1);
  });

  it.each([
    ["rejected", { kind: "rejected", reason: "VALIDATION_ACTION_REJECTED" }],
    ["unavailable", { kind: "unavailable", reason: "VALIDATION_ACTION_UNAVAILABLE" }],
  ] as const)("returns a typed %s disposition", async (behavior, expected) => {
    const adapter = createMinimalValidationActionAdapter({ correlation, expectations: [intake], behavior });
    await expect(adapter.invoke({ ...intake, correlation, input: Object.freeze({ status: "confirmed" }) })).resolves.toEqual(expected);
  });

  it.each(["throw", "malformed"] as const)("contains %s behavior at the Host-operation boundary", async (behavior) => {
    const adapter = createMinimalValidationActionAdapter({ correlation, expectations: [intake], behavior });
    const handler = adapter.hostOperations["validator.intake-checks"];
    expect(handler).toBeDefined();

    await expect(handler!.execute(Object.freeze({ status: "confirmed" }), Object.freeze({}))).rejects.toBeInstanceOf(
      behavior === "throw" ? Error : TypeError,
    );
  });

  it("maps rejected to Host fail-closed and unavailable to a typed boundary error", async () => {
    const rejected = createMinimalValidationActionAdapter({ correlation, expectations: [intake], behavior: "rejected" });
    await expect(rejected.hostOperations["validator.intake-checks"]!.execute(
      Object.freeze({ status: "confirmed" }), Object.freeze({}),
    )).resolves.toEqual({ accepted: false, value: null });

    const unavailable = createMinimalValidationActionAdapter({ correlation, expectations: [intake], behavior: "unavailable" });
    await expect(unavailable.hostOperations["validator.intake-checks"]!.execute(
      Object.freeze({ status: "confirmed" }), Object.freeze({}),
    )).rejects.toBeInstanceOf(ValidationActionUnavailableError);
  });
});
