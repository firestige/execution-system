import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

export type DshProfileCommandRunner = (args: readonly string[]) => Promise<string> | string;

function parseAllowBuilds(output: string): Record<string, boolean> {
  const trimmed = output.trim();
  if (trimmed.length === 0 || trimmed === "undefined") return {};
  const value = JSON.parse(trimmed) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("DSH_PROFILE_ALLOW_BUILDS_INVALID");
  }
  const entries = Object.entries(value);
  if (entries.some(([, allowed]) => typeof allowed !== "boolean")) {
    throw new TypeError("DSH_PROFILE_ALLOW_BUILDS_INVALID");
  }
  return Object.fromEntries(entries) as Record<string, boolean>;
}

export async function ensureDshProfileInstallationPolicy(
  profile: string,
  run: DshProfileCommandRunner,
): Promise<Readonly<Record<string, boolean>>> {
  const existing = parseAllowBuilds(await run([
    "plugin", "--profile", profile, "config", "get", "--json", "allowBuilds",
  ]));
  const allowBuilds = Object.fromEntries(Object.entries({
    ...existing,
    "better-sqlite3": true,
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) as Record<string, boolean>;
  await run([
    "plugin", "--profile", profile, "config", "set", "--location=project", "--json",
    "allowBuilds", JSON.stringify(allowBuilds),
  ]);
  return Object.freeze(allowBuilds);
}

export async function bindLocalPackageCandidate(
  profileDirectory: string,
  packageName: string,
  version: string,
  archive: string,
): Promise<void> {
  if (!path.isAbsolute(profileDirectory) || !path.isAbsolute(archive)) {
    throw new TypeError("DSH_LOCAL_CANDIDATE_PATH_NOT_ABSOLUTE");
  }
  if (packageName.length === 0 || version.length === 0) {
    throw new TypeError("DSH_LOCAL_CANDIDATE_COORDINATE_INVALID");
  }
  const workspaceFile = path.join(profileDirectory, "pnpm-workspace.yaml");
  const document = parse(await readFile(workspaceFile, "utf8")) as Record<string, unknown>;
  const existing = document.overrides;
  if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
    throw new TypeError("DSH_LOCAL_CANDIDATE_OVERRIDES_INVALID");
  }
  document.overrides = {
    ...(existing as Record<string, unknown> | undefined),
    [packageName]: `file:${archive}`,
  };
  await writeFile(workspaceFile, stringify(document), "utf8");
}
