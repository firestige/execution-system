import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "../../..");
const fixtureRoot = path.join(projectRoot, "test/fixtures/dsh-intake-feasibility");

interface PackageMetadata {
  readonly main?: string;
  readonly version: string;
  readonly bin?: Readonly<Record<string, string>>;
}

function resolveNestedPackage(specifier: string): string {
  const dshManifest = require.resolve("@deepseek-ai/dsh/package.json");
  return require.resolve(specifier, { paths: [path.dirname(dshManifest)] });
}

function metadata(manifestPath: string): PackageMetadata {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageMetadata;
}

async function importNestedPackage(specifier: string): Promise<Record<string, unknown>> {
  const manifestPath = resolveNestedPackage(`${specifier}/package.json`);
  const packageMetadata = metadata(manifestPath);
  if (packageMetadata.main === undefined) {
    throw new Error(`${specifier} has no main entry`);
  }
  return (await import(pathToFileURL(path.resolve(path.dirname(manifestPath), packageMetadata.main)).href)) as Record<
    string,
    unknown
  >;
}

export function probeDshBundleLoader(): {
  readonly packageVersion: string;
  readonly profileBundles: readonly string[];
  readonly row: Readonly<Record<string, unknown>>;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "iter3-dsh-loader-"));
  const dshHome = path.join(directory, "home");
  const profile = path.join(dshHome, "profiles/workflow-execution");
  const packageScope = path.join(profile, "node_modules/@workflow-self-recursive");
  const bundleName = "@workflow-self-recursive/dsh-intake-feasibility";
  try {
    mkdirSync(packageScope, { recursive: true });
    symlinkSync(fixtureRoot, path.join(packageScope, "dsh-intake-feasibility"), "dir");
    writeFileSync(
      path.join(profile, "package.json"),
      `${JSON.stringify(
        {
          name: "dsh-profile-workflow-execution",
          private: true,
          type: "module",
          dependencies: { [bundleName]: "0.0.0-feasibility" },
          dsh: { profile: { bundles: [bundleName] } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");

    const dshManifest = require.resolve("@deepseek-ai/dsh/package.json");
    const dsh = metadata(dshManifest);
    const executable = dsh.bin?.dsh;
    if (executable === undefined) {
      throw new Error("locked DSH package has no dsh executable");
    }
    const result = spawnSync(
      process.execPath,
      [path.resolve(path.dirname(dshManifest), executable), "--profile", "workflow-execution", "--dump-config"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, DSH_HOME: dshHome },
        shell: false,
      },
    );
    if (result.status !== 0) {
      throw new Error(`real DSH profile composer failed: ${result.stderr || result.stdout}`);
    }
    const output = result.stdout;
    if (
      !output.includes("id: workflow-execution") ||
      !new RegExp(`name: ['\"]?${bundleName.replace("/", "\\/")}['\"]?`).test(output) ||
      !output.includes("configPath: /tmp/execution-config.yaml")
    ) {
      throw new Error(`real DSH profile composer omitted the probe row:\n${output}`);
    }
    return {
      packageVersion: dsh.version,
      profileBundles: [bundleName],
      row: {
        id: "workflow-execution",
        name: bundleName,
        config: { configPath: "/tmp/execution-config.yaml" },
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function probeDshBrokenPatchRecovery(): {
  readonly failureStatus: number | null;
  readonly diagnostic: string;
  readonly recoveredStatus: number | null;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "iter3-dsh-broken-patch-"));
  const dshHome = path.join(directory, "home");
  const profile = path.join(dshHome, "profiles/workflow-execution");
  const packageScope = path.join(profile, "node_modules/@workflow-self-recursive");
  const bundleName = "@workflow-self-recursive/dsh-intake-feasibility";
  try {
    mkdirSync(packageScope, { recursive: true });
    symlinkSync(fixtureRoot, path.join(packageScope, "dsh-intake-feasibility"), "dir");
    writeFileSync(path.join(profile, "package.json"), `${JSON.stringify({
      name: "dsh-profile-workflow-execution", private: true, type: "module",
      dependencies: { [bundleName]: "0.0.0-feasibility" },
      dsh: { profile: { bundles: [bundleName] } },
    })}\n`);
    const dshManifest = require.resolve("@deepseek-ai/dsh/package.json");
    const executable = metadata(dshManifest).bin?.dsh;
    if (executable === undefined) throw new Error("locked DSH package has no dsh executable");
    const command = [path.resolve(path.dirname(dshManifest), executable), "--profile", "workflow-execution", "--dump-config"];
    const options = { cwd: projectRoot, encoding: "utf8" as const, env: { ...process.env, DSH_HOME: dshHome }, shell: false };
    writeFileSync(path.join(profile, "cordis.patch.yml"), "- id: workflow-execution\n  config: [\n");
    const failed = spawnSync(process.execPath, command, options);
    writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");
    const recovered = spawnSync(process.execPath, command, options);
    return {
      failureStatus: failed.status,
      diagnostic: `${failed.stderr}\n${failed.stdout}`.trim(),
      recoveredStatus: recovered.status,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function probeDshSkillFilesystem(skillRoot = path.join(fixtureRoot, "skills")): Promise<{
  readonly packageVersion: string;
  readonly summary: {
    readonly name: string;
    readonly invocation: Readonly<Record<string, boolean>>;
  };
  readonly content: string;
}> {
  const manifestPath = resolveNestedPackage("@deepseek-ai/dsh-skill-filesystem/package.json");
  const packageMetadata = metadata(manifestPath);
  const module = await importNestedPackage("@deepseek-ai/dsh-skill-filesystem");
  const Provider = module.FileSystemSkillProvider as new (
    context: unknown,
    control: { readonly signal: AbortSignal; readonly invalidate: () => void },
    config: Readonly<Record<string, unknown>>,
  ) => {
    list(options: Readonly<Record<string, unknown>>): Promise<readonly Record<string, unknown>[]>;
    get(candidate: Readonly<Record<string, unknown>>, options: Readonly<Record<string, unknown>>): Promise<
      Record<string, unknown> | undefined
    >;
    dispose(): Promise<void>;
  };
  const controller = new AbortController();
  const context = { logger: { warn: () => undefined }, get: () => undefined };
  const provider = new Provider(
    context,
    { signal: controller.signal, invalidate: () => undefined },
    { includeDefaultRoots: false, bundledSkillDir: skillRoot, watch: false },
  );
  try {
    const candidates = await provider.list({});
    const candidate = candidates.find((value) => value.name === "workflow-execution");
    if (candidate === undefined) {
      throw new Error("locked filesystem provider did not discover workflow-execution");
    }
    const skill = await provider.get(candidate, {});
    if (skill === undefined || typeof skill.content !== "string") {
      throw new Error("locked filesystem provider did not load workflow-execution");
    }
    return {
      packageVersion: packageMetadata.version,
      summary: {
        name: String(skill.name),
        invocation: skill.invocation as Readonly<Record<string, boolean>>,
      },
      content: skill.content,
    };
  } finally {
    controller.abort();
    await provider.dispose();
  }
}

export async function probeCordisIsolation(): Promise<{
  readonly packageVersion: string;
  readonly isolatedSharesRoot: boolean;
  readonly independentSharesRoot: boolean;
  readonly parentService: unknown;
  readonly isolatedService: unknown;
  readonly independentService: unknown;
  readonly intakeToolVisible: boolean;
  readonly executionToolVisible: boolean;
  readonly activationCalls: number;
}> {
  const manifestPath = resolveNestedPackage("@deepseek-ai/cordis/package.json");
  const packageMetadata = metadata(manifestPath);
  const module = await importNestedPackage("@deepseek-ai/cordis");
  const Context = module.Context as new () => {
    readonly root: unknown;
    isolate(name: string): {
      readonly root: unknown;
      get(name: string): unknown;
    };
    get(name: string): unknown;
    provide(name: string, value: unknown): () => Promise<void>;
    readonly fiber: { dispose(): Promise<void> };
  };
  const intake = new Context();
  const isolated = intake.isolate("activation");
  const execution = new Context();
  try {
    intake.provide("activation", "intake");
    const promptModule = await importNestedPackage("@deepseek-ai/dsh-system-prompt");
    const SystemPrompt = promptModule.SystemPrompt as new (context: unknown, config: Readonly<Record<string, unknown>>) => unknown;
    new SystemPrompt(intake, {});
    const toolsModule = await importNestedPackage("@deepseek-ai/dsh-tools");
    const ToolRuntime = toolsModule.ToolRuntime as new (context: unknown) => {
      register(definition: unknown): () => void;
      get(name: string): unknown;
      execute(input: Readonly<Record<string, unknown>>): Promise<{ readonly isError: boolean }>;
    };
    const defineTool = toolsModule.defineTool as (definition: unknown) => unknown;
    const intakeTools = new ToolRuntime(intake);
    let activationCalls = 0;
    intakeTools.register(defineTool({
      name: "workflow_execution_activate",
      description: "Probe the Intake-only activation boundary.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { accepted: { type: "boolean", required: true } },
        },
        render: () => [{ type: "text", text: "accepted" }],
      },
      async execute() {
        activationCalls += 1;
        return { accepted: true };
      },
    }));
    const toolResult = await intakeTools.execute({
      callId: "probe-call",
      name: "workflow_execution_activate",
      arguments: {},
      signal: new AbortController().signal,
    });
    if (toolResult.isError) {
      throw new Error("locked DSH tool runtime rejected the Intake activation probe");
    }
    return {
      packageVersion: packageMetadata.version,
      isolatedSharesRoot: isolated.root === intake.root,
      independentSharesRoot: execution.root === intake.root,
      parentService: intake.get("activation"),
      isolatedService: isolated.get("activation"),
      independentService: execution.get("activation"),
      intakeToolVisible: intakeTools.get("workflow_execution_activate") !== undefined,
      executionToolVisible: execution.get("tools") !== undefined,
      activationCalls,
    };
  } finally {
    await Promise.all([intake.fiber.dispose(), execution.fiber.dispose()]);
  }
}
