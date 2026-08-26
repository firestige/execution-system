import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyExecutionReleaseArtifacts } from "../../scripts/verify-release-artifacts.js";

export type NpmArtifact = Readonly<{
  package: string;
  version: string;
  file: string;
  sha256: string;
}>;
export type RegistryVersion = Readonly<{
  sha256: string;
  description: string;
  latest?: string;
  versions?: readonly string[];
}>;
export type PublicationAction = Readonly<{
  action: "publish" | "skip-exact";
  package: string;
  file: string;
}>;
export type RegistryLookup = (name: string, version: string) => Promise<RegistryVersion | null>;

const ORDER = ["wsr-execution", "wsr-dsh-intake"] as const;

export async function planNpmPairPublication(
  artifacts: readonly NpmArtifact[], lookup: RegistryLookup,
): Promise<readonly PublicationAction[]> {
  if (artifacts.length !== 2 || artifacts.map((item) => item.package).join(",") !== ORDER.join(",")
    || artifacts[0]?.version !== artifacts[1]?.version) {
    throw new Error("NPM_PAIR_PUBLICATION_SET_INVALID");
  }
  const plan: PublicationAction[] = [];
  for (const artifact of artifacts) {
    const existing = await lookup(artifact.package, artifact.version);
    if (existing !== null && existing.sha256 !== artifact.sha256) {
      throw new Error("NPM_VERSION_DIGEST_COLLISION");
    }
    plan.push({
      action: existing === null ? "publish" : "skip-exact",
      package: artifact.package,
      file: artifact.file,
    });
  }
  return Object.freeze(plan);
}

export async function verifyPublishedNpmPair(
  artifacts: readonly NpmArtifact[], lookup: RegistryLookup,
): Promise<Readonly<{ version: string; packages: readonly string[] }>> {
  if (artifacts.length !== 2 || artifacts.map((item) => item.package).join(",") !== ORDER.join(",")
    || artifacts[0]?.version !== artifacts[1]?.version) {
    throw new Error("NPM_PAIR_PUBLICATION_SET_INVALID");
  }
  const version = artifacts[0]?.version;
  if (version === undefined) throw new Error("NPM_PAIR_PUBLICATION_SET_INVALID");
  for (const artifact of artifacts) {
    const published = await lookup(artifact.package, version);
    if (published === null) throw new Error("NPM_POSTPUBLISH_VERSION_MISSING");
    if (published.sha256 !== artifact.sha256) throw new Error("NPM_VERSION_DIGEST_COLLISION");
    if (published.description.length === 0) throw new Error("NPM_POSTPUBLISH_DESCRIPTION_MISSING");
    if (published.latest !== version) throw new Error("NPM_POSTPUBLISH_LATEST_MISMATCH");
    if (!published.versions?.includes(version)) throw new Error("NPM_POSTPUBLISH_VERSIONS_MISMATCH");
  }
  return Object.freeze({ version, packages: Object.freeze([...ORDER]) });
}

export async function waitForPublishedNpmPair(
  artifacts: readonly NpmArtifact[],
  lookup: RegistryLookup,
  delay: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 5_000)),
  attempts = 12,
): Promise<Readonly<{ version: string; packages: readonly string[] }>> {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await verifyPublishedNpmPair(artifacts, lookup);
    } catch (error) {
      if (error instanceof Error && error.message === "NPM_VERSION_DIGEST_COLLISION") throw error;
      failure = error;
      if (attempt + 1 < attempts) await delay();
    }
  }
  throw failure;
}

async function registryLookup(name: string, version: string): Promise<RegistryVersion | null> {
  const response = await fetch(`https://registry.npmjs.org/${name}/${version}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("NPM_REGISTRY_LOOKUP_FAILED");
  const metadata = await response.json() as {
    description?: unknown;
    dist?: { tarball?: unknown };
  };
  if (typeof metadata.description !== "string" || metadata.description.length === 0
    || typeof metadata.dist?.tarball !== "string") {
    throw new Error("NPM_REGISTRY_METADATA_INVALID");
  }
  const tarball = await fetch(metadata.dist.tarball);
  if (!tarball.ok) throw new Error("NPM_REGISTRY_TARBALL_DOWNLOAD_FAILED");
  const bytes = new Uint8Array(await tarball.arrayBuffer());
  const rootResponse = await fetch(`https://registry.npmjs.org/${name}`);
  if (!rootResponse.ok) throw new Error("NPM_REGISTRY_LOOKUP_FAILED");
  const root = await rootResponse.json() as {
    "dist-tags"?: { latest?: unknown };
    versions?: Record<string, unknown>;
  };
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    description: metadata.description,
    latest: typeof root["dist-tags"]?.latest === "string" ? root["dist-tags"].latest : undefined,
    versions: root.versions === undefined ? undefined : Object.keys(root.versions),
  };
}

async function run(): Promise<void> {
  const directory = path.resolve(process.argv[2] ?? "");
  const execute = process.argv[3] === "--execute";
  if (!directory || (process.argv[3] !== undefined && !execute)) {
    throw new Error("NPM_PAIR_PUBLICATION_USAGE_INVALID");
  }
  const verified = await verifyExecutionReleaseArtifacts(directory);
  const metadata = JSON.parse(
    await readFile(path.join(directory, "release-metadata.json"), "utf8"),
  ) as { artifacts: readonly { name: string; sha256: string }[] };
  const artifacts = ORDER.map((packageName) => {
    const file = `${packageName}-${verified.version}.tgz`;
    const artifact = metadata.artifacts.find((candidate) => candidate.name === file);
    if (artifact === undefined) throw new Error("NPM_PAIR_PUBLICATION_SET_INVALID");
    return { package: packageName, version: verified.version, file, sha256: artifact.sha256 };
  });
  const plan = await planNpmPairPublication(artifacts, registryLookup);
  if (execute) {
    for (const item of plan) {
      if (item.action === "publish") {
        execFileSync("npm", ["publish", path.join(directory, item.file), "--provenance", "--access", "public"], {
          stdio: "inherit",
        });
      }
    }
    await waitForPublishedNpmPair(artifacts, registryLookup);
  }
  process.stdout.write(`${JSON.stringify({ version: verified.version, plan })}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
