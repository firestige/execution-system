import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type MatrixEntry = Readonly<{
  repository: string;
  assetMode: string;
  publisherAdapter: string;
  releaseMode: "active" | "parameter-only" | "excluded";
}>;
type CapabilityMatrix = Readonly<{
  schemaVersion: string;
  components: readonly MatrixEntry[];
}>;

const EXPECTED = new Map([
  ["firestige/wsr-execution", "active"],
  ["firestige/wsr-evidence", "active"],
  ["firestige/wsr-contracts", "active"],
  ["firestige/wsr-workflow-package", "active"],
  ["firestige/wsr-evolution", "parameter-only"],
  ["firestige/bi", "excluded"],
]);

export function assertCapabilityMatrix(value: CapabilityMatrix): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "components,schemaVersion"
    || value.schemaVersion !== "wsr.release-capability-matrix@1.0.0"
    || !Array.isArray(value.components) || value.components.length !== EXPECTED.size) {
    throw new Error("RELEASE_CAPABILITY_MATRIX_INVALID");
  }
  const repositories = new Set<string>();
  for (const component of value.components) {
    if (Object.keys(component).sort().join(",") !== "assetMode,publisherAdapter,releaseMode,repository"
      || EXPECTED.get(component.repository) !== component.releaseMode
      || component.assetMode.length === 0 || component.publisherAdapter.length === 0
      || repositories.has(component.repository)) {
      throw new Error("RELEASE_CAPABILITY_MATRIX_INVALID");
    }
    repositories.add(component.repository);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] ?? "release/config/capability-matrix.json");
  const matrix = JSON.parse(await readFile(file, "utf8")) as CapabilityMatrix;
  assertCapabilityMatrix(matrix);
  process.stdout.write(`${JSON.stringify({ components: matrix.components.length, status: "PASS" })}\n`);
}
