import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { bindLocalPackageCandidate, ensureDshProfileInstallationPolicy } from "./dsh-profile-installation.js";

const require = createRequire(import.meta.url);
const PACKAGE_NAME = "wsr-dsh-intake";
const repository = path.resolve(import.meta.dirname, "..");
const coreVersion = (require(path.join(repository, "package.json")) as { readonly version: string }).version;

export interface DshPackageLifecycleQualificationOptions {
  readonly coreArchive: string;
  readonly oldArchive: string;
  readonly newArchive: string;
  readonly profile?: string;
}

export interface DshPackageLifecycleQualificationResult {
  readonly profile: string;
  readonly updateCommandSucceeded: boolean;
  readonly installedVersions: readonly string[];
  readonly bundleStates: readonly ("REGISTERED" | "REMOVED")[];
  readonly durableTruthPreserved: boolean;
  readonly deliveryBindingIdentity: string;
  readonly workflowPackage: string;
  readonly slotState: string;
  readonly configFile: string;
  readonly bindingFile: string;
  readonly dumpConfig: string;
}

interface ProfileManifest {
  readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } };
}

function digest(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest("hex")}`;
}

function dshExecutable(): string {
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = require(manifestPath) as { readonly bin?: { readonly dsh?: string } };
  if (manifest.bin?.dsh === undefined) throw new TypeError("DSH_EXECUTABLE_UNAVAILABLE");
  return path.resolve(path.dirname(manifestPath), manifest.bin.dsh);
}

function invokeDsh(executable: string, dshHome: string, profile: string, args: readonly string[]): string {
  const result = spawnSync(process.execPath, [executable, "plugin", "--profile", profile, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: dshHome },
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) {
    const diagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().slice(0, 2_000);
    throw new Error(`DSH_PACKAGE_LIFECYCLE_COMMAND_FAILED:${args[0] ?? "unknown"}:${diagnostic}`);
  }
  return result.stdout;
}

function invokeDump(executable: string, dshHome: string, profile: string): string {
  const result = spawnSync(process.execPath, [executable, "--profile", profile, "--dump-config"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: dshHome },
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) {
    const diagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().slice(0, 2_000);
    throw new Error(`DSH_PACKAGE_LIFECYCLE_DUMP_FAILED:${diagnostic}`);
  }
  return result.stdout;
}

async function bundleState(profileDirectory: string): Promise<"REGISTERED" | "REMOVED"> {
  const manifest = JSON.parse(await readFile(path.join(profileDirectory, "package.json"), "utf8")) as ProfileManifest;
  return manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME) === true ? "REGISTERED" : "REMOVED";
}

async function installedVersion(profileDirectory: string): Promise<string> {
  const manifest = JSON.parse(await readFile(
    path.join(profileDirectory, "node_modules", ...PACKAGE_NAME.split("/"), "package.json"),
    "utf8",
  )) as { readonly version?: unknown };
  if (typeof manifest.version !== "string") throw new TypeError("DSH_PLUGIN_VERSION_INVALID");
  return manifest.version;
}

export async function qualifyDshPackageLifecycle(
  options: DshPackageLifecycleQualificationOptions,
): Promise<DshPackageLifecycleQualificationResult> {
  const oldArchive = path.resolve(options.oldArchive);
  const newArchive = path.resolve(options.newArchive);
  const coreArchive = path.resolve(options.coreArchive);
  const profile = options.profile ?? "web";
  const root = await mkdtemp(path.join(tmpdir(), "execution-dsh-lifecycle-"));
  const dshHome = path.join(root, "dsh-home");
  const profileDirectory = path.join(dshHome, "profiles", profile);
  const durableRoot = path.join(root, "execution-durable-state");
  const configFile = path.join(durableRoot, "execution.json");
  const bindingFile = path.join(durableRoot, "intake-bindings.json");
  const slotFile = path.join(durableRoot, "current-slots", "worktree-fixture.json");
  const manifestFile = path.join(durableRoot, "manifests", "delivery-fixture.json");
  const binding = Object.freeze({
    schemaVersion: "execution.intake-binding@1.0.0",
    deliveryId: "delivery-fixture",
    deliveryBindingIdentity: "sha256:delivery-binding-fixture",
    sessionKey: "session-fixture",
  });
  const slot = Object.freeze({
    schemaVersion: "execution.current-slot@1.0.0",
    deliveryId: "delivery-fixture",
    deliveryBindingIdentity: binding.deliveryBindingIdentity,
    state: "RUNNING_CORRELATED",
  });
  const deliveryManifest = Object.freeze({
    schemaVersion: "execution.delivery-manifest@1.0.0",
    deliveryId: binding.deliveryId,
    deliveryBindingIdentity: binding.deliveryBindingIdentity,
    workflowPackage: "implementation-workflow@0.3.0",
  });
  const configBytes = Buffer.from(`${JSON.stringify({ schemaVersion: "execution.config@1.0.0" })}\n`);
  const bindingBytes = Buffer.from(`${JSON.stringify(binding)}\n`);
  const slotBytes = Buffer.from(`${JSON.stringify(slot)}\n`);
  const manifestBytes = Buffer.from(`${JSON.stringify(deliveryManifest)}\n`);
  const before = digest([configBytes, bindingBytes, slotBytes, manifestBytes]);
  const executable = dshExecutable();

  try {
    await Promise.all([
      mkdir(path.dirname(slotFile), { recursive: true }),
      mkdir(path.dirname(manifestFile), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(configFile, configBytes),
      writeFile(bindingFile, bindingBytes),
      writeFile(slotFile, slotBytes),
      writeFile(manifestFile, manifestBytes),
    ]);

    // The Intake plugin declares `wsr-execution` as a dependency, whose
    // better-sqlite3 native build must be approved in the profile before any
    // install (mirrors the documented `dsh plugin config set allowBuilds` step).
    await ensureDshProfileInstallationPolicy(profile, (args) => invokeDsh(executable, dshHome, profile, args.slice(3)));
    await bindLocalPackageCandidate(profileDirectory, "wsr-execution", coreVersion, coreArchive);

    invokeDsh(executable, dshHome, profile, ["add", "--workspace-root", oldArchive]);
    const installedVersions = [await installedVersion(profileDirectory)];
    const bundleStates: ("REGISTERED" | "REMOVED")[] = [await bundleState(profileDirectory)];
    await writeFile(path.join(profileDirectory, "cordis.patch.yml"), [
      "- id: workflow-execution",
      "  config:",
      `    configFile: ${JSON.stringify(configFile)}`,
      `    bindingFile: ${JSON.stringify(bindingFile)}`,
      "",
    ].join("\n"), "utf8");
    const dumpConfig = invokeDump(executable, dshHome, profile);

    // A local `file:` dependency remains bound to its existing archive when
    // pnpm `update` resolves it. Exercise the documented update command at
    // that coordinate, then install the new exact tarball to model the same
    // version transition without an unpublished registry coordinate.
    invokeDsh(executable, dshHome, profile, ["update", "--workspace-root", oldArchive]);
    invokeDsh(executable, dshHome, profile, ["add", "--workspace-root", newArchive]);
    installedVersions.push(await installedVersion(profileDirectory));
    bundleStates.push(await bundleState(profileDirectory));

    invokeDsh(executable, dshHome, profile, ["remove", "--workspace-root", PACKAGE_NAME]);
    bundleStates.push(await bundleState(profileDirectory));

    invokeDsh(executable, dshHome, profile, ["add", "--workspace-root", newArchive]);
    installedVersions.push(await installedVersion(profileDirectory));
    bundleStates.push(await bundleState(profileDirectory));

    const afterParts = await Promise.all([configFile, bindingFile, slotFile, manifestFile].map((file) => readFile(file)));
    return Object.freeze({
      profile,
      updateCommandSucceeded: true,
      installedVersions: Object.freeze(installedVersions),
      bundleStates: Object.freeze(bundleStates),
      durableTruthPreserved: digest(afterParts) === before,
      deliveryBindingIdentity: binding.deliveryBindingIdentity,
      workflowPackage: deliveryManifest.workflowPackage,
      slotState: slot.state,
      configFile,
      bindingFile,
      dumpConfig,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const oldArchive = process.argv[2];
  const newArchive = process.argv[3];
  const coreArchive = process.argv[4];
  if (oldArchive === undefined || newArchive === undefined || coreArchive === undefined) {
    process.stderr.write("usage: qualify-dsh-package-lifecycle <old-plugin.tgz> <new-plugin.tgz> <core.tgz>\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(await qualifyDshPackageLifecycle({ oldArchive, newArchive, coreArchive }), null, 2)}\n`);
  }
}
