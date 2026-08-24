import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@workflow-self-recursive/dsh-intake";
const SKILL_NAME = "workflow-execution";
const TOOL_IDENTITY = "workflow_execution_intake";
const OPERATIONS = Object.freeze(["list", "create", "recover", "status", "action-finish", "abandon"]);

export class DshIntakeDistributionVerificationError extends Error {
  constructor(readonly code: string) { super(code); }
}

async function requiredText(file: string, code: string): Promise<string> {
  try { return await readFile(file, "utf8"); }
  catch { throw new DshIntakeDistributionVerificationError(code); }
}

function exactFrontmatter(skill: string): boolean {
  const match = /^---\n(?<frontmatter>[\s\S]*?)\n---\n/u.exec(skill);
  if (match?.groups?.frontmatter === undefined) return false;
  const values = new Map(match.groups.frontmatter.split("\n").map((line) => {
    const separator = line.indexOf(":");
    return separator < 1 ? [line, ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  return values.get("name") === SKILL_NAME
    && typeof values.get("description") === "string" && values.get("description")!.length > 0
    && values.get("disable-model-invocation") === "true"
    && values.get("user-invocable") === "true"
    && values.size === 4;
}

export async function verifyDshIntakeDistribution(directory: string): Promise<Readonly<{
  packageName: string;
  skillName: string;
  toolIdentity: string;
  operations: readonly string[];
}>> {
  const root = path.resolve(directory);
  let manifest: unknown;
  try { manifest = JSON.parse(await requiredText(path.join(root, "package.json"), "DSH_INTAKE_MANIFEST_INVALID")); }
  catch (cause) {
    if (cause instanceof DshIntakeDistributionVerificationError) throw cause;
    throw new DshIntakeDistributionVerificationError("DSH_INTAKE_MANIFEST_INVALID");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new DshIntakeDistributionVerificationError("DSH_INTAKE_MANIFEST_INVALID");
  }
  const packageManifest = manifest as Record<string, unknown>;
  const dsh = packageManifest.dsh as { readonly bundle?: { readonly patch?: unknown } } | undefined;
  const files = packageManifest.files;
  if (packageManifest.name !== PACKAGE_NAME || dsh?.bundle?.patch !== "./cordis.patch.yml"
    || !Array.isArray(files) || !["src", "skills", "cordis.patch.yml"].every((entry) => files.includes(entry))) {
    throw new DshIntakeDistributionVerificationError("DSH_INTAKE_MANIFEST_INVALID");
  }

  const patch = await requiredText(path.join(root, "cordis.patch.yml"), "DSH_INTAKE_PROVIDER_INVALID");
  if (!/id: workflow-execution[\s\S]*name: ['"]@workflow-self-recursive\/dsh-intake['"]/u.test(patch)
    || !/id: skill-filesystem[\s\S]*customSkillDirs:/u.test(patch)
    || !/id: tool-skill\s+disabled: false/u.test(patch)) {
    throw new DshIntakeDistributionVerificationError("DSH_INTAKE_PROVIDER_INVALID");
  }

  const skill = await requiredText(
    path.join(root, "skills", SKILL_NAME, "SKILL.md"),
    "DSH_INTAKE_SKILL_INVALID",
  );
  if (!exactFrontmatter(skill) || skill.match(new RegExp(TOOL_IDENTITY, "gu"))?.length !== 1
    || !skill.includes("exactly once")) {
    throw new DshIntakeDistributionVerificationError("DSH_INTAKE_SKILL_INVALID");
  }

  const plugin = await requiredText(path.join(root, "src/plugin.js"), "DSH_INTAKE_TOOL_INVALID");
  if (!plugin.includes(`name: "${TOOL_IDENTITY}"`)) {
    throw new DshIntakeDistributionVerificationError("DSH_INTAKE_TOOL_INVALID");
  }
  const operationLiteral = `const operationNames = [${OPERATIONS.map((operation) => `"${operation}"`).join(", ")}];`;
  if (!plugin.includes(operationLiteral)) {
    throw new DshIntakeDistributionVerificationError("DSH_INTAKE_OPERATION_SET_INVALID");
  }

  return Object.freeze({
    packageName: PACKAGE_NAME,
    skillName: SKILL_NAME,
    toolIdentity: TOOL_IDENTITY,
    operations: OPERATIONS,
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await verifyDshIntakeDistribution(path.resolve(process.argv[2] ?? "packages/dsh-intake")))}\n`);
}
