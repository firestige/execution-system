import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertFinalPromotionEligible,
  assertPrereleaseCandidate,
  runReleasePromotionPolicy,
} from "../../scripts/release-promotion-policy.js";

describe("Execution release promotion policy", () => {
  it("accepts only an RC tag derived from the stable package version", () => {
    expect(() => assertPrereleaseCandidate("0.1.1-rc.1", "0.1.1")).not.toThrow();
    expect(() => assertPrereleaseCandidate("0.1.1", "0.1.1")).toThrowError("PRERELEASE_TAG_REQUIRED");
    expect(() => assertPrereleaseCandidate("0.1.2-rc.1", "0.1.1")).toThrowError("PRERELEASE_VERSION_MISMATCH");
    expect(() => assertPrereleaseCandidate("0.1.1-rc.1", "next")).toThrowError("STABLE_PACKAGE_VERSION_REQUIRED");
  });

  it("refuses a final tag until local and remote-prerelease E2E passed for the exact commit and artifacts", () => {
    const evidence = {
      schemaVersion: "execution.release-qualification@1.0.0",
      packageVersion: "0.1.1",
      candidateTag: "0.1.1-rc.1",
      commit: "0123456789abcdef0123456789abcdef01234567",
      artifactMetadataSha256: "sha256:" + "a".repeat(64),
      localE2E: { status: "PASS" },
      remotePrereleaseE2E: { status: "PASS" },
    } as const;

    expect(() => assertFinalPromotionEligible("0.1.1", evidence, evidence.commit, evidence.artifactMetadataSha256, evidence.candidateTag)).not.toThrow();
    expect(() => assertFinalPromotionEligible("0.1.1", {
      ...evidence,
      remotePrereleaseE2E: { status: "FAIL" },
    }, evidence.commit, evidence.artifactMetadataSha256)).toThrowError("REMOTE_PRERELEASE_E2E_REQUIRED");
    expect(() => assertFinalPromotionEligible("0.1.1", {
      ...evidence,
      localE2E: { status: "FAIL" },
    }, evidence.commit, evidence.artifactMetadataSha256)).toThrowError("LOCAL_E2E_REQUIRED");
    expect(() => assertFinalPromotionEligible("0.1.1", {
      ...evidence,
      schemaVersion: "unknown",
    }, evidence.commit, evidence.artifactMetadataSha256)).toThrowError("QUALIFICATION_EVIDENCE_INVALID");
    expect(() => assertFinalPromotionEligible("0.1.1", evidence, "f".repeat(40)))
      .toThrowError("QUALIFICATION_COMMIT_MISMATCH");
    expect(() => assertFinalPromotionEligible("0.1.2", evidence, evidence.commit))
      .toThrowError("FINAL_VERSION_MISMATCH");
    expect(() => assertFinalPromotionEligible("0.1.1", evidence, evidence.commit, "sha256:" + "b".repeat(64)))
      .toThrowError("QUALIFICATION_ARTIFACT_MISMATCH");
    expect(() => assertFinalPromotionEligible("0.1.1", evidence, evidence.commit, evidence.artifactMetadataSha256, "0.1.1-rc.2"))
      .toThrowError("QUALIFICATION_CANDIDATE_MISMATCH");
  });

  it("executes the same candidate and promotion checks used by the workflows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "release-policy-"));
    const metadata = "candidate metadata\n";
    const metadataSha = `sha256:${createHash("sha256").update(metadata).digest("hex")}`;
    const commit = "1".repeat(40);
    await writeFile(path.join(root, "release-metadata.json"), metadata);
    await writeFile(path.join(root, "release-qualification.json"), JSON.stringify({
      schemaVersion: "execution.release-qualification@1.0.0",
      packageVersion: "0.1.1",
      candidateTag: "0.1.1-rc.1",
      commit,
      artifactMetadataSha256: metadataSha,
      localE2E: { status: "PASS" },
      remotePrereleaseE2E: { status: "PASS" },
    }));

    await expect(runReleasePromotionPolicy(["candidate", "0.1.1-rc.1", "0.1.1"])).resolves.toBeUndefined();
    await expect(runReleasePromotionPolicy([
      "promote", "0.1.1", path.join(root, "release-qualification.json"), commit, "0.1.1-rc.1",
    ])).resolves.toBeUndefined();
    await expect(runReleasePromotionPolicy([])).rejects.toThrowError("RELEASE_POLICY_USAGE_INVALID");
  });
});
