import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { verifyExecutionReleaseArtifacts } from "./verify-release-artifacts.js";
import { verifyDshIntakeDistribution } from "./verify-dsh-intake-distribution.js";

const repository = path.resolve(import.meta.dirname, "..");
const destination = path.resolve(process.argv[2] ?? path.join(repository, "tmp/release"));
const coreManifest = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")) as { readonly version: string };
const pluginManifest = JSON.parse(await readFile(path.join(repository, "packages/dsh-intake/package.json"), "utf8")) as {
  readonly version: string;
  readonly dsh?: { readonly compatibility?: { readonly executionSystem?: string } };
};
if (coreManifest.version !== pluginManifest.version
  || pluginManifest.dsh?.compatibility?.executionSystem !== coreManifest.version) {
  throw new Error("RELEASE_PACKAGE_VERSION_MISMATCH");
}
const version = coreManifest.version;
const coreArchiveName = `workflow-self-recursive-execution-system-${version}.tgz`;
const pluginArchiveName = `workflow-self-recursive-dsh-intake-${version}.tgz`;
const packageNames = Object.freeze<Record<string, string>>({
  [coreArchiveName]: "@workflow-self-recursive/execution-system",
  [pluginArchiveName]: "@workflow-self-recursive/dsh-intake",
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pack(directory: string): void {
  execFileSync("npm", ["pack", "--silent", "--pack-destination", destination], { cwd: directory, stdio: "inherit" });
}

await mkdir(destination, { recursive: true });
await verifyDshIntakeDistribution(path.join(repository, "packages/dsh-intake"));
await Promise.all([
  coreArchiveName,
  pluginArchiveName,
].map((name) => rm(path.join(destination, name), { force: true })));
execFileSync("pnpm", ["build"], { cwd: repository, stdio: "inherit" });
pack(repository);
pack(path.join(repository, "packages/dsh-intake"));

const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz")).sort();
const artifacts = [];
for (const name of archives) {
  const file = path.join(destination, name);
  const bytes = await readFile(file);
  const inventory = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  artifacts.push(Object.freeze({ name, bytes: bytes.byteLength, sha256: sha256(bytes), inventory }));
}
const metadata = Object.freeze({
  schemaVersion: "execution.release@1.0.0",
  version,
  compatibility: Object.freeze({
    node: ">=24.12.0 <25",
    dsh: "0.1.1-rc.2",
    workflowContract: "agentops.workflow-dsl@1.1.0",
    observationContract: "agentops.observation@1.0.0",
  }),
  artifacts: Object.freeze(artifacts),
});
await writeFile(path.join(destination, "release-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
for (const artifact of artifacts) {
  const packageName = packageNames[artifact.name];
  if (packageName === undefined) throw new Error(`unexpected release artifact: ${artifact.name}`);
  const publication = Object.freeze({
    schemaVersion: "execution.artifact-publication@1.0.0",
    package: Object.freeze({ name: packageName, version: metadata.version }),
    compatibility: metadata.compatibility,
    artifact,
  });
  await writeFile(path.join(destination, `${artifact.name}.publication.json`), `${JSON.stringify(publication, null, 2)}\n`, "utf8");
}
await verifyExecutionReleaseArtifacts(destination);
