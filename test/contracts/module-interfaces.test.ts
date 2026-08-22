import { describe, expect, expectTypeOf, it } from "vitest";

import {
  INTERFACE_VERSION,
  PROVIDER_BINDINGS,
  known,
  rejected,
  unknown,
  type ExplicitKnowledge,
  type ModuleRequest,
  type ModuleResult,
} from "../../src/contracts/module-interfaces.js";

describe("shared module interfaces", () => {
  it("G00-INTERFACE-IDENTITY freezes one exact internal Interface version", () => {
    expect(INTERFACE_VERSION).toBe("runner.internal-interface@1.0.0");
  });

  it("G00-EXPLICIT-UNKNOWN represents known and unknown without null/undefined", () => {
    const knownValue = known({ checkpointIdentity: "checkpoint-7" });
    const unknownValue = unknown("runner.module.004", "PUBLICATION_DISPOSITION_UNKNOWN");

    expect(knownValue).toEqual({ state: "KNOWN", value: { checkpointIdentity: "checkpoint-7" } });
    expect(unknownValue).toEqual({
      state: "UNKNOWN",
      owner: "runner.module.004",
      reasonCode: "PUBLICATION_DISPOSITION_UNKNOWN",
    });
    expect(Object.isFrozen(knownValue)).toBe(true);
    expect(Object.isFrozen(unknownValue)).toBe(true);
    expectTypeOf(unknownValue).toMatchTypeOf<ExplicitKnowledge<never>>();
  });

  it("G00-TYPED-RESULT preserves owner, operation, and typed rejection", () => {
    const failure = rejected(
      "runner.module.003",
      "invoke",
      "PROVIDER_NOT_IMPLEMENTED",
      false,
    );

    expect(failure).toEqual({
      status: "REJECTED",
      owner: "runner.module.003",
      operation: "invoke",
      error: { code: "PROVIDER_NOT_IMPLEMENTED", retryable: false },
    });
    expectTypeOf(failure).toMatchTypeOf<ModuleResult<never>>();
  });

  it("G00-MODULE-REQUEST carries stable request and Manifest binding identities", () => {
    const request: ModuleRequest<"activate", { readonly profileIdentity: string }> = {
      interfaceVersion: INTERFACE_VERSION,
      requestIdentity: "request-7",
      deliveryIdentity: "delivery-7",
      manifestBindingIdentity: "manifest-binding-7",
      operation: "activate",
      payload: { profileIdentity: "runner-profile-v1" },
    };

    expect(request.operation).toBe("activate");
  });

  it("G00-PROVIDER-VOCABULARY selects DSH implementation and two exact Iter2 shells", () => {
    expect(PROVIDER_BINDINGS).toEqual({
      "dsh-headless": {
        availability: "IMPLEMENTATION_SELECTED",
        capabilities: ["agent.invoke", "cwd.bound", "session.scoped", "child.cancel"],
      },
      "copilot-sdk": {
        availability: "UNSUPPORTED_ITER2",
        reasonCode: "PROVIDER_NOT_IMPLEMENTED",
      },
      "codex-cli": {
        availability: "UNSUPPORTED_ITER2",
        reasonCode: "PROVIDER_NOT_IMPLEMENTED",
      },
    });
    expect(Object.isFrozen(PROVIDER_BINDINGS)).toBe(true);
  });
});
