import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { projectAdmittedInstructionChain } from "../../src/providers/admitted-instruction-chain.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}` as const;

describe("admitted instruction authority chain", () => {
  it("projects Role prompt, Action prompt, and ordered Skills after verifying every frozen digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "wsr-instruction-chain-")); roots.push(root);
    const role = "ROLE"; const action = "ACTION"; const first = "SKILL ONE"; const second = "SKILL TWO";
    const paths = {
      role: join(root, "role.md"), action: join(root, "action.md"), first: join(root, "first.md"), second: join(root, "second.md"),
    };
    await Promise.all([
      writeFile(paths.role, role), writeFile(paths.action, action), writeFile(paths.first, first), writeFile(paths.second, second),
    ]);
    const session = {
      agent: { resourceIdentity: "role.prompt", localReadOnlyPath: paths.role, contentIdentity: digest(role) },
      instructions: { resourceIdentity: "action.prompt", localReadOnlyPath: paths.action, contentIdentity: digest(action) },
      skills: [
        { resourceIdentity: "skill.one", localReadOnlyPath: paths.first, contentIdentity: digest(first), configuration: { kind: "skill" } },
        { resourceIdentity: "skill.two", localReadOnlyPath: paths.second, contentIdentity: digest(second), configuration: { kind: "skill" } },
      ],
    } as never;

    const projected = await projectAdmittedInstructionChain(session);

    expect(projected).toBe([
      "<wsr-role-prompt resource=\"role.prompt\">", role, "</wsr-role-prompt>",
      "<wsr-action-prompt resource=\"action.prompt\">", action, "</wsr-action-prompt>",
      "<wsr-skill resource=\"skill.one\">", first, "</wsr-skill>",
      "<wsr-skill resource=\"skill.two\">", second, "</wsr-skill>",
    ].join("\n"));
  });

  it("fails closed on missing or drifted Skill material instead of dropping the declared Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "wsr-instruction-chain-drift-")); roots.push(root);
    const rolePath = join(root, "role.md"); const actionPath = join(root, "action.md"); const skillPath = join(root, "skill.md");
    await Promise.all([writeFile(rolePath, "ROLE"), writeFile(actionPath, "ACTION"), writeFile(skillPath, "DRIFTED")]);
    const session = {
      agent: { resourceIdentity: "role.prompt", localReadOnlyPath: rolePath, contentIdentity: digest("ROLE") },
      instructions: { resourceIdentity: "action.prompt", localReadOnlyPath: actionPath, contentIdentity: digest("ACTION") },
      skills: [{ resourceIdentity: "skill.required", localReadOnlyPath: skillPath, contentIdentity: digest("EXPECTED"), configuration: { kind: "skill" } }],
    } as never;

    await expect(projectAdmittedInstructionChain(session)).rejects.toThrow("skill.required");
  });
});
