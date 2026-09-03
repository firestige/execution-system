import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { captureManagedWorkspaceTree } from "../src/custody/managed-workspace-snapshot.js";

const managedFileCount = Number.parseInt(process.env.WSR_BENCHMARK_MANAGED_FILES ?? "1000", 10);
const ignoredBytes = Number.parseInt(process.env.WSR_BENCHMARK_IGNORED_BYTES ?? String(512 * 1024 * 1024), 10);
const maximumDurationMs = Number.parseInt(process.env.WSR_BENCHMARK_MAX_MS ?? "10000", 10);
if (![managedFileCount, ignoredBytes, maximumDurationMs].every(Number.isSafeInteger)
  || managedFileCount < 1 || ignoredBytes < 0 || maximumDurationMs < 1) {
  throw new TypeError("INVALID_MANAGED_WORKSPACE_BENCHMARK_CONFIGURATION");
}

const repository = mkdtempSync(path.join(tmpdir(), "managed-snapshot-benchmark-"));
execFileSync("git", ["init", "-q"], { cwd: repository });
execFileSync("git", ["config", "user.email", "snapshot-benchmark@example.invalid"], { cwd: repository });
execFileSync("git", ["config", "user.name", "Snapshot Benchmark"], { cwd: repository });
writeFileSync(path.join(repository, ".gitignore"), "cache/\n");
writeFileSync(path.join(repository, "tracked.txt"), "baseline\n");
execFileSync("git", ["add", "."], { cwd: repository });
execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repository });

const managed = path.join(repository, "managed");
const cache = path.join(repository, "cache");
mkdirSync(managed);
mkdirSync(cache);
for (let index = 0; index < managedFileCount; index += 1) {
  writeFileSync(path.join(managed, `file-${index}.txt`), `managed-${index}\n`);
}
const ignoredCache = path.join(cache, "ignored-cache.bin");
writeFileSync(ignoredCache, "");
truncateSync(ignoredCache, ignoredBytes);
const indexBefore = readFileSync(path.join(repository, ".git", "index"));
const objectsBefore = execFileSync("git", ["count-objects", "-v"], { cwd: repository, encoding: "utf8" });

const startedAt = performance.now();
const tree = captureManagedWorkspaceTree(repository);
const durationMs = Math.round(performance.now() - startedAt);

if (!/^[0-9a-f]{40}$/u.test(tree)) throw new Error("MANAGED_WORKSPACE_BENCHMARK_TREE_INVALID");
if (!readFileSync(path.join(repository, ".git", "index")).equals(indexBefore)) {
  throw new Error("MANAGED_WORKSPACE_BENCHMARK_INDEX_MUTATED");
}
if (execFileSync("git", ["count-objects", "-v"], { cwd: repository, encoding: "utf8" }) !== objectsBefore) {
  throw new Error("MANAGED_WORKSPACE_BENCHMARK_USER_ODB_MUTATED");
}
if (durationMs > maximumDurationMs) throw new Error("MANAGED_WORKSPACE_BENCHMARK_DURATION_EXCEEDED");

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  managedFileCount,
  ignoredBytes,
  durationMs,
  maximumDurationMs,
  tree,
})}\n`);
