import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class ReleasePromotionPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export function assertPrereleaseCandidate(candidateTag: string, packageVersion: string): void {
  if (!STABLE_VERSION.test(packageVersion)) throw new ReleasePromotionPolicyError("STABLE_PACKAGE_VERSION_REQUIRED");
  if (!/-(?:rc)\.(?:0|[1-9]\d*)$/u.test(candidateTag)) {
    throw new ReleasePromotionPolicyError("PRERELEASE_TAG_REQUIRED");
  }
  if (!candidateTag.startsWith(`${packageVersion}-`)) {
    throw new ReleasePromotionPolicyError("PRERELEASE_VERSION_MISMATCH");
  }
}

export type ReleaseQualificationEvidence = Readonly<{
  schemaVersion: string;
  packageVersion: string;
  candidateTag: string;
  commit: string;
  artifactMetadataSha256: string;
  localE2E: Readonly<{ status: string }>;
  remotePrereleaseE2E: Readonly<{ status: string }>;
}>;

export function assertFinalPromotionEligible(
  finalTag: string,
  evidence: ReleaseQualificationEvidence,
  currentCommit: string,
  actualArtifactMetadataSha256?: string,
  expectedCandidateTag?: string,
): void {
  if (!STABLE_VERSION.test(finalTag) || finalTag !== evidence.packageVersion) {
    throw new ReleasePromotionPolicyError("FINAL_VERSION_MISMATCH");
  }
  assertPrereleaseCandidate(evidence.candidateTag, evidence.packageVersion);
  if (evidence.schemaVersion !== "execution.release-qualification@1.0.0"
    || !COMMIT.test(evidence.commit)
    || !SHA256.test(evidence.artifactMetadataSha256)) {
    throw new ReleasePromotionPolicyError("QUALIFICATION_EVIDENCE_INVALID");
  }
  if (evidence.commit !== currentCommit) {
    throw new ReleasePromotionPolicyError("QUALIFICATION_COMMIT_MISMATCH");
  }
  if (evidence.localE2E.status !== "PASS") {
    throw new ReleasePromotionPolicyError("LOCAL_E2E_REQUIRED");
  }
  if (evidence.remotePrereleaseE2E.status !== "PASS") {
    throw new ReleasePromotionPolicyError("REMOTE_PRERELEASE_E2E_REQUIRED");
  }
  if (actualArtifactMetadataSha256 !== undefined
    && evidence.artifactMetadataSha256 !== actualArtifactMetadataSha256) {
    throw new ReleasePromotionPolicyError("QUALIFICATION_ARTIFACT_MISMATCH");
  }
  if (expectedCandidateTag !== undefined && evidence.candidateTag !== expectedCandidateTag) {
    throw new ReleasePromotionPolicyError("QUALIFICATION_CANDIDATE_MISMATCH");
  }
}

export async function runReleasePromotionPolicy(args: readonly string[]): Promise<void> {
  const [operation, tag, value, commit, expectedCandidateTag] = args;
  if (operation === "candidate" && tag !== undefined && value !== undefined) {
    assertPrereleaseCandidate(tag, value);
    return;
  }
  if (operation === "promote" && tag !== undefined && value !== undefined && commit !== undefined
    && expectedCandidateTag !== undefined) {
    const evidenceFile = path.resolve(value);
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8")) as ReleaseQualificationEvidence;
    const metadata = await readFile(path.join(path.dirname(evidenceFile), "release-metadata.json"));
    const metadataSha256 = `sha256:${createHash("sha256").update(metadata).digest("hex")}`;
    assertFinalPromotionEligible(tag, evidence, commit, metadataSha256, expectedCandidateTag);
    return;
  }
  throw new ReleasePromotionPolicyError("RELEASE_POLICY_USAGE_INVALID");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runReleasePromotionPolicy(process.argv.slice(2));
}
