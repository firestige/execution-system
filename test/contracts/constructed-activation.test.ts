import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ActivationBoundaryError,
  validateConstructedActivation,
  type ActivationPathInspector,
} from "../../src/contracts/constructed-activation.js";
import { activationFixture } from "../support/activation-fixtures.js";

const existingPath: ActivationPathInspector = (candidate) => !candidate.startsWith("/missing/");

function expectBoundaryCode(input: unknown, code: string): void {
  try {
    validateConstructedActivation(input, { pathExists: existingPath });
  } catch (error) {
    expect(error).toBeInstanceOf(ActivationBoundaryError);
    expect((error as ActivationBoundaryError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("constructed activation boundary", () => {
  it("G00-R2-VALID accepts the complete frozen projection without replacing it", () => {
    const activation = activationFixture();

    const visited: string[] = [];
    const validated = validateConstructedActivation(activation, {
      pathExists: (candidate) => {
        visited.push(candidate);
        return true;
      },
    });

    expect(validated).toBe(activation);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.action.driver.requiredCapabilities)).toBe(true);
    expectTypeOf(validated.action.driver.requiredCapabilities).toEqualTypeOf<readonly string[]>();
    expect(visited).toEqual([
      "/admitted/packages/package-7",
      "/deliveries/delivery-7/worktree",
    ]);
  });

  it("G00-R3-MISSING rejects a missing required identity before effects", () => {
    expectBoundaryCode(
      activationFixture((draft) => delete draft.task.identity),
      "INVALID_ACTIVATION",
    );
  });

  it("G00-R3-NULL rejects null masquerading as explicit ABSENT", () => {
    expectBoundaryCode(
      activationFixture((draft) => {
        draft.lifecycle.controlIdentity = null;
      }),
      "INVALID_ACTIVATION",
    );
  });

  it("G00-R3-CONTENT rejects digest and Contract-family mismatch", () => {
    expectBoundaryCode(
      activationFixture((draft) => {
        draft.package.digest = `sha256:${"b".repeat(64)}`;
        draft.package.contract.familyBinding = "workflow-contract@2";
      }),
      "ACTIVATION_BINDING_MISMATCH",
    );
  });

  it("G00-R3-LOCAL rejects a missing admitted Package materialization", () => {
    expectBoundaryCode(
      activationFixture((draft) => {
        draft.package.localReadOnlyPath = "/missing/package-7";
        draft.manifest.packageLocalReadOnlyPath = "/missing/package-7";
      }),
      "ACTIVATION_LOCAL_BINDING_INVALID",
    );
  });

  it("G00-R3-FORBIDDEN rejects selector and admission surfaces", () => {
    expectBoundaryCode(
      activationFixture((draft) => {
        draft.workflowSelector = "latest";
      }),
      "ACTIVATION_FORBIDDEN_FIELD",
    );
  });

  it.each(["threadId", "checkpointId", "sessionId", "processId"])(
    "G00-R3-NATIVE rejects Runtime-native %s",
    (field) => {
      expectBoundaryCode(
        activationFixture((draft) => {
          draft.runtime[field] = "native-7";
        }),
        "ACTIVATION_NATIVE_IDENTITY_LEAK",
      );
    },
  );

  it.each(["secret", "credential", "apiKey"])(
    "G00-R3-SECRET rejects credential material in %s",
    (field) => {
      expectBoundaryCode(
        activationFixture((draft) => {
          draft.action.driver[field] = "must-not-cross-boundary";
        }),
        "ACTIVATION_SECRET_LEAK",
      );
    },
  );

  it("G00-R3-FROZEN rejects a mutable nested projection", () => {
    const activation = activationFixture(undefined, { freeze: false }) as Record<string, unknown>;
    Object.freeze(activation);

    expectBoundaryCode(activation, "ACTIVATION_NOT_DEEPLY_FROZEN");
  });

  it("G00-R3-PROVIDER rejects an unknown Provider without fallback", () => {
    expectBoundaryCode(
      activationFixture((draft) => {
        draft.action.driver.providerIdentity = "ambient-provider";
        draft.manifest.providerIdentity = "ambient-provider";
      }),
      "ACTIVATION_PROVIDER_UNSUPPORTED",
    );
  });

  it("G00-R3-DRIVER rejects Driver/Provider binding mismatch", () => {
    expectBoundaryCode(
      activationFixture((draft) => {
        draft.action.driver.providerIdentity = "codex-cli";
      }),
      "ACTIVATION_BINDING_MISMATCH",
    );
  });

  it("G00-R3-CORRELATION rejects Action and lifecycle correlation mismatch", () => {
    expectBoundaryCode(
      activationFixture((draft) => {
        draft.action.identity = "rewritten-action";
      }),
      "ACTIVATION_CORRELATION_MISMATCH",
    );
  });
});
