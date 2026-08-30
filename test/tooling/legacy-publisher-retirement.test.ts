import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");

describe("legacy DSH publisher retirement", () => {
  it("keeps the active Execution release authority core-only", async () => {
    const activeReleaseFiles = await Promise.all([
      ".github/workflows/release-candidate.yml",
      ".github/workflows/release-promote.yml",
      ".github/workflows/ci.yml",
      "release/config/component.json",
      "package.json",
      "scripts/build-release-artifacts.ts",
      "scripts/verify-release-artifacts.ts",
      "scripts/materialize-unified-release-candidate.ts",
    ].map((file) => readFile(path.join(repository, file), "utf8")));

    expect(activeReleaseFiles.join("\n")).not.toContain("wsr-dsh-intake");
    expect(activeReleaseFiles.join("\n")).not.toContain("npm-pair");
  });

  it("directs active user entry points to the new DSH authority", async () => {
    const entryPoints = await Promise.all([
      "README.md",
      "README.zh-CN.md",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/compatibility.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      "docs/assets/architecture.svg",
    ].map((file) => readFile(path.join(repository, file), "utf8")));

    expect(entryPoints.join("\n")).not.toContain("wsr-dsh-intake");
    expect(entryPoints.join("\n")).toContain("dsh-wsr-execution");
  });

  it("labels retained legacy source as compatibility-only and non-publishable", async () => {
    const marker = await readFile(path.join(repository, "packages/dsh-intake/LEGACY.md"), "utf8");
    expect(marker).toContain("Historical compatibility source");
    expect(marker).toContain("dsh-wsr-execution");
    expect(marker).toContain("must not be published");
  });

  it("retires the cross-repository DSH documentation verifier", async () => {
    const manifest = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(manifest.scripts).not.toHaveProperty("verify:iteration3-docs");

    await expect(access(path.join(repository, "scripts/verify-iteration-3-documentation.ts"))).rejects.toThrow();
    await expect(access(path.join(repository, "test/tooling/iteration-3-documentation-verifier.test.ts"))).rejects.toThrow();
  });
});
