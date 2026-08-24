import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as createTar } from "tar";

const workflowRepository = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../../workflow-package"));
const destination = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, "../tmp/workflow-release"));
const revision = process.argv[4];
if (revision === undefined || !/^[a-f0-9]{40}$/u.test(revision)) throw new TypeError("WORKFLOW_RELEASE_REVISION_REQUIRED");

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

await mkdir(destination, { recursive: true });
const assets = [];
for (const directory of ["implementation", "system-design"] as const) {
  const definition = JSON.parse(await readFile(path.join(workflowRepository, directory, "definition/package.json"), "utf8"));
  const stage = await mkdtemp(path.join(tmpdir(), "workflow-release-"));
  try {
    await cp(path.join(workflowRepository, directory), path.join(stage, "package"), { recursive: true });
    const name = `workflow-package-${definition.package.name}-${definition.package.version}.tar.gz`;
    const output = path.join(destination, name);
    await createTar({ cwd: stage, file: output, gzip: true, portable: true, noMtime: true }, ["package"]);
    const bytes = await readFile(output);
    assets.push(Object.freeze({ name, sha256: sha256(bytes), bytes: bytes.byteLength, package: definition.package.name, version: definition.package.version, packageDigest: definition.package.digest }));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
const record = Object.freeze({ schemaVersion: "workflow-package.release@1.0.0", revision, tag: "0.3.0", assets: Object.freeze(assets) });
await writeFile(path.join(destination, "workflow-package-release-0.3.0.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
