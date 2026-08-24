import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");

describe("release workflow bootstrap", () => {
  it("dispatches the candidate publisher through the default-branch-registered CI workflow", async () => {
    const [ci, candidate] = await Promise.all([
      readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8"),
      readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8"),
    ]);

    expect(ci).toContain("release_candidate:");
    expect(ci).toContain("uses: ./.github/workflows/release-candidate.yml");
    expect(ci).toContain("permissions:\n      contents: write");
    expect(candidate).toContain("workflow_call:");
    expect(candidate).toContain("candidate_tag:");
    expect(candidate).toContain("local_manual_e2e_evidence:");
  });

  it("qualifies the RC in the exact sibling authority layout used by component tests", async () => {
    const candidate = await readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8");

    expect(candidate).toContain("path: execution-system");
    expect(candidate).toContain("repository: firestige/system-contracts");
    expect(candidate).toContain("ref: c8e090f80073e3a4a37063d2d0165f190f2ec7f1");
    expect(candidate).toContain("path: system-contracts");
    expect(candidate).toContain("repository: firestige/workflow-package");
    expect(candidate).toContain("ref: 0ff4bc1e29e58542c644e47c738051ef46cb8bbf");
    expect(candidate).toContain("path: workflow-package");
    expect(candidate).toContain("Install frozen contract checker dependencies");
    expect(candidate).toContain("working-directory: execution-system");
    expect(candidate).toContain('"$GITHUB_WORKSPACE/execution-system"');
  });
});
