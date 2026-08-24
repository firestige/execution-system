import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadExecutionInstallationConfig } from "../src/configuration/index.js";

type JsonRecord = Record<string, any>;

export type LocalE2EPreparationResult = Readonly<{
  version: string;
  releaseDirectory: string;
  coreArchive: string;
  pluginArchive: string;
  configFile: string;
  credentialFile: string;
  stateDirectory: string;
}>;

export type LocalE2EPreparationInput = Readonly<{
  executionRoot: string;
  worktree: string;
  releaseDirectory: string;
  durableDirectory: string;
  packageVersion: string;
  defaults: JsonRecord;
}>;

type CommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<void>;
type DshRunner = (command: string, args: readonly string[], cwd: string, dshHome: string) => Promise<string>;

async function writeIfMissing(file: string, value: string): Promise<void> {
  try {
    await writeFile(file, value, { encoding: "utf8", flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
}

async function writeOrRepairGeneratedConfig(
  file: string,
  config: JsonRecord,
  legacyPaths: Readonly<{ worktree: string; workspaceRoot: string; stateRoot: string; credentialStorePath: string }>,
): Promise<void> {
  try {
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode: 0o600,
    });
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }

  let existing: JsonRecord;
  try { existing = JSON.parse(await readFile(file, "utf8")) as JsonRecord; }
  catch { return; }
  const paths = existing.paths as JsonRecord | undefined;
  if (paths === undefined
    || paths.repositoryRoot !== legacyPaths.worktree
    || paths.workspaceRoot !== legacyPaths.workspaceRoot
    || !Array.isArray(paths.allowedWorktreeRoots)
    || paths.allowedWorktreeRoots.length !== 1
    || paths.allowedWorktreeRoots[0] !== legacyPaths.workspaceRoot
    || paths.stateRoot !== legacyPaths.stateRoot
    || paths.credentialStorePath !== legacyPaths.credentialStorePath) return;

  existing.paths = {
    ...paths,
    workspaceRoot: legacyPaths.worktree,
    allowedWorktreeRoots: [legacyPaths.worktree],
  };
  const temporary = `${file}.path-scope-${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

export async function prepareLocalE2E(
  input: LocalE2EPreparationInput,
  run: CommandRunner = async (command, args, cwd) => {
    execFileSync(command, [...args], { cwd, stdio: "inherit" });
  },
): Promise<LocalE2EPreparationResult> {
  const executionRoot = path.resolve(input.executionRoot);
  const worktree = path.resolve(input.worktree);
  const releaseDirectory = path.resolve(input.releaseDirectory);
  const durableDirectory = path.resolve(input.durableDirectory);
  const stateDirectory = path.join(durableDirectory, "state");
  const configFile = path.join(durableDirectory, "execution.json");
  const credentialFile = path.join(durableDirectory, "credentials.yml");

  await rm(releaseDirectory, { recursive: true, force: true });
  await Promise.all([
    mkdir(releaseDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
  ]);
  await run("pnpm", ["release:artifacts", releaseDirectory], executionRoot);

  const config = structuredClone(input.defaults);
  config.paths = {
    repositoryRoot: worktree,
    workspaceRoot: worktree,
    allowedWorktreeRoots: [worktree],
    stateRoot: stateDirectory,
    credentialStorePath: credentialFile,
  };
  config.runner = config.runner ?? {};
  config.runner.provider = {
    ...(config.runner.provider ?? {}),
    route: "deepseek",
    modelId: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    credentialRef: "DEEPSEEK_API_KEY",
  };
  await Promise.all([
    writeOrRepairGeneratedConfig(configFile, config, {
      worktree,
      workspaceRoot: path.dirname(worktree),
      stateRoot: stateDirectory,
      credentialStorePath: credentialFile,
    }),
    writeIfMissing(credentialFile, "version: 1\nrefs:\n  DEEPSEEK_API_KEY: replace-with-the-provider-key\n"),
  ]);

  const version = input.packageVersion;
  return Object.freeze({
    version,
    releaseDirectory,
    coreArchive: path.join(releaseDirectory, `workflow-self-recursive-execution-system-${version}.tgz`),
    pluginArchive: path.join(releaseDirectory, `workflow-self-recursive-dsh-intake-${version}.tgz`),
    configFile,
    credentialFile,
    stateDirectory,
  });
}

export async function resolveLocalE2EPreparationInput(executionRootValue: string): Promise<LocalE2EPreparationInput> {
  const executionRoot = path.resolve(executionRootValue);
  const worktree = path.resolve(executionRoot, "..");
  const packageManifest = JSON.parse(await readFile(path.join(executionRoot, "package.json"), "utf8")) as { readonly version: string };
  const defaults = JSON.parse(await readFile(path.join(executionRoot, "config/defaults/execution.default.json"), "utf8")) as JsonRecord;
  return Object.freeze({
    executionRoot,
    worktree,
    releaseDirectory: path.join(worktree, "tmp/local-e2e/release"),
    durableDirectory: path.resolve(worktree, "../wsr-local"),
    packageVersion: packageManifest.version,
    defaults,
  });
}

export type LocalE2EDshProfileInput = Readonly<{
  dshHome: string;
  profile: string;
  worktree: string;
  coreArchive: string;
  pluginArchive: string;
  configFile: string;
  bindingFile: string;
}>;

function ownedWorkflowExecutionRow(configFile: string, bindingFile: string): string {
  return [
    "- id: workflow-execution",
    "  config:",
    `    configFile: ${JSON.stringify(configFile)}`,
    `    bindingFile: ${JSON.stringify(bindingFile)}`,
    "",
  ].join("\n");
}

function reconcileOwnedPatchRow(value: string, row: string): string {
  const match = /^- id:\s*workflow-execution\s*$/mu.exec(value);
  if (match?.index !== undefined) {
    const next = value.indexOf("\n- ", match.index + match[0].length);
    const suffix = next < 0 ? "" : value.slice(next + 1);
    const prefix = value.slice(0, match.index).replace(/^\s*\[\]\s*\n?/mu, "");
    return `${prefix}${row}${suffix}`;
  }
  const semanticLines = value.split("\n").filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
  if (semanticLines.length === 1 && semanticLines[0]?.trim() === "[]") {
    return value.replace(/^\s*\[\]\s*$/mu, row.trimEnd());
  }
  const prefix = value.length === 0 || value.endsWith("\n") ? value : `${value}\n`;
  return `${prefix}${row}`;
}

export async function reconcileLocalE2EDshProfile(
  input: LocalE2EDshProfileInput,
  run: DshRunner = async (command, args, cwd, dshHome) => {
    const dump = args.includes("--dump-config");
    return execFileSync(command, [...args], {
      cwd,
      env: { ...process.env, DSH_HOME: dshHome },
      encoding: "utf8",
      stdio: dump ? ["ignore", "pipe", "pipe"] : "inherit",
    }) ?? "";
  },
): Promise<Readonly<{ profile: string; operation: "RECONCILED"; patchFile: string }>> {
  const dshHome = path.resolve(input.dshHome);
  const profile = input.profile;
  const worktree = path.resolve(input.worktree);
  const coreArchive = path.resolve(input.coreArchive);
  const pluginArchive = path.resolve(input.pluginArchive);
  const configFile = path.resolve(input.configFile);
  const bindingFile = path.resolve(input.bindingFile);
  const profileManifestFile = path.join(dshHome, "profiles", profile, "package.json");
  let dependencies: Record<string, unknown> = {};
  try {
    const profileManifest = JSON.parse(await readFile(profileManifestFile, "utf8")) as { readonly dependencies?: Record<string, unknown> };
    dependencies = profileManifest.dependencies ?? {};
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const corePackage = "@workflow-self-recursive/execution-system";
  const pluginPackage = "@workflow-self-recursive/dsh-intake";
  const removePrefix = ["plugin", "--profile", profile, "remove", "--workspace-root"] as const;
  if (dependencies[pluginPackage] !== undefined) await run("dsh", [...removePrefix, pluginPackage], worktree, dshHome);
  if (dependencies[corePackage] !== undefined) await run("dsh", [...removePrefix, corePackage], worktree, dshHome);
  const addPrefix = ["plugin", "--profile", profile, "add", "--workspace-root"] as const;

  await run("dsh", [...addPrefix, coreArchive], worktree, dshHome);
  await run("dsh", [...addPrefix, pluginArchive], worktree, dshHome);

  const patchFile = path.join(dshHome, "profiles", profile, "cordis.patch.yml");
  const current = await readFile(patchFile, "utf8");
  const next = reconcileOwnedPatchRow(current, ownedWorkflowExecutionRow(configFile, bindingFile));
  if (next !== current) {
    const temporary = `${patchFile}.workflow-execution-${String(process.pid)}.tmp`;
    await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, patchFile);
  }

  const dump = await run("dsh", ["--profile", profile, "--dump-config"], worktree, dshHome);
  if (dump.includes("/__REQUIRED__/") || !dump.includes(configFile) || !dump.includes(bindingFile)) {
    throw new Error("DSH_LOCAL_E2E_PROFILE_INVALID");
  }
  return Object.freeze({ profile, operation: "RECONCILED" as const, patchFile });
}

async function main(): Promise<void> {
  const executionRoot = path.resolve(import.meta.dirname, "..");
  const result = await prepareLocalE2E(await resolveLocalE2EPreparationInput(executionRoot));
  await loadExecutionInstallationConfig(result.configFile);
  const dsh = await reconcileLocalE2EDshProfile({
    dshHome: process.env.DSH_HOME ?? path.join(homedir(), ".dsh"),
    profile: "web",
    worktree: path.resolve(executionRoot, ".."),
    coreArchive: result.coreArchive,
    pluginArchive: result.pluginArchive,
    configFile: result.configFile,
    bindingFile: path.join(path.dirname(result.configFile), "dsh-intake-bindings.json"),
  });
  process.stdout.write([
    "Local E2E files are ready.",
    `Artifacts: ${result.releaseDirectory}`,
    `Configuration: ${result.configFile}`,
    `Credentials: ${result.credentialFile}`,
    `DSH profile: ${dsh.profile}`,
    `DSH override: ${dsh.patchFile}`,
    "Replace the credential placeholder before validation or Workflow execution.",
    "",
  ].join("\n"));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
