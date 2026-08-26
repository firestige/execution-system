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

  it("qualifies and tags the RC at the immutable Wave11 product pin, not the publisher revision", async () => {
    const candidate = await readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8");

    expect(candidate).toContain("repository: firestige/workflow-self-recursive");
    expect(candidate).toContain("ref: ${{ steps.request.outputs.authority_ref }}");
    expect(candidate).not.toContain("fix/iter3-interactive-intake-e2e");
    expect(candidate).toContain("submodules: recursive");
    expect(candidate).toContain('ARCHIVE_COMMIT="$(jq -er .execution.candidate_archive_commit');
    expect(candidate).toContain('test "$(git -C execution-system rev-parse HEAD)" = "$ARCHIVE_COMMIT"');
    expect(candidate).toContain('RELEASE_TARGET: ${{ steps.authority.outputs.archive_commit }}');
    expect(candidate).toContain('--target "$RELEASE_TARGET"');
    expect(candidate).not.toContain('--target "$GITHUB_SHA"');
    expect(candidate).toContain("Install frozen contract checker dependencies");
    expect(candidate).toContain("working-directory: execution-system");
    expect(candidate).toContain('"$GITHUB_WORKSPACE/execution-system"');
  });

  it("passes the unified authority manifest through the registered CI bootstrap", async () => {
    const ci = await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8");

    expect(ci).toContain("authority_manifest:");
    expect(ci).toContain("authority_manifest: ${{ inputs.authority_manifest }}");
  });

  it("scopes every GitHub Release operation to the component repository", async () => {
    const candidate = await readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8");
    const releaseCommands = candidate.split("\n").filter((line) => /gh release (?:view|create|download|upload)/u.test(line));

    expect(releaseCommands.length).toBeGreaterThan(0);
    expect(releaseCommands.every((line) => line.includes('--repo "$GITHUB_REPOSITORY"'))).toBe(true);
  });

  it("keeps ordinary component PR qualification on the stable super-project authority", async () => {
    const ci = await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8");

    expect(ci).toContain("ref: main");
    expect(ci).not.toContain("fix/iter3-interactive-intake-e2e");
    expect(ci).toContain("submodules: recursive");
    expect(ci).toContain("fetch-depth: 0");
    expect(ci).not.toContain("ref: ed2a0bddda1eeaba77f19c5e543fe0c82d55fefb");
  });
});
