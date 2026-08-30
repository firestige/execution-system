import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { x as extractTar } from "tar";

import type { WorkflowPackageCandidate } from "../bootstrap/index.js";

export interface ResolvedWorkflowPackage {
  readonly name: string;
  readonly exactVersion: string;
  readonly packageDigest: string;
  readonly localPath: string;
  readonly workflowId: string;
}

export interface ValidatedWorkflowPackage {
  readonly name: string;
  readonly exactVersion: string;
  readonly packageDigest: string;
  readonly workflowId: string;
}

export interface WorkflowPackageStaging {
  readonly id: string;
  readonly path: string;
  readonly materialPath: string;
  readonly definitionPath: string;
  readonly packagePath: string;
  readonly candidate: WorkflowPackageCandidate;
}

export class WorkflowPackageStoreError extends Error {
  constructor(readonly code:
    | "WORKFLOW_DIGEST_MISMATCH"
    | "WORKFLOW_PACKAGE_INVALID"
    | "WORKFLOW_VERSION_MISMATCH"
    | "WORKFLOW_DSH_INCOMPATIBLE"
    | "WORKFLOW_CACHE_PUBLISH_FAILED") {
    super(code);
    this.name = "WorkflowPackageStoreError";
  }
}

interface ReadyRecord extends ResolvedWorkflowPackage {
  readonly schemaVersion: "execution.workflow-package-ready@1.0.0";
  readonly relativePackagePath: string;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function recordFrom(value: unknown, exactRoot: string): ResolvedWorkflowPackage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "exactVersion,localPath,name,packageDigest,relativePackagePath,schemaVersion,workflowId"
    || record.schemaVersion !== "execution.workflow-package-ready@1.0.0"
    || typeof record.name !== "string" || typeof record.exactVersion !== "string"
    || typeof record.packageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.packageDigest)
    || typeof record.workflowId !== "string" || record.workflowId.length === 0
    || typeof record.relativePackagePath !== "string" || record.relativePackagePath.startsWith("..") || isAbsolute(record.relativePackagePath)
    || record.localPath !== join(exactRoot, "material", record.relativePackagePath)) {
    throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
  }
  return Object.freeze({
    name: record.name,
    exactVersion: record.exactVersion,
    packageDigest: record.packageDigest,
    localPath: record.localPath,
    workflowId: record.workflowId,
  });
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function locatePackage(materialPath: string): Promise<Readonly<{ packagePath: string; definitionPath: string }>> {
  const candidates = new Map<string, Readonly<{ packagePath: string; definitionPath: string }>>();
  const inspect = async (packagePath: string) => {
    if (await isFile(join(packagePath, "package.json"))) {
      const candidate = Object.freeze({ packagePath, definitionPath: packagePath });
      if (!candidates.has(candidate.definitionPath)) candidates.set(candidate.definitionPath, candidate);
    }
    if (await isFile(join(packagePath, "definition", "package.json"))) {
      const candidate = Object.freeze({ packagePath, definitionPath: join(packagePath, "definition") });
      if (!candidates.has(candidate.definitionPath)) candidates.set(candidate.definitionPath, candidate);
    }
  };
  await inspect(materialPath);
  for (const entry of await readdir(materialPath, { withFileTypes: true })) if (entry.isDirectory()) await inspect(join(materialPath, entry.name));
  if (candidates.size !== 1) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
  return [...candidates.values()][0]!;
}

export class WorkflowPackageStore {
  readonly #readyRoot: string;
  readonly #stagingRoot: string;
  readonly #live = new Map<string, WorkflowPackageStaging>();

  constructor(configuration: Readonly<{ readyRoot: string; stagingRoot: string }>) {
    if (!isAbsolute(configuration.readyRoot) || !isAbsolute(configuration.stagingRoot)) throw new TypeError("Workflow Package Store roots must be absolute");
    this.#readyRoot = resolve(configuration.readyRoot);
    this.#stagingRoot = resolve(configuration.stagingRoot);
  }

