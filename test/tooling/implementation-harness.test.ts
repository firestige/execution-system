import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  commandForPhase,
  harnessMain,
  runHarnessPhase,
  type HarnessPhase,
} from "../../scripts/implementation-harness.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");

describe("implementation Harness", () => {
  it.each<[HarnessPhase, readonly string[]]>([
    ["feasibility", ["pnpm", "exec", "vitest", "run", "test/tooling/feasibility.test.ts"]],
    ["focused", ["pnpm", "exec", "vitest", "run"]],
    ["full", ["pnpm", "exec", "vitest", "run"]],
    ["coverage", ["pnpm", "exec", "vitest", "run", "--coverage"]],
    ["static", ["node", "--import", "tsx", "scripts/static-boundary-check.ts"]],
    ["build", ["pnpm", "exec", "tsc", "-p", "tsconfig.build.json"]],
  ])("maps %s to one exact shell-free command", (phase, expected) => {
    expect(commandForPhase(phase)).toEqual(expected);
  });

  it("rejects an unknown phase before spawning a child", () => {
    expect(() => commandForPhase("deploy")).toThrowError("unknown Harness phase 'deploy'");
  });

  it("runs the selected command at the project root with shell disabled", () => {
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(runHarnessPhase("focused", { projectRoot: "/project", spawn })).toBe(0);
    expect(spawn).toHaveBeenCalledWith("pnpm", ["exec", "vitest", "run"], {
      cwd: "/project",
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
  });

  it("propagates a child exit status and maps a signal-only exit to failure", () => {
    const failed = vi.fn(() => ({ status: 7 }));
    const signalled = vi.fn(() => ({ status: null }));

    expect(runHarnessPhase("static", { projectRoot: "/project", spawn: failed })).toBe(7);
    expect(runHarnessPhase("build", { projectRoot: "/project", spawn: signalled })).toBe(1);
  });

  it("can execute the real static command through the default shell-free spawner", () => {
    expect(runHarnessPhase("static", { projectRoot })).toBe(0);
  });

  it("maps CLI errors to stderr and a failure exit without throwing", () => {
    const stderr = vi.fn();

    expect(harnessMain("deploy", { projectRoot, stderr })).toBe(1);
    expect(stderr).toHaveBeenCalledWith("unknown Harness phase 'deploy'\n");
  });

  it("maps a non-Error child failure to bounded stderr", () => {
    const stderr = vi.fn();
    const spawn = vi.fn(() => {
      throw "spawn failed";
    });

    expect(harnessMain("focused", { projectRoot, spawn, stderr })).toBe(1);
    expect(stderr).toHaveBeenCalledWith("spawn failed\n");
  });

  it("uses the TypeScript CLI entrypoint and rejects an unknown phase", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(projectRoot, "scripts/implementation-harness.ts"), "deploy"],
      { cwd: projectRoot, encoding: "utf8", shell: false },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("unknown Harness phase 'deploy'\n");
  });
});
