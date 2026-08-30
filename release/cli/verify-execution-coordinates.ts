import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Manifest = Readonly<{
  name: string;
  version: string;
}>;

type CoordinateInput = Readonly<{ core: Manifest; workflow: string }>;

function verify(input: CoordinateInput): string {
  const version = input.core.version;
  if (input.core.name !== "wsr-execution") {
    throw new Error("RELEASE_PACKAGE_VERSION_MISMATCH");
  }
  if (/wsr-execution-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.tgz/u.test(input.workflow)) {
    throw new Error("RELEASE_WORKFLOW_VERSION_HARDCODED");
  }
  return version;
}

export function assertExecutionReleaseCoordinates(input: CoordinateInput): string;
export function assertExecutionReleaseCoordinates(input: string): Promise<string>;
export function assertExecutionReleaseCoordinates(input: CoordinateInput | string): string | Promise<string> {
  if (typeof input !== "string") return verify(input);
  return (async () => {
    const root = path.resolve(input);
    const [core, componentCandidate, componentPromote, authorityWorkflow] = await Promise.all([
      readFile(path.join(root, "package.json"), "utf8").then((value) => JSON.parse(value) as Manifest),
      readFile(path.join(root, ".github/workflows/release-candidate.yml"), "utf8"),
      readFile(path.join(root, ".github/workflows/release-promote.yml"), "utf8"),
      readFile(path.join(root, "../.github/workflows/iter3-execution-ci.yml"), "utf8").catch(() => ""),
    ]);
    return verify({ core, workflow: componentCandidate + componentPromote + authorityWorkflow });
  })();
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = await assertExecutionReleaseCoordinates(path.resolve(process.argv[2] ?? "."));
  process.stdout.write(`${JSON.stringify({ version, status: "PASS" })}\n`);
}
