import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function writeIfMissing(file: string, value: string): Promise<void> {
  try {
    await writeFile(file, value, { encoding: "utf8", flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
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
    workspaceRoot: path.dirname(worktree),
    allowedWorktreeRoots: [path.dirname(worktree)],
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
    writeIfMissing(configFile, `${JSON.stringify(config, null, 2)}\n`),
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

async function main(): Promise<void> {
  const executionRoot = path.resolve(import.meta.dirname, "..");
  const result = await prepareLocalE2E(await resolveLocalE2EPreparationInput(executionRoot));
  process.stdout.write([
    "Local E2E files are ready.",
    `Artifacts: ${result.releaseDirectory}`,
    `Configuration: ${result.configFile}`,
    `Credentials: ${result.credentialFile}`,
    "Replace the credential placeholder before validation or Workflow execution.",
    "",
  ].join("\n"));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
