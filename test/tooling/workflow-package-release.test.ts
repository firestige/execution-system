import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildWorkflowPackageRelease, runWorkflowPackageReleaseCli } from "../../scripts/build-workflow-release-assets.js";

describe("Workflow Package release tooling", () => {
  it("builds exactly one deterministic package-scoped archive, descriptor, and checksum", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workflow-package-release-test-"));
    const packageDirectory = path.join(root, "repository", "demo");
    await mkdir(path.join(packageDirectory, "definition"), { recursive: true });
    await writeFile(path.join(packageDirectory, "definition", "package.json"), JSON.stringify({
      package: { name: "demo", version: "1.2.3", digest: `sha256:${"a".repeat(64)}` },
    }));
    await writeFile(path.join(packageDirectory, "workflow.md"), "hello\n");
    const first = await buildWorkflowPackageRelease({
      packageDirectory, destination: path.join(root, "first"), revision: "b".repeat(40),
    });
    const second = await buildWorkflowPackageRelease({
      packageDirectory, destination: path.join(root, "second"), revision: "b".repeat(40),
    });
    expect(first).toEqual(second);
    expect(first.tag).toBe("workflow-package/demo/v1.2.3");
    expect(first.assets.map((asset) => asset.name)).toEqual([
      "workflow-package-demo-1.2.3.tar.gz",
      "workflow-package-demo-1.2.3.json",
      "workflow-package-demo-1.2.3.tar.gz.sha256",
    ]);
    for (const asset of first.assets) {
      expect(await readFile(path.join(root, "first", asset.name))).toEqual(await readFile(path.join(root, "second", asset.name)));
    }
    expect(JSON.parse(await readFile(path.join(root, "first", first.assets[1]!.name), "utf8"))).toMatchObject({
      schemaVersion: "workflow-package.package-release@1.0.0",
      tag: "workflow-package/demo/v1.2.3",
      package: { name: "demo", version: "1.2.3", digest: `sha256:${"a".repeat(64)}` },
    });
  });

  it("rejects a non-exact revision or malformed package identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workflow-package-release-invalid-"));
    const packageDirectory = path.join(root, "demo");
    await mkdir(path.join(packageDirectory, "definition"), { recursive: true });
    await writeFile(path.join(packageDirectory, "definition", "package.json"), JSON.stringify({
      package: { name: "bad/name", version: "latest", digest: "bad" },
    }));
    await expect(buildWorkflowPackageRelease({ packageDirectory, destination: path.join(root, "out"), revision: "main" }))
      .rejects.toThrow();
    await expect(runWorkflowPackageReleaseCli([])).rejects.toThrow("USAGE:");
  });

  it("exposes the exact three-argument operation through the CLI boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workflow-package-release-cli-"));
    const packageDirectory = path.join(root, "demo");
    const destination = path.join(root, "out");
    await mkdir(path.join(packageDirectory, "definition"), { recursive: true });
    await writeFile(path.join(packageDirectory, "definition", "package.json"), JSON.stringify({
      package: { name: "demo", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` },
    }));
    const output: string[] = [];
    await runWorkflowPackageReleaseCli([packageDirectory, destination, "b".repeat(40)], (value) => output.push(value));
    const result = JSON.parse(output.join("")) as { tag: string; assets: Array<{ name: string }> };
    expect(result.tag).toBe("workflow-package/demo/v1.0.0");
    expect(result.assets[0]?.name).toBe("workflow-package-demo-1.0.0.tar.gz");
  });
});
