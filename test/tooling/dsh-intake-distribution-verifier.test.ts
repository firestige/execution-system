import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyDshIntakeDistribution } from "../../scripts/verify-dsh-intake-distribution.js";

const source = path.resolve(import.meta.dirname, "../../packages/dsh-intake");

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-distribution-"));
  await cp(source, root, { recursive: true });
  return root;
}

describe("DSH Intake distribution format verifier", () => {
  it("accepts the exact first-party skill/provider/tool closure", async () => {
    const root = await fixture();
    try {
      await expect(verifyDshIntakeDistribution(root)).resolves.toEqual({
        packageName: "@workflow-self-recursive/dsh-intake",
        skillName: "workflow-execution",
        toolIdentity: "workflow_execution_intake",
        operations: ["list", "create", "recover", "status", "action-finish", "abandon"],
        presentationSlot: "conversation.chat.commandview",
        sidebarSlot: "sidebar.footer.action",
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects missing or stale skill, provider, tool identity, and operation formats", async () => {
    const malformedManifest = await fixture();
    await writeFile(path.join(malformedManifest, "package.json"), "{ invalid");
    await expect(verifyDshIntakeDistribution(malformedManifest)).rejects.toMatchObject({ code: "DSH_INTAKE_MANIFEST_INVALID" });
    await rm(malformedManifest, { recursive: true, force: true });

    const scalarManifest = await fixture();
    await writeFile(path.join(scalarManifest, "package.json"), "null\n");
    await expect(verifyDshIntakeDistribution(scalarManifest)).rejects.toMatchObject({ code: "DSH_INTAKE_MANIFEST_INVALID" });
    await rm(scalarManifest, { recursive: true, force: true });

    const wrongManifest = await fixture();
    const wrong = JSON.parse(await readFile(path.join(wrongManifest, "package.json"), "utf8"));
    await writeFile(path.join(wrongManifest, "package.json"), `${JSON.stringify({ ...wrong, name: "stale-plugin" })}\n`);
    await expect(verifyDshIntakeDistribution(wrongManifest)).rejects.toMatchObject({ code: "DSH_INTAKE_MANIFEST_INVALID" });
    await rm(wrongManifest, { recursive: true, force: true });

    const missing = await fixture();
    await unlink(path.join(missing, "skills/workflow-execution/SKILL.md"));
    await expect(verifyDshIntakeDistribution(missing)).rejects.toMatchObject({ code: "DSH_INTAKE_SKILL_INVALID" });
    await rm(missing, { recursive: true, force: true });

    const stale = await fixture();
    const staleSkill = await readFile(path.join(stale, "skills/workflow-execution/SKILL.md"), "utf8");
    await writeFile(path.join(stale, "skills/workflow-execution/SKILL.md"), staleSkill.replace("workflow_execution_intake", "workflow_execution_stale"));
    await expect(verifyDshIntakeDistribution(stale)).rejects.toMatchObject({ code: "DSH_INTAKE_SKILL_INVALID" });
    await rm(stale, { recursive: true, force: true });

    const provider = await fixture();
    const patch = await readFile(path.join(provider, "cordis.patch.yml"), "utf8");
    await writeFile(path.join(provider, "cordis.patch.yml"), patch.replace("id: skill-filesystem", "id: missing-provider"));
    await expect(verifyDshIntakeDistribution(provider)).rejects.toMatchObject({ code: "DSH_INTAKE_PROVIDER_INVALID" });
    await rm(provider, { recursive: true, force: true });

    const tool = await fixture();
    const plugin = await readFile(path.join(tool, "src/plugin.js"), "utf8");
    await writeFile(path.join(tool, "src/plugin.js"), plugin.replace('name: "workflow_execution_intake"', 'name: "workflow_execution_stale"'));
    await expect(verifyDshIntakeDistribution(tool)).rejects.toMatchObject({ code: "DSH_INTAKE_TOOL_INVALID" });
    await rm(tool, { recursive: true, force: true });

    const missingTool = await fixture();
    await unlink(path.join(missingTool, "src/plugin.js"));
    await expect(verifyDshIntakeDistribution(missingTool)).rejects.toMatchObject({ code: "DSH_INTAKE_TOOL_INVALID" });
    await rm(missingTool, { recursive: true, force: true });

    const operation = await fixture();
    const operationPlugin = await readFile(path.join(operation, "src/plugin.js"), "utf8");
    await writeFile(path.join(operation, "src/plugin.js"), operationPlugin.replace('"action-finish", "abandon"', '"action-finish", "latest"'));
    await expect(verifyDshIntakeDistribution(operation)).rejects.toMatchObject({ code: "DSH_INTAKE_OPERATION_SET_INVALID" });
    await rm(operation, { recursive: true, force: true });

    const missingClient = await fixture();
    await unlink(path.join(missingClient, "lib/client.js"));
    await expect(verifyDshIntakeDistribution(missingClient)).rejects.toMatchObject({ code: "DSH_INTAKE_CLIENT_INVALID" });
    await rm(missingClient, { recursive: true, force: true });
  });
});
