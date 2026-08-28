import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FrozenWorkflowPackageValidator,
  FrozenWorkflowPackageValidatorV2,
  WorkflowPackageStoreError,
  type WorkflowPackageStaging,
} from "../../src/delivery/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const v1 = path.join(repositoryRoot, "system-contracts", "workflow-dsl", "examples", "minimal");
const v2 = path.join(repositoryRoot, "system-contracts", "workflow-dsl-2-candidate", "generated", "examples", "minimal");

function staging(definitionPath: string): WorkflowPackageStaging {
  return Object.freeze({
    id: "fixture",
    path: definitionPath,
    materialPath: definitionPath,
    definitionPath,
    packagePath: definitionPath,
    candidate: Object.freeze({
      name: "example-minimal-review",
      exactVersion: "1.0.0",
      archive: new Uint8Array(),
      archiveDigest: `sha256:${"0".repeat(64)}`,
      descriptorDigest: `sha256:${"1".repeat(64)}`,
    }),
  });
}

describe("exact Workflow DSL 2.0 Package validation", () => {
  it("validates the standalone 2.0 machine candidate and returns exact Snapshot Role bindings", async () => {
    const validator = new FrozenWorkflowPackageValidatorV2({
      contractVersion: "2.0.0",
      providerIdentity: "provider.dsh",
      providerCapabilities: ["structured-completion", "action-interaction"],
      hostCapabilities: ["deterministic-validation", "deterministic-selection", "deterministic-transformation"],
    });

    await expect(validator.validate(staging(v2))).resolves.toMatchObject({
      name: "example-minimal-review",
      exactVersion: "1.0.0",
      workflowId: "minimal-review",
      workflowSnapshot: {
        workflowId: "minimal-review",
        workflowVersion: "1.0.0",
        snapshotId: "snapshot.minimal-review.1",
        snapshotDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      agentActionRoles: [
        { roleId: "role.facilitator", rolePromptIdentity: "role.prompt.facilitator" },
        { roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer" },
      ],
    });
  });

  it("rejects 1.1 bytes through 2.0 dispatch and 2.0 bytes through historical 1.1 dispatch", async () => {
    const validatorV2 = new FrozenWorkflowPackageValidatorV2({
      contractVersion: "2.0.0",
      providerIdentity: "provider.dsh",
      providerCapabilities: ["structured-completion", "action-interaction"],
      hostCapabilities: ["deterministic-validation", "deterministic-selection", "deterministic-transformation"],
    });
    const validatorV1 = new FrozenWorkflowPackageValidator({
      contractVersion: "1.1.0",
      providerKey: "dsh",
      providerCapabilities: ["structured-completion", "action-interaction"],
      hostCapabilities: ["deterministic-validation", "deterministic-selection", "deterministic-transformation"],
    });

    await expect(validatorV2.validate(staging(v1))).rejects.toBeInstanceOf(WorkflowPackageStoreError);
    await expect(validatorV1.validate(staging(v2))).rejects.toBeInstanceOf(WorkflowPackageStoreError);
  });
});
