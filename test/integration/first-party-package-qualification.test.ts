import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.dirname(fileURLToPath(new URL("../..", import.meta.url)));
const contractRoot = path.join(repositoryRoot, "system-contracts/workflow-dsl");
const workflowPackageCommit = "ed2a0bddda1eeaba77f19c5e543fe0c82d55fefb";

function qualify(definition: string, root = repositoryRoot) {
  return spawnSync(process.execPath, [
    path.join(contractRoot, "tools/check-example.cjs"),
    path.join(root, definition),
  ], { cwd: contractRoot, encoding: "utf8", shell: false });
}

describe("Wave 4 first-party Package qualification", () => {
  it.each([
    ["System Design", "workflow-package/system-design/definition", repositoryRoot],
    ["Implementation", "workflow-package/implementation/definition", repositoryRoot],
  ])("qualifies the %s Package against the frozen 1.1 Contract before Runner projection", (_name, definition, root) => {
    const identity = spawnSync("git", ["rev-parse", "HEAD"], { cwd: path.join(repositoryRoot, "workflow-package"), encoding: "utf8", shell: false });
    expect(identity.stdout.trim()).toBe(workflowPackageCommit);
    const result = qualify(definition, root);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("PASS: schema, graph/event, authority, corpus-shape and digest closure succeeded"),
      stderr: "",
    });
  });
});
