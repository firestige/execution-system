import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");

describe("release workflow bootstrap", () => {
  it("keeps candidate publication exclusive to release/next push", async () => {
    const [ci, candidate] = await Promise.all([
      readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8"),
      readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8"),
    ]);

    expect(ci).not.toContain("release_candidate:");
    expect(ci).not.toContain("uses: ./.github/workflows/release-candidate.yml");
    expect(candidate).toContain("branches:\n      - release/next");
    expect(candidate).not.toContain("workflow_dispatch:");
    expect(candidate).not.toContain("workflow_call:");
    expect(candidate).toContain("release/request.json");
    expect(candidate).not.toContain("local_manual_e2e_evidence:");
  });

  it("qualifies and tags the RC at the immutable Wave11 product pin, not the publisher revision", async () => {
    const candidate = await readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8");

    expect(candidate).toContain("repository: firestige/workflow-self-recursive");
    expect(candidate).toContain("ref: ${{ steps.request.outputs.authority_ref }}");
    expect(candidate).not.toContain("fix/iter3-interactive-intake-e2e");
    expect(candidate).toContain("submodules: recursive");
    expect(candidate).toContain('ARCHIVE_COMMIT="$(jq -er .execution.candidate_archive_commit');
    expect(candidate).toContain('test "$(git -C execution-system rev-parse HEAD)" = "$ARCHIVE_COMMIT"');
    expect(candidate).toContain("path: release-publisher");
    expect(candidate).toContain('test "$(git -C release-publisher rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(candidate).toContain('"$GITHUB_WORKSPACE/release-publisher/scripts/materialize-unified-release-candidate.ts"');
    expect(candidate).toContain('RELEASE_TARGET: ${{ steps.authority.outputs.archive_commit }}');
    expect(candidate).toContain('--target "$RELEASE_TARGET"');
    expect(candidate).not.toContain('--target "$GITHUB_SHA"');
    expect(candidate).toContain("Install frozen contract checker dependencies");
    expect(candidate).toContain("npm --prefix system-contracts/workflow-dsl-2-candidate ci");
    expect(candidate).not.toContain("npm --prefix system-contracts/workflow-dsl ci");
    expect(candidate).toContain("working-directory: execution-system");
    expect(candidate).toContain("remoteArtifactVerification");
  });

  it("does not expose release inputs through ordinary CI", async () => {
    const ci = await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8");

    expect(ci).not.toContain("authority_manifest:");
    expect(ci).not.toContain("candidate_tag:");
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
    expect(ci).not.toContain("Verify dispatched authority pins the exact Execution candidate");
    expect(ci).not.toContain("fix/iter3-interactive-intake-e2e");
    expect(ci).toContain("submodules: recursive");
    expect(ci).toContain("fetch-depth: 0");
    expect(ci).not.toContain("ref: ed2a0bddda1eeaba77f19c5e543fe0c82d55fefb");
  });
});
