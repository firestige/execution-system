import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureManagedWorkspaceTree,
  ManagedWorkspaceSnapshotError,
} from "../../src/custody/managed-workspace-snapshot.js";

function repositoryFixture(): string {
  const repository = mkdtempSync(path.join(tmpdir(), "managed-snapshot-"));
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "snapshot@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Snapshot Test"], { cwd: repository });
  writeFileSync(path.join(repository, ".gitignore"), "cache/\n");
  writeFileSync(path.join(repository, "tracked.txt"), "baseline\n");
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repository });
  return repository;
}

describe("managed workspace snapshot capacity", () => {
  it("returns a stable bounded diagnostic without changing the user index or object database", () => {
    const repository = repositoryFixture();
    writeFileSync(path.join(repository, "large.txt"), "0123456789");
    const indexBefore = readFileSync(path.join(repository, ".git", "index"));
    const objectsBefore = execFileSync("git", ["count-objects", "-v"], { cwd: repository, encoding: "utf8" });

    expect(() => captureManagedWorkspaceTree(repository, undefined, undefined, {
      maxFileCount: 10,
      maxFileBytes: 9,
      maxTotalBytes: 100,
    })).toThrowError(expect.objectContaining({
      code: "WORKSPACE_SNAPSHOT_CAPACITY_EXCEEDED",
      metric: "file-bytes",
      limit: 9,
      observed: 10,
    }) satisfies Partial<ManagedWorkspaceSnapshotError>);
    expect(readFileSync(path.join(repository, ".git", "index"))).toEqual(indexBefore);
    expect(execFileSync("git", ["count-objects", "-v"], { cwd: repository, encoding: "utf8" })).toBe(objectsBefore);
  });

  it("does not count ignored cache content toward managed capacity", () => {
    const repository = repositoryFixture();
    mkdirSync(path.join(repository, "cache"));
    writeFileSync(path.join(repository, "cache", "large.bin"), "x".repeat(10_000));

    expect(captureManagedWorkspaceTree(repository, undefined, undefined, {
      maxFileCount: 10,
      maxFileBytes: 1_000,
      maxTotalBytes: 1_000,
    })).toMatch(/^[0-9a-f]{40}$/u);
  });
});
