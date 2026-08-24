import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { qualifyDshInteractiveIntake } from "../../scripts/qualify-dsh-interactive-intake.js";

const repository = path.resolve(import.meta.dirname, "../..");

function pack(source: string, destination: string): string {
  const output = execFileSync("npm", ["pack", "--silent", "--pack-destination", destination], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  return path.join(destination, output.split("\n").at(-1)!);
}

describe("DSH interactive Intake qualification", () => {
  it("accepts /wsr from a real Web session and returns a user-visible command result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "execution-dsh-interactive-"));
    const release = path.join(root, "release");
    try {
      await mkdir(release);
      const coreArchive = pack(repository, release);
      const pluginArchive = pack(path.join(repository, "packages/dsh-intake"), release);
      await expect(qualifyDshInteractiveIntake({ coreArchive, pluginArchive }))
        .resolves.toMatchObject({ command: "/wsr list", result: "PASS" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
