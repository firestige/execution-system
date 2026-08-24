import { describe, expect, it } from "vitest";

import { ensureDshProfileInstallationPolicy } from "../../scripts/dsh-profile-installation.js";

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
});
