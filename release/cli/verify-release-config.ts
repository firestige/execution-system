import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseConfiguration = Readonly<{
  schemaVersion: string;
  repository: string;
  releaseBranch: string;
  triggerBranch: string;
  assetMode: string;
  acceptanceCommand: string;
  buildCommand: string;
  verifyCommand: string;
  publisherAdapter: string;
  remoteInstallMode: string;
  stablePolicy: string;
  capabilities: readonly string[];
}>;

const KEYS = [
  "schemaVersion", "repository", "releaseBranch", "triggerBranch", "assetMode",
  "acceptanceCommand", "buildCommand", "verifyCommand", "publisherAdapter",
  "remoteInstallMode", "stablePolicy", "capabilities",
] as const;

export function assertReleaseConfiguration(value: ReleaseConfiguration): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...KEYS].sort().join(",")
    || value.schemaVersion !== "wsr.release-component@1.0.0"
    || !/^firestige\/[a-z0-9-]+$/u.test(value.repository)
    || value.releaseBranch !== "main"
    || !/^release\/[a-z0-9._-]+$/u.test(value.triggerBranch)
    || value.stablePolicy !== "qualified-candidate-exact-assets"
    || !Array.isArray(value.capabilities) || value.capabilities.length === 0
    || new Set(value.capabilities).size !== value.capabilities.length
    || KEYS.filter((key) => key !== "capabilities").some((key) => typeof value[key] !== "string" || value[key].length === 0)) {
    throw new Error("RELEASE_CONFIGURATION_INVALID");
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] ?? "release/config/component.json");
  const config = JSON.parse(await readFile(file, "utf8")) as ReleaseConfiguration;
  assertReleaseConfiguration(config);
  process.stdout.write(`${JSON.stringify({ repository: config.repository, status: "PASS" })}\n`);
}
