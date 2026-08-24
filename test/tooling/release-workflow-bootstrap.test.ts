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
});
