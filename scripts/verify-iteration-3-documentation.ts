import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { canonicalJsonBytes } from "../src/configuration/canonical.js";

export interface DocumentationVerificationOptions {
  readonly superRoot: string;
  readonly executionRoot: string;
}

export interface DocumentationVerificationResult {
  readonly commands: number;
  readonly configExamples: number;
  readonly guides: number;
}

export class DocumentationVerificationError extends Error {
  constructor(readonly code: string, readonly file?: string) {
    super(file === undefined ? code : `${code}:${file}`);
  }
}

const GUIDE_FILES = Object.freeze([
  "docs/guides/dsh-execution-quickstart.md",
  "docs/guides/dsh-execution-quickstart.zh-CN.md",
  "docs/reference/execution-configuration.md",
  "docs/reference/execution-configuration.zh-CN.md",
]);
const EXAMPLE_FILES = Object.freeze([
  "config/examples/execution.minimal.yaml",
  "config/examples/execution.minimal.json",
  "config/examples/execution.full.yaml",
  "config/examples/execution.full.json",
]);
const RESULT_FILES = Object.freeze([
  "docs/systems/execution/implementation-results/iteration-3.md",
  "docs/systems/execution/implementation-results/iteration-3.zh-CN.md",
]);
const COMMANDS = Object.freeze([
  "/wsr list",
  "/wsr create <name|name@latest|name@version>",
  "/wsr recover [delivery-id]",
  "/wsr status [delivery-id]",
  "/wsr action finish",
  "/wsr abandon <delivery-id>",
]);
const IDENTITIES = Object.freeze([
  "@workflow-self-recursive/execution-system",
  "@workflow-self-recursive/dsh-intake",
  "workflow-execution",
  "workflow_execution_intake",
  "/workflow-execution",
  "execution.config@1.0.0",
  "firestige/workflow-package",
]);

async function required(file: string): Promise<string> {
  try {
    await access(file);
    return await readFile(file, "utf8");
  } catch {
    throw new DocumentationVerificationError("DOCUMENTATION_FILE_MISSING", file);
  }
}

async function verifyRelativeLinks(file: string, value: string): Promise<void> {
  for (const match of value.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1]!;
    if (/^(?:https?:|#)/u.test(target)) continue;
    const relative = target.split("#", 1)[0]!;
    try { await access(path.resolve(path.dirname(file), relative)); }
    catch { throw new DocumentationVerificationError("DOCUMENTATION_LINK_INVALID", `${file}:${target}`); }
  }
}

function includesAll(value: string, expected: readonly string[], file: string): void {
  for (const item of expected) {
    if (!value.includes(item)) throw new DocumentationVerificationError("DOCUMENTATION_IDENTITY_MISMATCH", `${file}:${item}`);
  }
}

export async function verifyIteration3Documentation(options: DocumentationVerificationOptions): Promise<DocumentationVerificationResult> {
  const guideValues = await Promise.all(GUIDE_FILES.map(async (relative) => ({ relative, value: await required(path.join(options.superRoot, relative)) })));
  const resultValues = await Promise.all(RESULT_FILES.map(async (relative) => ({ relative, value: await required(path.join(options.superRoot, relative)) })));
  const examples = await Promise.all(EXAMPLE_FILES.map(async (relative) => ({ relative, value: await required(path.join(options.executionRoot, relative)) })));
  const packageReadme = await required(path.join(options.executionRoot, "packages/dsh-intake/README.md"));
  const skill = await required(path.join(options.executionRoot, "packages/dsh-intake/skills/workflow-execution/SKILL.md"));
  const defaultYaml = await required(path.join(options.executionRoot, "config/defaults/execution.default.yaml"));
  const defaultJson = await required(path.join(options.executionRoot, "config/defaults/execution.default.json"));
  const schema = JSON.parse(await required(path.join(options.executionRoot, "config/schema/execution.config.schema.json"))) as { readonly required?: readonly string[] };

  await Promise.all([
    ...guideValues.map((guide) => verifyRelativeLinks(path.join(options.superRoot, guide.relative), guide.value)),
    ...resultValues.map((result) => verifyRelativeLinks(path.join(options.superRoot, result.relative), result.value)),
    verifyRelativeLinks(path.join(options.executionRoot, "packages/dsh-intake/README.md"), packageReadme),
  ]);

  for (const guide of guideValues.slice(0, 2)) {
    includesAll(guide.value, [...IDENTITIES, ...COMMANDS], guide.relative);
    includesAll(guide.value, ["pnpm@9.15.0", "@deepseek-ai/dsh@0.1.1-rc.2", "execution-config init", "execution-config validate", "execution-config dump-effective", "--dump-config", "dsh --help", "dsh web", "plugin --profile web add", "plugin --profile web update", "plugin --profile web remove", "webserver", "ui-conversation", "ui-commands"], guide.relative);
    if (guide.value.includes("dsh --profile web --help")) {
      throw new DocumentationVerificationError("DOCUMENTATION_IDENTITY_MISMATCH", `${guide.relative}: interactive profile help must not be used as launcher help`);
    }
    if (!guide.value.includes("release:artifacts") || !guide.value.includes("release:verify")
      || guide.value.includes("github.com/firestige/execution-system/releases/download/")) {
      throw new DocumentationVerificationError("DOCUMENTATION_INSTALL_SOURCE_INVALID", guide.relative);
    }
  }
  for (const guide of guideValues.slice(2)) {
    includesAll(guide.value, ["execution.config@1.0.0", "credentialStorePath", "credentialRef", "modelId", "baseUrl", "workflowSource", "observation", "controls", "READY", "CLOSED"], guide.relative);
  }
  includesAll(packageReadme, [
    "@workflow-self-recursive/execution-system",
    "@workflow-self-recursive/dsh-intake",
    "workflow-execution",
    "workflow_execution_intake",
    "/workflow-execution",
    ...COMMANDS,
  ], "packages/dsh-intake/README.md");
  includesAll(skill, ["workflow_execution_intake", "action-finish"], "packages/dsh-intake/skills/workflow-execution/SKILL.md");
  includesAll(defaultYaml, schema.required ?? [], "config/defaults/execution.default.yaml");
  includesAll(defaultJson, schema.required ?? [], "config/defaults/execution.default.json");
  for (const example of examples) includesAll(example.value, schema.required ?? [], example.relative);
  const [minimalYaml, minimalJson, fullYaml, fullJson] = examples.map((example) => example.value);
  const parityPairs = [
    [parseYaml(minimalYaml!), JSON.parse(minimalJson!)],
    [parseYaml(fullYaml!), JSON.parse(fullJson!)],
  ] as const;
  for (const [yamlValue, jsonValue] of parityPairs) {
    if (!Buffer.from(canonicalJsonBytes(yamlValue)).equals(Buffer.from(canonicalJsonBytes(jsonValue)))) {
      throw new DocumentationVerificationError("DOCUMENTATION_CONFIG_PARITY_MISMATCH");
    }
  }

  return Object.freeze({ commands: COMMANDS.length, configExamples: EXAMPLE_FILES.length, guides: GUIDE_FILES.length });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executionRoot = path.resolve(process.argv[2] ?? ".");
  const superRoot = path.resolve(process.argv[3] ?? path.join(executionRoot, ".."));
  process.stdout.write(`${JSON.stringify(await verifyIteration3Documentation({ executionRoot, superRoot }))}\n`);
}
