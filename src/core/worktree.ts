import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

export class WorktreeAdmissionError extends Error {
  constructor(readonly code: "INVALID_WORKTREE" | "WORKTREE_OUT_OF_SCOPE") {
    super(code);
    this.name = "WorktreeAdmissionError";
  }
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function gitMarker(directory: string): Promise<boolean> {
  try {
    const marker = await lstat(join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

export async function canonicalizeWorktree(candidate: string, allowedRoots: readonly string[]): Promise<string> {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.length > 4096) {
    throw new WorktreeAdmissionError("INVALID_WORKTREE");
  }
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
    if (!(await stat(canonicalCandidate)).isDirectory()) throw new WorktreeAdmissionError("INVALID_WORKTREE");
  } catch (cause) {
    if (cause instanceof WorktreeAdmissionError) throw cause;
    throw new WorktreeAdmissionError("INVALID_WORKTREE");
  }
  const scope = allowedRoots.find((root) => within(root, canonicalCandidate));
  if (scope === undefined) throw new WorktreeAdmissionError("WORKTREE_OUT_OF_SCOPE");
  let cursor = canonicalCandidate;
  while (within(scope, cursor)) {
    if (await gitMarker(cursor)) {
      const revalidated = await realpath(cursor);
      if (revalidated !== cursor || !within(scope, revalidated) || !(await gitMarker(revalidated))) {
        throw new WorktreeAdmissionError("INVALID_WORKTREE");
      }
      return revalidated;
    }
    if (cursor === scope) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new WorktreeAdmissionError("INVALID_WORKTREE");
}

