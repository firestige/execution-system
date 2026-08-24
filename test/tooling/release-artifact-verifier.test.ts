import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyExecutionReleaseArtifacts } from "../../scripts/verify-release-artifacts.js";

const names = {
  core: "workflow-self-recursive-execution-system-0.1.0.tgz",
  plugin: "workflow-self-recursive-dsh-intake-0.1.0.tgz",
} as const;

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "execution-release-verifier-"));
  await writeFile(path.join(root, names.core), "core");
  await writeFile(path.join(root, names.plugin), "plugin");
  const metadata = {
    schemaVersion: "execution.release@1.0.0",
    version: "0.1.0",
    compatibility: {
      node: ">=24.12.0 <25", dsh: "0.1.1-rc.2",
      workflowContract: "agentops.workflow-dsl@1.1.0", observationContract: "agentops.observation@1.0.0",
    },
    artifacts: [
      { name: names.plugin, bytes: 6, sha256: digest("plugin"), inventory: ["package/package.json", "package/skills/workflow-execution/SKILL.md"] },
      { name: names.core, bytes: 4, sha256: digest("core"), inventory: ["package/package.json", "package/dist/index.js"] },
    ],
  };
  await writeFile(path.join(root, "release-metadata.json"), `${JSON.stringify(metadata)}\n`);
  return { root, metadata };
}

describe("Iteration 3 release artifact verifier", () => {
  it("accepts only the exact compatibility tuple, artifact set, digests, and ownership inventory", async () => {
    const { root } = await fixture();
    await expect(verifyExecutionReleaseArtifacts(root)).resolves.toMatchObject({ version: "0.1.0", artifactCount: 2 });
  });

  it("fails closed for digest, tuple, artifact-set, and embedded Workflow Package drift", async () => {
    const changed = await fixture();
    await writeFile(path.join(changed.root, names.plugin), "changed");
    await expect(verifyExecutionReleaseArtifacts(changed.root)).rejects.toMatchObject({ code: "RELEASE_ARTIFACT_DIGEST_MISMATCH" });

    const incompatible = await fixture();
    incompatible.metadata.compatibility.dsh = "0.1.1-rc.3";
    await writeFile(path.join(incompatible.root, "release-metadata.json"), JSON.stringify(incompatible.metadata));
    await expect(verifyExecutionReleaseArtifacts(incompatible.root)).rejects.toMatchObject({ code: "RELEASE_COMPATIBILITY_MISMATCH" });

    const missing = await fixture();
    missing.metadata.artifacts.pop();
    await writeFile(path.join(missing.root, "release-metadata.json"), JSON.stringify(missing.metadata));
    await expect(verifyExecutionReleaseArtifacts(missing.root)).rejects.toMatchObject({ code: "RELEASE_ARTIFACT_SET_INVALID" });

    const embedded = await fixture();
    embedded.metadata.artifacts[0]!.inventory.push("package/workflow-packages/implementation-workflow/package.yaml");
    await writeFile(path.join(embedded.root, "release-metadata.json"), JSON.stringify(embedded.metadata));
    await expect(verifyExecutionReleaseArtifacts(embedded.root)).rejects.toMatchObject({ code: "RELEASE_ARTIFACT_INVENTORY_INVALID" });
  });
});
