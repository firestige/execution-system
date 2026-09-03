import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FrozenWorkflowPackageValidatorV2,
  type WorkflowPackageStaging,
} from "../../src/delivery/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
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
});
