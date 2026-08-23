import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SourceImport {
  readonly from: string;
  readonly imports: readonly string[];
}

type RuntimeModule = "coordinator" | "host" | "invocation" | "custody" | "interpreter";

const ALLOWED_CONTRACT_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  "primitives": new Set(),
  "generated/workflow-contract": new Set(["primitives"]),
  "lifecycle-records": new Set(["primitives"]),
  "runner-activation": new Set(["primitives", "generated/workflow-contract", "lifecycle-records"]),
  "compiled-activation": new Set(["primitives", "runner-activation"]),
  "compiler": new Set(["runner-activation", "compiled-activation"]),
  "custody-capability": new Set(["primitives", "runner-activation", "lifecycle-records"]),
  "invocation-capability": new Set(["primitives", "runner-activation", "compiled-activation", "custody-capability", "lifecycle-records"]),
  "interaction-capability": new Set(["primitives", "invocation-capability"]),
  "host-capability": new Set(["primitives", "compiled-activation", "lifecycle-records", "invocation-capability", "interaction-capability"]),
};

const ALLOWED_RUNTIME_IMPORTS: Readonly<Record<RuntimeModule, ReadonlySet<RuntimeModule>>> = {
  coordinator: new Set(["host", "invocation", "custody"]),
  host: new Set(["invocation", "custody"]),
  invocation: new Set(["custody"]),
  custody: new Set(),
  interpreter: new Set(),
};

function normalizedTarget(source: SourceImport, imported: string): string {
  if (!imported.startsWith(".")) return imported;
  return path.posix.normalize(path.posix.join(path.posix.dirname(source.from), imported));
}

function runtimeModule(file: string): RuntimeModule | undefined {
  return /(?:^|\/)src\/(coordinator|host|invocation|custody|interpreter)(?:\/|$)/.exec(file)?.[1] as
    | RuntimeModule
    | undefined;
}

function contractModule(file: string): string | undefined {
  const match = /(?:^|\/)src\/contracts\/(.+?)(?:\.[cm]?[jt]s)$/.exec(file);
  return match?.[1];
}

export function boundaryViolations(sources: readonly SourceImport[]): string[] {
  const violations: string[] = [];
  for (const source of sources) {
    if (/(?:^|\/)src\/runtime(?:\/|$)/.test(source.from)) {
      violations.push(`${source.from} must use the frozen src/<lane> layout`);
      continue;
    }
    const owner = runtimeModule(source.from);
    const contractOwner = contractModule(source.from);
    const isProviderAdapter = /(?:^|\/)src\/providers(?:\/|$)/.test(source.from);
    for (const imported of source.imports) {
      const target = normalizedTarget(source, imported);
      const contractDependency = contractModule(target);
      if (contractOwner !== undefined && contractOwner !== "index" && contractDependency !== undefined && contractDependency !== contractOwner && !ALLOWED_CONTRACT_IMPORTS[contractOwner]?.has(contractDependency)) {
        violations.push(`${source.from} cannot import contract/${contractDependency}`);
        continue;
      }
      if (/(?:^|\/)test\/support(?:\/|$)/.test(target)) {
        violations.push(`${source.from} cannot import test support`);
        continue;
      }
      if (/(?:^|\/)fixtures(?:\/|$)/.test(target)) {
        violations.push(`${source.from} cannot import fixtures`);
        continue;
      }
      if (/(?:^|\/)src\/composition(?:\/|$)/.test(target)
        && (owner !== undefined || isProviderAdapter || /(?:^|\/)src\/(?:contracts|shared)(?:\/|$)/.test(source.from))) {
        violations.push(`${source.from} cannot import composition`);
        continue;
      }

      const dependency = runtimeModule(target);
      if (dependency === undefined || dependency === owner) continue;
      if (isProviderAdapter) {
        violations.push(`${source.from} cannot import runtime/${dependency}`);
        continue;
      }
      if (/(?:^|\/)src\/(?:contracts|shared)(?:\/|$)/.test(source.from)) {
        violations.push(`${source.from} cannot import runtime/${dependency}`);
        continue;
      }
      if (owner !== undefined && !ALLOWED_RUNTIME_IMPORTS[owner].has(dependency)) {
        violations.push(`${source.from} cannot import runtime/${dependency}`);
        continue;
      }
      // Runner composition is the only root that assembles all owning lanes.
      // Runtime lanes remain acyclic and cannot import composition (checked above).
    }
  }
  return violations;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

export function importsFromSource(contents: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of contents.matchAll(pattern)) {
    const imported = match[1] ?? match[2];
    if (imported !== undefined) imports.push(imported);
  }
  return imports;
}

export function staticBoundaryMain(projectRoot: string): number {
  const typecheck = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
    cwd: projectRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (typecheck.status !== 0) return typecheck.status ?? 1;

  const srcRoot = path.join(projectRoot, "src");
  const sources = sourceFiles(srcRoot).map((absolute): SourceImport => ({
    from: path.relative(projectRoot, absolute).split(path.sep).join("/"),
    imports: importsFromSource(readFileSync(absolute, "utf8")),
  }));
  const violations = boundaryViolations(sources);
  if (violations.length === 0) return 0;
  for (const violation of violations) process.stderr.write(`${violation}\n`);
  return 1;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = staticBoundaryMain(fileURLToPath(new URL("..", import.meta.url)));
}
