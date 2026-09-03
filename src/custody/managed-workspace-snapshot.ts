import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GitTreeId } from "../contracts/index.js";

export interface ManagedWorkspaceSnapshotLimits {
  readonly maxFileCount: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export class ManagedWorkspaceSnapshotError extends Error {
  readonly code = "WORKSPACE_SNAPSHOT_CAPACITY_EXCEEDED";
  constructor(
    readonly metric: "file-count" | "file-bytes" | "total-bytes",
    readonly limit: number,
    readonly observed: number,
  ) {
    super("WORKSPACE_SNAPSHOT_CAPACITY_EXCEEDED");
    this.name = "ManagedWorkspaceSnapshotError";
  }
}

export const DEFAULT_MANAGED_WORKSPACE_SNAPSHOT_LIMITS: ManagedWorkspaceSnapshotLimits = Object.freeze({
  maxFileCount: 100_000,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
});

function git(repository: string, args: readonly string[], environment?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function userObjectDirectory(repository: string): string {
  const commonDirectory = git(repository, ["rev-parse", "--git-common-dir"]);
  return realpathSync(path.resolve(repository, commonDirectory, "objects"));
}

export function managedWorkspaceObjectEnvironment(
  repository: string,
  objectDirectory: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  mkdirSync(path.join(objectDirectory, "info"), { recursive: true });
  mkdirSync(path.join(objectDirectory, "pack"), { recursive: true });
  const inheritedAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const alternates = [
    userObjectDirectory(repository),
    ...(inheritedAlternates === undefined || inheritedAlternates.length === 0
      ? []
      : inheritedAlternates.split(path.delimiter)),
  ];
  return {
    ...process.env,
    ...extra,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(path.delimiter),
  };
}

/**
 * Captures tracked content and non-ignored untracked content without consulting
 * or changing the user's index and without writing temporary objects to the
 * user's Git object database.
 */
export function captureManagedWorkspaceTree(
  repository: string,
  baseTree?: GitTreeId,
  retainedObjectDirectory?: string,
  limits: ManagedWorkspaceSnapshotLimits = DEFAULT_MANAGED_WORKSPACE_SNAPSHOT_LIMITS,
): GitTreeId {
  const temporary = mkdtempSync(path.join(tmpdir(), "wsr-managed-snapshot-"));
  const index = path.join(temporary, "index");
  const objectDirectory = retainedObjectDirectory ?? path.join(temporary, "objects");
  const environment = managedWorkspaceObjectEnvironment(repository, objectDirectory, { GIT_INDEX_FILE: index });
  try {
    const seed = baseTree ?? git(repository, ["rev-parse", "HEAD^{tree}"]);
    git(repository, ["read-tree", seed], environment);
    git(repository, ["add", "-N", "-A", "--", "."], environment);
    const managedPaths = git(repository, ["ls-files", "-z"], environment)
      .split("\0")
      .filter((item) => item.length > 0);
    if (managedPaths.length > limits.maxFileCount) {
      throw new ManagedWorkspaceSnapshotError("file-count", limits.maxFileCount, managedPaths.length);
    }
    let totalBytes = 0;
    for (const managedPath of managedPaths) {
      const candidate = path.resolve(repository, managedPath);
      let bytes = 0;
      try {
        const metadata = lstatSync(candidate);
        bytes = metadata.isFile() || metadata.isSymbolicLink() ? metadata.size : 0;
      } catch {
        continue;
      }
      if (bytes > limits.maxFileBytes) {
        throw new ManagedWorkspaceSnapshotError("file-bytes", limits.maxFileBytes, bytes);
      }
      totalBytes += bytes;
      if (totalBytes > limits.maxTotalBytes) {
        throw new ManagedWorkspaceSnapshotError("total-bytes", limits.maxTotalBytes, totalBytes);
      }
    }
    git(repository, ["add", "-A", "--", "."], environment);
    return git(repository, ["write-tree"], environment) as GitTreeId;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
