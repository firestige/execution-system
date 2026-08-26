import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertExecutionReleaseCoordinates } from "../../release/cli/verify-execution-coordinates.js";
import {
  assertReleaseConfiguration,
  type ReleaseConfiguration,
} from "../../release/cli/verify-release-config.js";
import {
  planNpmPairPublication,
  verifyPublishedNpmPair,
  waitForPublishedNpmPair,
  type RegistryVersion,
} from "../../release/cli/publish-npm-pair.js";
import { assertReleaseNotes, renderReleaseNotes } from "../../release/cli/verify-release-notes.js";
import { simulateReleaseLifecycle } from "../../release/cli/simulate-release-lifecycle.js";
import { assertCapabilityMatrix } from "../../release/cli/verify-release-matrix.js";
import { isChangelogMetaCommit } from "../../release/cli/changelog-policy.js";
import { materializeUnifiedCandidate } from "../../scripts/materialize-unified-release-candidate.js";

const repository = path.resolve(import.meta.dirname, "../..");

describe("Iteration 4 release automation", () => {
  it("excludes changelog regeneration and immutable candidate archival commits", () => {
    expect(isChangelogMetaCommit(["CHANGELOG.md"])).toBe(true);
    expect(isChangelogMetaCommit([
      "release/candidates/iter4-wave11/release-metadata.json",
      "release/candidates/iter4-wave11/wsr-execution-0.1.3.tgz",
    ])).toBe(true);
    expect(isChangelogMetaCommit([
      "release/candidates/iter4-wave11/release-metadata.json",
      "src/index.ts",
    ])).toBe(false);
    expect(isChangelogMetaCommit([])).toBe(false);
  });

  it("validates the language-neutral lifecycle configuration and Execution capabilities", async () => {
    const config = JSON.parse(
      await readFile(path.join(repository, "release/config/component.json"), "utf8"),
    ) as ReleaseConfiguration;

    expect(() => assertReleaseConfiguration(config)).not.toThrow();
    expect(config).toMatchObject({
      schemaVersion: "wsr.release-component@1.0.0",
      repository: "firestige/execution-system",
      releaseBranch: "main",
      triggerBranch: "release/next",
      assetMode: "npm-pair",
      publisherAdapter: "npm-pair+dsh+github-release",
      stablePolicy: "qualified-candidate-exact-assets",
    });
  });

  it("keeps ecosystem adapters explicit and Evolution parameter-only", async () => {
    const matrix = JSON.parse(
      await readFile(path.join(repository, "release/config/capability-matrix.json"), "utf8"),
    );

    expect(() => assertCapabilityMatrix(matrix)).not.toThrow();
    expect(matrix.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: "firestige/evidence-system", assetMode: "python-wheel-sdist+oci" }),
      expect.objectContaining({ repository: "firestige/evolution-system", releaseMode: "parameter-only" }),
      expect.objectContaining({ repository: "firestige/bi", releaseMode: "excluded" }),
    ]));
    expect(matrix.components.find((item: { repository: string }) => item.repository === "firestige/evidence-system").publisherAdapter)
      .not.toContain("npm");
  });

  it("checks every lockstep coordinate and rejects a dependency or workflow filename drift", async () => {
    await expect(assertExecutionReleaseCoordinates(repository)).resolves.toBe("0.1.3");

    const core = { name: "wsr-execution", version: "0.1.3" };
    const intake = {
      name: "wsr-dsh-intake",
      version: "0.1.3",
      dependencies: { "wsr-execution": "0.1.1" },
      dsh: { compatibility: { executionSystem: "0.1.3" } },
    };
    expect(() => assertExecutionReleaseCoordinates({ core, intake, workflow: "VERSION=dynamic" }))
      .toThrowError("RELEASE_PACKAGE_VERSION_MISMATCH");
    expect(() => assertExecutionReleaseCoordinates({
      core,
      intake: { ...intake, dependencies: { "wsr-execution": "0.1.3" } },
      workflow: "wsr-execution-0.1.3.tgz",
    })).toThrowError("RELEASE_WORKFLOW_VERSION_HARDCODED");
  });

  it("publishes core before intake and resumes only an exact already-published coordinate", async () => {
    const artifacts = [
      { package: "wsr-execution", version: "0.1.3", file: "wsr-execution-0.1.3.tgz", sha256: "sha256:" + "a".repeat(64) },
      { package: "wsr-dsh-intake", version: "0.1.3", file: "wsr-dsh-intake-0.1.3.tgz", sha256: "sha256:" + "b".repeat(64) },
    ] as const;
    const absent = async (): Promise<RegistryVersion | null> => null;

    await expect(planNpmPairPublication(artifacts, absent)).resolves.toEqual([
      { action: "publish", package: "wsr-execution", file: "wsr-execution-0.1.3.tgz" },
      { action: "publish", package: "wsr-dsh-intake", file: "wsr-dsh-intake-0.1.3.tgz" },
    ]);

    const coreAlreadyPublished = async (name: string): Promise<RegistryVersion | null> => (
      name === "wsr-execution" ? { sha256: artifacts[0].sha256, description: "core" } : null
    );
    await expect(planNpmPairPublication(artifacts, coreAlreadyPublished)).resolves.toEqual([
      { action: "skip-exact", package: "wsr-execution", file: "wsr-execution-0.1.3.tgz" },
      { action: "publish", package: "wsr-dsh-intake", file: "wsr-dsh-intake-0.1.3.tgz" },
    ]);

    const collision = async (): Promise<RegistryVersion> => ({
      sha256: "sha256:" + "c".repeat(64), description: "collision",
    });
    await expect(planNpmPairPublication(artifacts, collision))
      .rejects.toThrowError("NPM_VERSION_DIGEST_COLLISION");

    const exact = async (name: string): Promise<RegistryVersion> => ({
      sha256: artifacts.find((item) => item.package === name)!.sha256,
      description: `${name} description`,
      latest: "0.1.3",
      versions: ["0.1.1", "0.1.2", "0.1.3"],
    });
    await expect(verifyPublishedNpmPair(artifacts, exact)).resolves.toEqual({
      version: "0.1.3", packages: ["wsr-execution", "wsr-dsh-intake"],
    });
    let attempts = 0;
    await expect(waitForPublishedNpmPair(artifacts, async (name) => {
      attempts += 1;
      return attempts === 1 ? null : exact(name);
    }, async () => undefined, 2)).resolves.toMatchObject({ version: "0.1.3" });
  });

  it("models recovery without allowing failed candidates to become stable", () => {
    expect(simulateReleaseLifecycle("happy")).toBe("STABLE");
    expect(simulateReleaseLifecycle("candidate-main-divergence")).toBe("STABLE");
    expect(simulateReleaseLifecycle("npm-core-published-intake-failed")).toBe("RECOVERABLE_PARTIAL");
    for (const scenario of [
      "digest-mismatch", "tag-collision", "permission-denied", "builtin-token-final-publish",
    ] as const) {
      expect(() => simulateReleaseLifecycle(scenario)).toThrowError("RELEASE_STOPPED_BEFORE_STABLE");
    }
  });

  it("mints the GitHub App token only for final publish and never hardcodes a qualification branch", async () => {
    const [candidate, promote] = await Promise.all([
      readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8"),
      readFile(path.join(repository, ".github/workflows/release-promote.yml"), "utf8"),
    ]);

    expect(candidate).not.toContain("fix/iter3-interactive-intake-e2e");
    expect(candidate).toContain('test "$GITHUB_REF_NAME" = "release/next"');
    expect(candidate).not.toContain("WSR_RELEASE_APP_PRIVATE_KEY");
    expect(candidate).toContain("push:");
    expect(candidate).toContain("release/request.json");
    expect(candidate).toContain("steps.request.outputs.candidate_tag");
    expect(candidate).toContain("steps.candidate.outputs.exists");
    expect(candidate).toContain('gh release download "$CANDIDATE_TAG" --pattern "$NAME"');
    expect(candidate).toContain("authority_manifest");
    expect(candidate).toContain("materialize-unified-release-candidate.ts");
    expect(candidate).not.toContain('pnpm release:artifacts "$RUNNER_TEMP/local-release"');
    expect(promote).toContain("actions/create-github-app-token@");
    expect(promote).toContain("WSR_RELEASE_APP_ID");
    expect(promote).toContain("WSR_RELEASE_APP_PRIVATE_KEY");
    expect(promote).toContain("repositories: execution-system");
    expect(promote).toContain("permission-contents: write");
    expect(promote.indexOf("actions/create-github-app-token@"))
      .toBeGreaterThan(promote.indexOf("Re-run remote artifact-install E2E"));
    expect(promote).toContain("GH_TOKEN: ${{ steps.release-app-token.outputs.token }}");
  });

  it("materializes only exact Execution bytes bound by the unified candidate", async () => {
    const superproject = await mkdtemp(path.join(tmpdir(), "wsr-unified-candidate-"));
    const candidate = path.join(superproject, "execution-system/release/candidates/wave11");
    const destination = path.join(superproject, "output");
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "release-metadata.json"), "metadata\n");
    await writeFile(path.join(candidate, "release-notes.md"), "notes\n");
    await writeFile(path.join(candidate, "wsr-execution-0.1.3.tgz"), "core");
    await writeFile(path.join(candidate, "wsr-dsh-intake-0.1.3.tgz"), "intake");
    await writeFile(path.join(candidate, "publication.json"), "publication\n");
    const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const manifest = {
      schema_version: "wsr.iter4-unified-candidate@1.0.0",
      status: "IMMUTABLE_RELEASE_CANDIDATE",
      execution: {
        metadata: { path: "execution-system/release/candidates/wave11/release-metadata.json", sha256: digest("metadata\n") },
        release_notes: { path: "execution-system/release/candidates/wave11/release-notes.md", sha256: digest("notes\n") },
        artifacts: [
          { package: "wsr-execution", version: "0.1.3", path: "execution-system/release/candidates/wave11/wsr-execution-0.1.3.tgz", sha256: digest("core") },
          { package: "wsr-dsh-intake", version: "0.1.3", path: "execution-system/release/candidates/wave11/wsr-dsh-intake-0.1.3.tgz", sha256: digest("intake") },
        ],
      },
    };
    const manifestPath = path.join(superproject, "release/candidates/iter4-wave11.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(materializeUnifiedCandidate(superproject, manifestPath, destination)).resolves.toEqual({
      candidateDirectory: candidate,
      version: "0.1.3",
      artifactCount: 2,
    });
    await expect(readFile(path.join(destination, "wsr-execution-0.1.3.tgz"), "utf8")).resolves.toBe("core");
    await writeFile(path.join(candidate, "wsr-execution-0.1.3.tgz"), "tampered");
    await expect(materializeUnifiedCandidate(superproject, manifestPath, path.join(superproject, "tampered-output")))
      .rejects.toThrowError("UNIFIED_CANDIDATE_DIGEST_MISMATCH");
  });

  it("fails closed on direct source publication and fixes the release-note shape", async () => {
    const [core, intake, notes] = await Promise.all([
      readFile(path.join(repository, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(repository, "packages/dsh-intake/package.json"), "utf8").then(JSON.parse),
      readFile(path.join(repository, "release/templates/release-notes.md"), "utf8"),
    ]);

    expect(core.scripts.prepack).toBe("pnpm release:prepack-guard");
    expect(core.scripts.prepublishOnly).toBe("pnpm release:prepublish-guard");
    expect(intake.scripts.prepack).toContain("DIRECT_SOURCE_PACK_PROHIBITED");
    expect(intake.scripts.prepublishOnly).toContain("DIRECT_SOURCE_PUBLISH_PROHIBITED_USE_QUALIFIED_TGZ");
    expect(notes).toContain("## What's new");
    expect(notes).toContain("## Compatibility");
    expect(notes).toContain("## Upgrade guide");
    expect(() => assertReleaseNotes(notes, "{{version}}")).not.toThrow();

    const rendered = renderReleaseNotes("0.1.3", {
      node: ">=24.12.0 <25", dsh: "0.1.1-rc.2",
      workflowContract: "agentops.workflow-dsl@1.1.0", observationContract: "agentops.observation@1.0.0",
    }, "# Changelog\n\n## [Unreleased] - 2026-08-26\n\n### Features\n\n- release automation\n\n## [0.1.2] - 2026-08-25\n");
    expect(rendered.notes).toContain("- release automation");
    expect(rendered.notes).toContain("`node`: `>=24.12.0 <25`");
    expect(rendered.changelogSectionSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("covers package-manager installation policy and executes the source-publication guards", async () => {
    const workspace = await readFile(path.join(repository, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toContain('"better-sqlite3": true');
    expect(workspace).toContain("minimumReleaseAgeExclude:");
    expect(workspace).toContain("wsr-execution@0.1.3");

    const cleanEnvironment = { ...process.env };
    delete cleanEnvironment.WSR_RELEASE_PACK_MODE;
    expect(() => execFileSync("pnpm", ["release:prepack-guard"], {
      cwd: repository, env: cleanEnvironment, stdio: "pipe",
    })).toThrow();
    expect(() => execFileSync("pnpm", ["release:prepack-guard"], {
      cwd: repository,
      env: { ...cleanEnvironment, WSR_RELEASE_PACK_MODE: "verified-builder" },
      stdio: "pipe",
    })).not.toThrow();
    expect(() => execFileSync("pnpm", ["release:prepublish-guard"], {
      cwd: repository, env: cleanEnvironment, stdio: "pipe",
    })).toThrow();
  });
});
