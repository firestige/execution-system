import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HARNESS_PHASES = [
  "feasibility",
  "focused",
  "full",
  "coverage",
  "static",
  "build",
] as const;

export type HarnessPhase = (typeof HARNESS_PHASES)[number];

type Command = readonly [string, ...string[]];

const COMMANDS: Readonly<Record<HarnessPhase, Command>> = {
  feasibility: ["pnpm", "exec", "vitest", "run", "test/tooling/feasibility.test.ts"],
  focused: ["pnpm", "exec", "vitest", "run"],
  full: ["pnpm", "exec", "vitest", "run"],
  coverage: ["pnpm", "exec", "vitest", "run", "--coverage"],
  static: ["node", "--import", "tsx", "scripts/static-boundary-check.ts"],
  build: ["pnpm", "exec", "tsc", "-p", "tsconfig.build.json"],
};

interface SpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: "inherit";
}

type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { readonly status: number | null };

export interface RunHarnessOptions {
  readonly projectRoot: string;
  readonly spawn?: Spawn;
}

export interface HarnessMainOptions extends RunHarnessOptions {
  readonly stderr?: (message: string) => void;
}

export function commandForPhase(phase: string): Command {
  if (!HARNESS_PHASES.includes(phase as HarnessPhase)) {
    throw new Error(`unknown Harness phase '${phase}'`);
  }
  return COMMANDS[phase as HarnessPhase];
}

export function runHarnessPhase(phase: string, options: RunHarnessOptions): number {
  const [command, ...args] = commandForPhase(phase);
  const spawn: Spawn = options.spawn ?? ((executable, argv, spawnOptions) =>
    spawnSync(executable, [...argv], spawnOptions));
  const result = spawn(command, args, {
    cwd: options.projectRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

export function harnessMain(phase: string, options: HarnessMainOptions): number {
  try {
    return runHarnessPhase(phase, options);
  } catch (error) {
    const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  process.exitCode = harnessMain(process.argv[2] ?? "", { projectRoot });
}
