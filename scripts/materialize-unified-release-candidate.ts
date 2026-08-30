import { createHash } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface BoundFile {
  readonly path: string;
  readonly sha256: string;
}

interface BoundArtifact extends BoundFile {
  readonly package: string;
  readonly version: string;
}

interface UnifiedCandidate {
  readonly schema_version: string;
  readonly status: string;
  readonly execution: {
    readonly metadata: BoundFile;
    readonly release_notes: BoundFile;
    readonly artifacts: readonly BoundArtifact[];
  };
}

function assertBoundFile<T>(value: T): asserts value is T & BoundFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("UNIFIED_CANDIDATE_INVALID");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.path !== "string" || candidate.path.length === 0
    || typeof candidate.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(candidate.sha256)) {
    throw new Error("UNIFIED_CANDIDATE_INVALID");
  }
}

function resolveBoundPath(superproject: string, relative: string): string {
  const root = path.resolve(superproject);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("UNIFIED_CANDIDATE_PATH_INVALID");
  return resolved;
}

async function verifyDigest(file: string, expected: string): Promise<void> {
  const actual = `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
  if (actual !== expected) throw new Error(`UNIFIED_CANDIDATE_DIGEST_MISMATCH: ${file}`);
}

export async function materializeUnifiedCandidate(
  superproject: string,
  manifestPath: string,
  destination: string,
): Promise<{ readonly candidateDirectory: string; readonly version: string; readonly artifactCount: number }> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<UnifiedCandidate>;
  if (manifest.schema_version !== "wsr.iter4-unified-candidate@1.0.0"
    || manifest.status !== "IMMUTABLE_RELEASE_CANDIDATE" || manifest.execution === undefined
    || !Array.isArray(manifest.execution.artifacts) || manifest.execution.artifacts.length !== 1) {
    throw new Error("UNIFIED_CANDIDATE_INVALID");
  }

  assertBoundFile(manifest.execution.metadata);
  assertBoundFile(manifest.execution.release_notes);
  for (const artifact of manifest.execution.artifacts) {
    assertBoundFile(artifact);
    if (typeof artifact.package !== "string" || typeof artifact.version !== "string") {
      throw new Error("UNIFIED_CANDIDATE_INVALID");
    }
  }
  const packages = manifest.execution.artifacts.map((artifact) => artifact.package).sort();
  const versions = new Set(manifest.execution.artifacts.map((artifact) => artifact.version));
  if (packages.join(",") !== "wsr-execution" || versions.size !== 1) {
    throw new Error("UNIFIED_CANDIDATE_COORDINATE_MISMATCH");
  }

  const boundFiles = [manifest.execution.metadata, manifest.execution.release_notes, ...manifest.execution.artifacts];
  const resolved = boundFiles.map((file) => ({ file, absolute: resolveBoundPath(superproject, file.path) }));
  const candidateDirectory = path.dirname(resolved[0]!.absolute);
  if (!resolved.every((item) => path.dirname(item.absolute) === candidateDirectory)) {
    throw new Error("UNIFIED_CANDIDATE_PATH_INVALID");
  }
  await Promise.all(resolved.map(({ file, absolute }) => verifyDigest(absolute, file.sha256)));
  await cp(candidateDirectory, destination, { recursive: true, errorOnExist: true, force: false });

  return {
    candidateDirectory,
    version: manifest.execution.artifacts[0]!.version,
    artifactCount: manifest.execution.artifacts.length,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [superproject, manifestPath, destination] = process.argv.slice(2);
  if (superproject === undefined || manifestPath === undefined || destination === undefined) {
    throw new Error("UNIFIED_CANDIDATE_USAGE_INVALID");
  }
  console.log(JSON.stringify(await materializeUnifiedCandidate(superproject, manifestPath, destination)));
}
