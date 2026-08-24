import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { create as createTar } from "tar";

export type WorkflowPackageReleaseBuild = Readonly<{
  tag: string;
  assets: readonly Readonly<{ name: string; sha256: string; bytes: number }>[];
}>;

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function packageIdentity(value: unknown): Readonly<{ name: string; version: string; digest: string }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("WORKFLOW_PACKAGE_METADATA_INVALID");
  const metadata = (value as Record<string, unknown>).package;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("WORKFLOW_PACKAGE_METADATA_INVALID");
  const record = metadata as Record<string, unknown>;
  if (typeof record.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.name)
    || typeof record.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(record.version)
    || typeof record.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.digest)) {
    throw new TypeError("WORKFLOW_PACKAGE_IDENTITY_INVALID");
  }
  return Object.freeze({ name: record.name, version: record.version, digest: record.digest });
}

export async function buildWorkflowPackageRelease(input: Readonly<{
  packageDirectory: string;
  destination: string;
  revision: string;
}>): Promise<WorkflowPackageReleaseBuild> {
  if (!/^[a-f0-9]{40}$/u.test(input.revision)) throw new TypeError("WORKFLOW_RELEASE_REVISION_REQUIRED");
  const identity = packageIdentity(JSON.parse(await readFile(path.join(input.packageDirectory, "definition", "package.json"), "utf8")));
  const archiveName = `workflow-package-${identity.name}-${identity.version}.tar.gz`;
  const descriptorName = `workflow-package-${identity.name}-${identity.version}.json`;
  const checksumName = `${archiveName}.sha256`;
  const tag = `workflow-package/${identity.name}/v${identity.version}`;
  const stage = await mkdtemp(path.join(tmpdir(), "workflow-package-release-"));
  await mkdir(input.destination, { recursive: true });
  try {
    await cp(input.packageDirectory, path.join(stage, "package"), { recursive: true, preserveTimestamps: false });
    const archivePath = path.join(input.destination, archiveName);
    await createTar({ cwd: stage, file: archivePath, gzip: true, portable: true, noMtime: true }, ["package"]);
    const archive = await readFile(archivePath);
    const archiveSha256 = sha256(archive);
    const descriptor = Object.freeze({
      schemaVersion: "workflow-package.package-release@1.0.0",
      revision: input.revision,
      tag,
      package: identity,
      archive: Object.freeze({ name: archiveName, sha256: archiveSha256, bytes: archive.byteLength }),
      checksum: Object.freeze({ name: checksumName }),
    });
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
    const checksumBytes = Buffer.from(`${archiveSha256.slice(7)}  ${archiveName}\n`);
    await writeFile(path.join(input.destination, descriptorName), descriptorBytes);
    await writeFile(path.join(input.destination, checksumName), checksumBytes);
    return Object.freeze({
      tag,
      assets: Object.freeze([
        Object.freeze({ name: archiveName, sha256: archiveSha256, bytes: archive.byteLength }),
        Object.freeze({ name: descriptorName, sha256: sha256(descriptorBytes), bytes: descriptorBytes.byteLength }),
        Object.freeze({ name: checksumName, sha256: sha256(checksumBytes), bytes: checksumBytes.byteLength }),
      ]),
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function runWorkflowPackageReleaseCli(
  args: readonly string[],
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<void> {
  const [packageDirectory, destination, revision] = args;
  if (packageDirectory === undefined || destination === undefined || revision === undefined || args.length !== 3) {
    throw new TypeError("USAGE: build-workflow-release-assets <package-directory> <destination> <revision>");
  }
  const result = await buildWorkflowPackageRelease({
    packageDirectory: path.resolve(packageDirectory),
    destination: path.resolve(destination),
    revision,
  });
  write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWorkflowPackageReleaseCli(process.argv.slice(2));
}
