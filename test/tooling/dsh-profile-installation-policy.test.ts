import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  bindLocalPackageCandidate,
  ensureDshProfileInstallationPolicy,
} from "../../scripts/dsh-profile-installation.js";

describe("DSH profile installation policy", () => {
  it("merges the Core native build approval before package installation", async () => {
    const calls: string[][] = [];

    const result = await ensureDshProfileInstallationPolicy("web", async (args) => {
      calls.push([...args]);
      return calls.length === 1 ? '{"esbuild":true}\n' : "";
    });

    expect(calls).toEqual([
      ["plugin", "--profile", "web", "config", "get", "--json", "allowBuilds"],
      [
        "plugin", "--profile", "web", "config", "set", "--location=project", "--json",
        "allowBuilds", '{"better-sqlite3":true,"esbuild":true}',
      ],
    ]);
    expect(result).toEqual({ "better-sqlite3": true, esbuild: true });
  });

  it("accepts a fresh profile with no existing allowBuilds map", async () => {
    const calls: string[][] = [];

    await ensureDshProfileInstallationPolicy("web", async (args) => {
      calls.push([...args]);
      return calls.length === 1 ? "undefined\n" : "";
    });

    expect(calls[1]?.at(-1)).toBe('{"better-sqlite3":true}');
  });

  it("binds every locator for the qualified package, including a direct tarball URL, to the local archive", async () => {
    const profile = await mkdtemp(path.join(tmpdir(), "dsh-profile-candidate-"));
    const archive = path.join(profile, "wsr-execution-0.1.3.tgz");
    try {
      await writeFile(path.join(profile, "pnpm-workspace.yaml"), [
        "packages:",
        "  - .",
        "overrides:",
        "  existing@1.0.0: file:/existing.tgz",
        "",
      ].join("\n"), "utf8");

      await bindLocalPackageCandidate(profile, "wsr-execution", "0.1.3", archive);

      const workspace = parse(await readFile(path.join(profile, "pnpm-workspace.yaml"), "utf8"));
      expect(workspace.overrides).toEqual({
        "existing@1.0.0": "file:/existing.tgz",
        "wsr-execution": `file:${archive}`,
      });
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it("fails closed for non-absolute paths, empty coordinates, and invalid overrides", async () => {
    await expect(bindLocalPackageCandidate("relative", "wsr-execution", "0.1.3", "relative.tgz"))
      .rejects.toThrow("DSH_LOCAL_CANDIDATE_PATH_NOT_ABSOLUTE");
    await expect(bindLocalPackageCandidate(tmpdir(), "", "0.1.3", path.join(tmpdir(), "core.tgz")))
      .rejects.toThrow("DSH_LOCAL_CANDIDATE_COORDINATE_INVALID");

    const profile = await mkdtemp(path.join(tmpdir(), "dsh-profile-candidate-invalid-"));
    try {
      await writeFile(path.join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\noverrides: invalid\n", "utf8");
      await expect(bindLocalPackageCandidate(
        profile,
        "wsr-execution",
        "0.1.3",
        path.join(profile, "core.tgz"),
      )).rejects.toThrow("DSH_LOCAL_CANDIDATE_OVERRIDES_INVALID");
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