  async lookupExact(name: string, exactVersion: string): Promise<ResolvedWorkflowPackage | undefined> {
    const root = this.#exactRoot(name, exactVersion);
    let ready: string;
    try {
      ready = await readFile(join(root, "ready.json"), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    try {
      const resolved = recordFrom(JSON.parse(ready) as unknown, root);
      if (!(await stat(resolved.localPath)).isDirectory()) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
      return resolved;
    } catch (cause) {
      if (cause instanceof WorkflowPackageStoreError) throw cause;
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
  }

  async stage(candidate: WorkflowPackageCandidate): Promise<WorkflowPackageStaging> {
    if (sha256(candidate.archive) !== candidate.archiveDigest) throw new WorkflowPackageStoreError("WORKFLOW_DIGEST_MISMATCH");
    const id = `staging-${randomUUID()}`;
    const path = join(this.#stagingRoot, id);
    const publication = join(path, "publication");
    const materialPath = join(publication, "material");
    const archivePath = join(path, "candidate.tar.gz");
    try {
      await mkdir(materialPath, { recursive: true });
      await writeFile(archivePath, candidate.archive, { flag: "wx", mode: 0o600 });
      await extractTar({ cwd: materialPath, file: archivePath, strict: true, preservePaths: false });
      const located = await locatePackage(materialPath);
      const staging = Object.freeze({ id, path, materialPath, ...located, candidate });
      this.#live.set(id, staging);
      return staging;
    } catch (cause) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      if (cause instanceof WorkflowPackageStoreError) throw cause;
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
  }

  async publish(staging: WorkflowPackageStaging, validated: ValidatedWorkflowPackage): Promise<ResolvedWorkflowPackage> {
    if (this.#live.get(staging.id) !== staging) throw new WorkflowPackageStoreError("WORKFLOW_CACHE_PUBLISH_FAILED");
    const destination = this.#exactRoot(validated.name, validated.exactVersion);
    const relativePackagePath = relative(staging.materialPath, staging.packagePath);
    const localPath = join(destination, "material", relativePackagePath);
    const ready: ReadyRecord = Object.freeze({
      schemaVersion: "execution.workflow-package-ready@1.0.0",
      name: validated.name,
      exactVersion: validated.exactVersion,
      packageDigest: validated.packageDigest,
      workflowId: validated.workflowId,
      localPath,
      relativePackagePath,
    });
    try {
      const existing = await this.lookupExact(validated.name, validated.exactVersion);
      if (existing !== undefined) {
        if (existing.packageDigest !== validated.packageDigest || existing.workflowId !== validated.workflowId) {
          throw new WorkflowPackageStoreError("WORKFLOW_CACHE_PUBLISH_FAILED");
        }
        await this.discard(staging);
        return existing;
      }
      await writeFile(join(staging.path, "publication", "ready.json"), `${JSON.stringify(ready)}\n`, { flag: "wx", mode: 0o600 });
      await mkdir(resolve(destination, ".."), { recursive: true });
      await rename(join(staging.path, "publication"), destination);
      this.#live.delete(staging.id);
      await rm(staging.path, { recursive: true, force: true }).catch(() => undefined);
      const resolved = recordFrom(ready, destination);
      return resolved;
    } catch (cause) {
      if (cause instanceof WorkflowPackageStoreError) throw cause;
      throw new WorkflowPackageStoreError("WORKFLOW_CACHE_PUBLISH_FAILED");
    }
  }

  async discard(staging: WorkflowPackageStaging): Promise<void> {
    if (this.#live.get(staging.id) !== staging) return;
    this.#live.delete(staging.id);
    await rm(staging.path, { recursive: true, force: true }).catch(() => undefined);
  }

  #exactRoot(name: string, exactVersion: string): string {
    return join(this.#readyRoot, "packages", name, exactVersion);
  }

}
