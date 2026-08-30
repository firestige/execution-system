import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { verifyExecutionReleaseArtifacts } from "./verify-release-artifacts.js";
import { renderReleaseNotes } from "../release/cli/verify-release-notes.js";

const repository = path.resolve(import.meta.dirname, "..");
const destination = path.resolve(process.argv[2] ?? path.join(repository, "tmp/release"));
const coreManifest = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")) as { readonly version: string };
const version = coreManifest.version;
const coreArchiveName = `wsr-execution-${version}.tgz`;
const packageNames = Object.freeze<Record<string, string>>({
  [coreArchiveName]: "wsr-execution",
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pack(directory: string): void {
  execFileSync("npm", ["pack", "--silent", "--pack-destination", destination], {
    cwd: directory,
    env: { ...process.env, WSR_RELEASE_PACK_MODE: "verified-builder" },
    stdio: "inherit",
  });
}

await mkdir(destination, { recursive: true });
await rm(path.join(destination, coreArchiveName), { force: true });
execFileSync("pnpm", ["build"], { cwd: repository, stdio: "inherit" });
pack(repository);

const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz")).sort();
const artifacts = [];
for (const name of archives) {
  const file = path.join(destination, name);
  const bytes = await readFile(file);
  const inventory = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  artifacts.push(Object.freeze({ name, bytes: bytes.byteLength, sha256: sha256(bytes), inventory }));
}
const compatibility = Object.freeze({
  node: ">=24.12.0 <25",
  dsh: "0.1.1-rc.2",
  workflowContract: "agentops.workflow-dsl@1.1.0",
  observationContract: "agentops.observation@1.0.0",
});
const renderedNotes = renderReleaseNotes(
  version,
  compatibility,
  await readFile(path.join(repository, "CHANGELOG.md"), "utf8"),
);
const releaseNotesFile = "release-notes.md";
await writeFile(path.join(destination, releaseNotesFile), renderedNotes.notes, "utf8");
const finalMetadata = Object.freeze({
  schemaVersion: "execution.release@1.0.0",
  version,
  compatibility,
  releaseNotes: Object.freeze({
    file: releaseNotesFile,
    sha256: sha256(new TextEncoder().encode(renderedNotes.notes)),
    changelogSectionSha256: renderedNotes.changelogSectionSha256,
  }),
  artifacts: Object.freeze(artifacts),
});
await writeFile(path.join(destination, "release-metadata.json"), `${JSON.stringify(finalMetadata, null, 2)}\n`, "utf8");
for (const artifact of artifacts) {
  const packageName = packageNames[artifact.name];
  if (packageName === undefined) throw new Error(`unexpected release artifact: ${artifact.name}`);
  const publication = Object.freeze({
    schemaVersion: "execution.artifact-publication@1.0.0",
    package: Object.freeze({ name: packageName, version: finalMetadata.version }),
    compatibility: finalMetadata.compatibility,
    artifact,
  });
  await writeFile(path.join(destination, `${artifact.name}.publication.json`), `${JSON.stringify(publication, null, 2)}\n`, "utf8");
}
await verifyExecutionReleaseArtifacts(destination);
