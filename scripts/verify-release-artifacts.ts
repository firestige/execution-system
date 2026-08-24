import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const ARTIFACTS = Object.freeze([
  "workflow-self-recursive-dsh-intake-0.1.0.tgz",
  "workflow-self-recursive-execution-system-0.1.0.tgz",
]);
const COMPATIBILITY = Object.freeze({
  node: ">=24.12.0 <25",
  dsh: "0.1.1-rc.2",
  workflowContract: "agentops.workflow-dsl@1.1.0",
  observationContract: "agentops.observation@1.0.0",
});
const PACKAGE_NAMES = Object.freeze<Record<string, string>>({
  "workflow-self-recursive-execution-system-0.1.0.tgz": "@workflow-self-recursive/execution-system",
  "workflow-self-recursive-dsh-intake-0.1.0.tgz": "@workflow-self-recursive/dsh-intake",
});

export class ReleaseArtifactVerificationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function record(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new ReleaseArtifactVerificationError(code);
  }
  return value as Record<string, unknown>;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function verifyExecutionReleaseArtifacts(directory: string): Promise<Readonly<{ version: string; artifactCount: number }>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path.join(directory, "release-metadata.json"), "utf8")); }
  catch { throw new ReleaseArtifactVerificationError("RELEASE_METADATA_INVALID"); }
  const metadata = record(parsed, ["schemaVersion", "version", "compatibility", "artifacts"], "RELEASE_METADATA_INVALID");
  if (metadata.schemaVersion !== "execution.release@1.0.0" || metadata.version !== VERSION || !Array.isArray(metadata.artifacts)) {
    throw new ReleaseArtifactVerificationError("RELEASE_METADATA_INVALID");
  }
  const compatibility = record(metadata.compatibility, Object.keys(COMPATIBILITY), "RELEASE_COMPATIBILITY_MISMATCH");
  if (Object.entries(COMPATIBILITY).some(([key, value]) => compatibility[key] !== value)) {
    throw new ReleaseArtifactVerificationError("RELEASE_COMPATIBILITY_MISMATCH");
  }
  const artifacts = metadata.artifacts.map((candidate) => record(candidate, ["name", "bytes", "sha256", "inventory"], "RELEASE_METADATA_INVALID"));
  const names = artifacts.map((artifact) => artifact.name).sort();
  if (artifacts.length !== ARTIFACTS.length || names.join(",") !== [...ARTIFACTS].sort().join(",")) {
    throw new ReleaseArtifactVerificationError("RELEASE_ARTIFACT_SET_INVALID");
  }
  for (const artifact of artifacts) {
    if (typeof artifact.name !== "string" || typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 1 || typeof artifact.sha256 !== "string" || !Array.isArray(artifact.inventory)
      || artifact.inventory.length === 0 || artifact.inventory.some((item) => typeof item !== "string" || !item.startsWith("package/"))
      || new Set(artifact.inventory).size !== artifact.inventory.length) {
      throw new ReleaseArtifactVerificationError("RELEASE_METADATA_INVALID");
    }
    if (artifact.name === ARTIFACTS[0] && artifact.inventory.some((item) => /(?:workflow-packages?\/|implementation-workflow|system-design-workflow)/u.test(item as string))) {
      throw new ReleaseArtifactVerificationError("RELEASE_ARTIFACT_INVENTORY_INVALID");
    }
    let bytes: Uint8Array;
    try { bytes = await readFile(path.join(directory, artifact.name)); }
    catch { throw new ReleaseArtifactVerificationError("RELEASE_ARTIFACT_SET_INVALID"); }
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new ReleaseArtifactVerificationError("RELEASE_ARTIFACT_DIGEST_MISMATCH");
    }
    let publicationValue: unknown;
    try { publicationValue = JSON.parse(await readFile(path.join(directory, `${artifact.name}.publication.json`), "utf8")); }
    catch { throw new ReleaseArtifactVerificationError("RELEASE_PUBLICATION_RECORD_INVALID"); }
    const publication = record(publicationValue, ["schemaVersion", "package", "compatibility", "artifact"], "RELEASE_PUBLICATION_RECORD_INVALID");
    const packageRecord = record(publication.package, ["name", "version"], "RELEASE_PUBLICATION_RECORD_INVALID");
    const publicationCompatibility = record(publication.compatibility, Object.keys(COMPATIBILITY), "RELEASE_PUBLICATION_RECORD_INVALID");
    const publicationArtifact = record(publication.artifact, ["name", "bytes", "sha256", "inventory"], "RELEASE_PUBLICATION_RECORD_INVALID");
    if (publication.schemaVersion !== "execution.artifact-publication@1.0.0"
      || packageRecord.name !== PACKAGE_NAMES[artifact.name as string]
      || packageRecord.version !== VERSION
      || JSON.stringify(publicationCompatibility) !== JSON.stringify(compatibility)
      || JSON.stringify(publicationArtifact) !== JSON.stringify(artifact)) {
      throw new ReleaseArtifactVerificationError("RELEASE_PUBLICATION_RECORD_MISMATCH");
    }
  }
  return Object.freeze({ version: VERSION, artifactCount: artifacts.length });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyExecutionReleaseArtifacts(path.resolve(process.argv[2] ?? "tmp/release"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
