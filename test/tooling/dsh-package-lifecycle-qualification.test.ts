import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { qualifyDshPackageLifecycle } from "../../scripts/qualify-dsh-package-lifecycle.js";

const repository = path.resolve(import.meta.dirname, "../..");
const pluginSource = path.join(repository, "packages/dsh-intake");

async function packPlugin(root: string, version: string): Promise<string> {
  const source = path.join(root, `plugin-${version}`);
  const destination = path.join(root, `release-${version}`);
  await cp(pluginSource, source, { recursive: true });
  await mkdir(destination);
  const manifestPath = path.join(source, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`, "utf8");
  execFileSync("npm", ["pack", "--silent", "--pack-destination", destination], {
    cwd: source,
    stdio: "pipe",
  });
  return path.join(destination, `workflow-self-recursive-dsh-intake-${version}.tgz`);
}

describe("DSH package lifecycle qualification", () => {
  it("keeps external Delivery truth across compatible update, removal, and reinstall", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "execution-dsh-package-lifecycle-"));
    try {
      const oldArchive = await packPlugin(root, "0.1.0");
      const newArchive = await packPlugin(root, "0.1.1");

      const result = await qualifyDshPackageLifecycle({ oldArchive, newArchive });

      expect(result).toMatchObject({
        profile: "web",
        updateCommandSucceeded: true,
        installedVersions: ["0.1.0", "0.1.1", "0.1.1"],
        bundleStates: ["REGISTERED", "REGISTERED", "REMOVED", "REGISTERED"],
        durableTruthPreserved: true,
        deliveryBindingIdentity: "sha256:delivery-binding-fixture",
        workflowPackage: "implementation-workflow@0.3.0",
        slotState: "RUNNING_CORRELATED",
      });
      expect(result.dumpConfig).toContain(result.configFile);
      expect(result.dumpConfig).toContain(result.bindingFile);
      expect(result.dumpConfig).toContain("id: webserver");
      expect(result.dumpConfig).toContain("id: ui-conversation");
      expect(result.dumpConfig).toContain("id: ui-commands");
      expect(result.dumpConfig).toContain("id: workflow-execution");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
