import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { ResolvedAgentSessionBinding } from "../contracts/index.js";

type ReadProjection = (absolutePath: string) => Promise<string>;

async function verified(
  projection: Readonly<{ resourceIdentity: string; contentIdentity: string; localReadOnlyPath: unknown }>,
  readProjection: ReadProjection,
): Promise<string> {
  const filename = projection.localReadOnlyPath;
  if (typeof filename !== "string" || !isAbsolute(filename)) {
    throw new TypeError(`admitted instruction resource '${projection.resourceIdentity}' is not materialized`);
  }
  const text = await readProjection(filename);
  const observed = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  if (observed !== projection.contentIdentity) {
    throw new TypeError(`admitted instruction resource '${projection.resourceIdentity}' identity mismatch`);
  }
  return text;
}

export async function projectAdmittedInstructionChain(
  session: Pick<ResolvedAgentSessionBinding, "agent" | "instructions" | "skills">,
  readProjection: ReadProjection = async (filename) => readFile(filename, "utf8"),
): Promise<string> {
  const sections: string[] = [];
  const role = await verified(session.agent, readProjection);
  sections.push(`<wsr-role-prompt resource="${session.agent.resourceIdentity}">`, role, "</wsr-role-prompt>");
  if (String(session.instructions.resourceIdentity) !== String(session.agent.resourceIdentity)) {
    const action = await verified(session.instructions, readProjection);
    sections.push(`<wsr-action-prompt resource="${session.instructions.resourceIdentity}">`, action, "</wsr-action-prompt>");
  }
  for (const skill of session.skills) {
    const text = await verified(skill, readProjection);
    sections.push(`<wsr-skill resource="${skill.resourceIdentity}">`, text, "</wsr-skill>");
  }
  return sections.join("\n");
}
