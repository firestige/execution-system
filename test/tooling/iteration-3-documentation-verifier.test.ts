import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyIteration3Documentation } from "../../scripts/verify-iteration-3-documentation.js";

async function fixture() {
  const sourceExecution = path.resolve(import.meta.dirname, "../..");
  const sourceSuper = path.resolve(sourceExecution, "..");
  const root = await mkdtemp(path.join(tmpdir(), "iteration3-docs-"));
  const superRoot = root;
  const executionRoot = path.join(superRoot, "execution-system");
  await Promise.all([
    mkdir(executionRoot, { recursive: true }),
    mkdir(superRoot, { recursive: true }),
  ]);
  await Promise.all([
    cp(path.join(sourceExecution, "config"), path.join(executionRoot, "config"), { recursive: true }),
    cp(path.join(sourceExecution, "packages/dsh-intake"), path.join(executionRoot, "packages/dsh-intake"), { recursive: true }),
    cp(path.join(sourceSuper, "docs"), path.join(superRoot, "docs"), { recursive: true }),
  ]);
  return { executionRoot, superRoot };
}

const repositoryExecutionRoot = path.resolve(import.meta.dirname, "../..");
const repositorySuperRoot = path.resolve(repositoryExecutionRoot, "..");

describe.skipIf(!existsSync(path.join(repositorySuperRoot, "docs/guides/dsh-execution-quickstart.md")))("Iteration 3 release documentation verifier", () => {
  it("binds repository guides, config examples, package help, skill, and defaults to one exact surface", async () => {
    await expect(verifyIteration3Documentation({ superRoot: repositorySuperRoot, executionRoot: repositoryExecutionRoot })).resolves.toEqual({
      commands: 6,
      configExamples: 4,
      guides: 4,
    });
  });

  it("rejects profile-level app help presented as non-interactive launcher help", async () => {
    const roots = await fixture();
    const file = path.join(roots.superRoot, "docs/guides/dsh-execution-quickstart.md");
    const value = await readFile(file, "utf8");
    await writeFile(file, value.replace("dsh --help", "dsh --profile web --help"));

    await expect(verifyIteration3Documentation(roots)).rejects.toMatchObject({
      code: "DOCUMENTATION_IDENTITY_MISMATCH",
    });
  });

  it("rejects a pre-release E2E guide that installs Execution from a GitHub Release", async () => {
    const roots = await fixture();
    const file = path.join(roots.superRoot, "docs/guides/dsh-execution-quickstart.md");
    const value = await readFile(file, "utf8");
    await writeFile(file, `${value}\ncurl https://github.com/firestige/execution-system/releases/download/0.1.1/plugin.tgz\n`);

    await expect(verifyIteration3Documentation(roots)).rejects.toMatchObject({
      code: "DOCUMENTATION_INSTALL_SOURCE_INVALID",
    });
  });

  it("rejects host prerequisites that are installed before checking whether they already exist", async () => {
    const roots = await fixture();
    const file = path.join(roots.superRoot, "docs/guides/dsh-execution-quickstart.md");
    const value = await readFile(file, "utf8");
    await writeFile(file, value.replace("```sh\n", "```sh\nnpm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2\n"));

    await expect(verifyIteration3Documentation(roots)).rejects.toMatchObject({
      code: "DOCUMENTATION_PREREQUISITE_INSTALL_INVALID",
    });
  });
});
