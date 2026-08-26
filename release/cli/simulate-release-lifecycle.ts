import path from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseScenario =
  | "happy"
  | "candidate-main-divergence"
  | "npm-core-published-intake-failed"
  | "digest-mismatch"
  | "tag-collision"
  | "permission-denied"
  | "builtin-token-final-publish";

export function simulateReleaseLifecycle(scenario: ReleaseScenario): "STABLE" | "RECOVERABLE_PARTIAL" {
  if (scenario === "happy" || scenario === "candidate-main-divergence") return "STABLE";
  if (scenario === "npm-core-published-intake-failed") return "RECOVERABLE_PARTIAL";
  throw new Error("RELEASE_STOPPED_BEFORE_STABLE");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scenario = process.argv[2] as ReleaseScenario;
  process.stdout.write(`${JSON.stringify({ scenario, state: simulateReleaseLifecycle(scenario) })}\n`);
}
