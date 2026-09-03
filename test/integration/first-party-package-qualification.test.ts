import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.dirname(fileURLToPath(new URL("../..", import.meta.url)));
const contractRoot = path.join(repositoryRoot, "system-contracts/workflow-dsl-2-candidate/generated");

function qualify(definition: string, root = repositoryRoot) {
  return spawnSync(process.execPath, [
    path.join(contractRoot, "tools/check-example.cjs"),
    path.join(root, definition),
  ], { cwd: contractRoot, encoding: "utf8", shell: false });
}

describe("first-party Package qualification", () => {
  it.each([
    ["System Design", "workflow-package/system-design/definition", repositoryRoot],
    ["Implementation", "workflow-package/implementation/definition", repositoryRoot],
  ])("qualifies the %s Package against the frozen 2.0 Contract before Runner projection", (_name, definition, root) => {
    const result = qualify(definition, root);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("PASS: schema, graph/event, authority, corpus-shape and digest closure succeeded"),
      stderr: "",
    });
  });

});
