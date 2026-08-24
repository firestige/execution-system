import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  for (const artifact of metadata.artifacts) {
    await writeFile(path.join(root, `${artifact.name}.publication.json`), `${JSON.stringify({
      schemaVersion: "execution.artifact-publication@1.0.0",
      package: artifact.name === names.core
        ? { name: "@workflow-self-recursive/execution-system", version: "0.1.0" }
        : { name: "@workflow-self-recursive/dsh-intake", version: "0.1.0" },
      compatibility: metadata.compatibility,
      artifact,
    })}\n`);
  }
  return { root, metadata };
}

describe("Iteration 3 release artifact verifier", () => {
  it("keeps the exact DSH runtime as an optional peer for host-neutral package-root consumers", async () => {
    const manifest = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../package.json"), "utf8"));
    expect(manifest.dependencies?.["@deepseek-ai/dsh"]).toBeUndefined();
    expect(manifest.optionalDependencies?.["@deepseek-ai/dsh"]).toBeUndefined();
    expect(manifest.peerDependencies?.["@deepseek-ai/dsh"]).toBe("0.1.1-rc.2");
    expect(manifest.peerDependenciesMeta?.["@deepseek-ai/dsh"]).toEqual({ optional: true });
  });

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

  it("requires one exact publication record for each independently distributed package", async () => {
    const missing = await fixture();
    await writeFile(path.join(missing.root, `${names.plugin}.publication.json`), "{}\n");
    await expect(verifyExecutionReleaseArtifacts(missing.root)).rejects.toMatchObject({ code: "RELEASE_PUBLICATION_RECORD_INVALID" });

    const drifted = await fixture();
    const publicationFile = path.join(drifted.root, `${names.core}.publication.json`);
    await writeFile(publicationFile, `${JSON.stringify({
      schemaVersion: "execution.artifact-publication@1.0.0",
      package: { name: "@workflow-self-recursive/execution-system", version: "0.1.0" },
      compatibility: drifted.metadata.compatibility,
      artifact: { ...drifted.metadata.artifacts[1], sha256: digest("other") },
    })}\n`);
    await expect(verifyExecutionReleaseArtifacts(drifted.root)).rejects.toMatchObject({ code: "RELEASE_PUBLICATION_RECORD_MISMATCH" });
  });
});
