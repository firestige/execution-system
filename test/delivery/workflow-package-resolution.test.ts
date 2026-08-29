import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import type {
  WorkflowPackageCandidate,
  WorkflowPackageSource,
  WorkflowPackageSourceRequest,
  WorkflowPackageSourceResult,
} from "../../src/bootstrap/index.js";
import {
  FrozenWorkflowPackageValidator,
  WorkflowPackageResolver,
  WorkflowPackageStore,
  WorkflowPackageStoreError,
  type WorkflowPackageCompatibilityTarget,
} from "../../src/delivery/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const contributedDefinition = join(repositoryRoot, "system-contracts/workflow-dsl/examples/minimal");
const implementationPackage = join(repositoryRoot, "workflow-package/implementation");
const systemDesignPackage = join(repositoryRoot, "workflow-package/system-design");
const helloWorldPackage = join(repositoryRoot, "workflow-package/hello-world-workflow");

const compatibility: WorkflowPackageCompatibilityTarget = Object.freeze({
  contractVersion: "1.1.0",
  providerKey: "dsh",
  providerCapabilities: Object.freeze(["structured-completion", "action-interaction"] as const),
  hostCapabilities: Object.freeze(["deterministic-validation", "deterministic-selection", "deterministic-transformation"] as const),
});

async function candidateFrom(source: string, layout: "definition" | "package" = "definition"): Promise<WorkflowPackageCandidate> {
  const root = await mkdtemp(join(tmpdir(), "workflow-package-asset-"));
  const material = join(root, "material");
  const target = layout === "definition" ? join(material, "definition") : join(material, "package");
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  const definition = layout === "definition" ? target : join(target, "definition");
  const pkg = JSON.parse(await readFile(join(definition, "package.json"), "utf8")) as {
    package: { name: string; version: string };
  };
  const archivePath = join(root, "candidate.tar.gz");
  const packed = spawnSync("tar", ["-czf", archivePath, "-C", material, "."], { encoding: "utf8", shell: false });
  if (packed.status !== 0) throw new Error(packed.stderr);
  const archive = await readFile(archivePath);
  return Object.freeze({
    name: pkg.package.name,
    exactVersion: pkg.package.version,
    archiveDigest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    archive: Uint8Array.from(archive),
  });
}

class QueuedSource implements WorkflowPackageSource {
  readonly calls: WorkflowPackageSourceRequest[] = [];
  constructor(readonly results: WorkflowPackageSourceResult[]) {}
  async fetch(request: WorkflowPackageSourceRequest): Promise<WorkflowPackageSourceResult> {
    this.calls.push(request);
    return this.results.shift() ?? Object.freeze({ kind: "NOT_FOUND" });
  }
}

async function resolverFixture(source: WorkflowPackageSource) {
  const root = await mkdtemp(join(tmpdir(), "workflow-package-resolution-"));
  const store = new WorkflowPackageStore({
    readyRoot: join(root, "store"),
    stagingRoot: join(root, "staging"),
  });
  const validator = new FrozenWorkflowPackageValidator(compatibility);
  return { root, store, resolver: new WorkflowPackageResolver(store, source, validator) };
}

describe("Workflow Package Store and frozen validation", () => {
  it("fails closed when an exact READY record is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-package-malformed-ready-"));
    const readyRoot = join(root, "ready");
    const exactRoot = join(readyRoot, "packages", "demo", "1.0.0");
    await mkdir(exactRoot, { recursive: true });
    await writeFile(join(exactRoot, "ready.json"), "{not-json\n");
    const store = new WorkflowPackageStore({ readyRoot, stagingRoot: join(root, "staging") });

    await expect(store.lookupExact("demo", "1.0.0"))
      .rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
  });

  it("fails closed when READY metadata has an untrusted material coordinate", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-package-untrusted-ready-"));
    const readyRoot = join(root, "ready");
    const exactRoot = join(readyRoot, "packages", "demo", "1.0.0");
    await mkdir(exactRoot, { recursive: true });
    await writeFile(join(exactRoot, "ready.json"), `${JSON.stringify({
      schemaVersion: "execution.workflow-package-ready@1.0.0",
      name: "demo",
      exactVersion: "1.0.0",
      packageDigest: `sha256:${"a".repeat(64)}`,
      workflowId: "workflow.demo",
      localPath: "/tmp/outside-store",
      relativePackagePath: "../../outside-store",
    })}\n`);
    const store = new WorkflowPackageStore({ readyRoot, stagingRoot: join(root, "staging") });

    await expect(store.lookupExact("demo", "1.0.0"))
      .rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
  });

  it("fails closed when an exact READY record outlives its cached material", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-package-missing-material-"));
    const readyRoot = join(root, "ready");
    const exactRoot = join(readyRoot, "packages", "demo", "1.0.0");
    const localPath = join(exactRoot, "material", "package");
    await mkdir(exactRoot, { recursive: true });
    await writeFile(join(exactRoot, "ready.json"), `${JSON.stringify({
      schemaVersion: "execution.workflow-package-ready@1.0.0",
      name: "demo",
      exactVersion: "1.0.0",
      packageDigest: `sha256:${"a".repeat(64)}`,
      workflowId: "workflow.demo",
      localPath,
      relativePackagePath: "package",
    })}\n`);
    const store = new WorkflowPackageStore({ readyRoot, stagingRoot: join(root, "staging") });

    await expect(store.lookupExact("demo", "1.0.0"))
      .rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
  });

  it("rejects relative Store roots and fabricated staging authority", async () => {
    expect(() => new WorkflowPackageStore({ readyRoot: "relative", stagingRoot: "/tmp/staging" }))
      .toThrow("roots must be absolute");
    const source = new QueuedSource([]);
    const f = await resolverFixture(source);
    const candidate = await candidateFrom(contributedDefinition);
    await expect(f.store.publish({
      id: "fabricated",
      path: "/tmp/fabricated",
      materialPath: "/tmp/fabricated/material",
      definitionPath: "/tmp/fabricated/definition",
      packagePath: "/tmp/fabricated",
      candidate,
    }, {
      name: candidate.name,
      exactVersion: candidate.exactVersion,
      packageDigest: `sha256:${"a".repeat(64)}`,
      workflowId: "fabricated",
    })).rejects.toMatchObject({ code: "WORKFLOW_CACHE_PUBLISH_FAILED" });
  });

  it.each([
    ["contributed", contributedDefinition, "definition"],
    ["protected implementation", implementationPackage, "package"],
    ["protected system design", systemDesignPackage, "package"],
    ["hello world", helloWorldPackage, "package"],
  ] as const)("admits %s Package content through the same checker and compatibility path", async (_kind, sourcePath, layout) => {
    const candidate = await candidateFrom(sourcePath, layout);
    const source = new QueuedSource([{ kind: "FOUND", candidate }]);
    const f = await resolverFixture(source);
    const result = await f.resolver.resolve(`${candidate.name}@${candidate.exactVersion}`);
    expect(result).toMatchObject({
      ok: true,
      value: {
        name: candidate.name,
        exactVersion: candidate.exactVersion,
        packageDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        workflowId: expect.any(String),
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(result.value.localPath).toContain(f.root);
    }
  });

  it("keeps STAGING private, publishes READY atomically, and serves exact hits without Source access", async () => {
    const candidate = await candidateFrom(contributedDefinition);
    const source = new QueuedSource([{ kind: "FOUND", candidate }]);
    const f = await resolverFixture(source);
    const staging = await f.store.stage(candidate);
    expect(await f.store.lookupExact(candidate.name, candidate.exactVersion)).toBeUndefined();
    await f.store.discard(staging);
    expect(await f.store.lookupExact(candidate.name, candidate.exactVersion)).toBeUndefined();

    const first = await f.resolver.resolve(`${candidate.name}@${candidate.exactVersion}`);
    expect(first.ok).toBe(true);
    const second = await f.resolver.resolve(`${candidate.name}@${candidate.exactVersion}`);
    expect(second).toEqual(first);
    expect(source.calls).toHaveLength(1);
  });

  it("rejects bare/latest selectors before cache or Source access", async () => {
    const source = new QueuedSource([]);
    const f = await resolverFixture(source);
    expect(await f.resolver.resolve("contributed")).toEqual({ ok: false, error: { code: "INVALID_WORKFLOW_SELECTOR" } });
    expect(await f.resolver.resolve("contributed@latest", true)).toEqual({ ok: false, error: { code: "INVALID_WORKFLOW_SELECTOR" } });
    expect(source.calls).toHaveLength(0);
  });

  it("rejects a conflicting digest for an already READY exact version", async () => {
    const candidate = await candidateFrom(contributedDefinition);
    const f = await resolverFixture(new QueuedSource([]));
    const validator = new FrozenWorkflowPackageValidator(compatibility);
    const firstStaging = await f.store.stage(candidate);
    const validated = await validator.validate(firstStaging);
    await f.store.publish(firstStaging, validated);
    const conflictingStaging = await f.store.stage(candidate);
    await expect(f.store.publish(conflictingStaging, {
      ...validated,
      packageDigest: `sha256:${"f".repeat(64)}`,
    })).rejects.toMatchObject({ code: "WORKFLOW_CACHE_PUBLISH_FAILED" });
    await f.store.discard(conflictingStaging);
  });

  it("reuses an identical READY publication and consumes the duplicate staging directory", async () => {
    const candidate = await candidateFrom(contributedDefinition);
    const f = await resolverFixture(new QueuedSource([]));
    const validator = new FrozenWorkflowPackageValidator(compatibility);
    const firstStaging = await f.store.stage(candidate);
    const validated = await validator.validate(firstStaging);
    const first = await f.store.publish(firstStaging, validated);
    const duplicateStaging = await f.store.stage(candidate);

    await expect(f.store.publish(duplicateStaging, validated)).resolves.toEqual(first);
    await expect(f.store.publish(duplicateStaging, validated))
      .rejects.toMatchObject({ code: "WORKFLOW_CACHE_PUBLISH_FAILED" });
    await expect(f.store.discard(duplicateStaging)).resolves.toBeUndefined();
  });

  it("maps an atomic publication collision to a cache publication failure", async () => {
    const candidate = await candidateFrom(contributedDefinition);
    const f = await resolverFixture(new QueuedSource([]));
    const staging = await f.store.stage(candidate);
    const validated = await new FrozenWorkflowPackageValidator(compatibility).validate(staging);
    await mkdir(join(f.root, "store", "packages", validated.name, validated.exactVersion, "occupied"), { recursive: true });

    await expect(f.store.publish(staging, validated))
      .rejects.toMatchObject({ code: "WORKFLOW_CACHE_PUBLISH_FAILED" });
    await f.store.discard(staging);
  });
});

describe("Workflow Package resolution failures", () => {
  it("maps an exceptional configured Adapter to fetch failure", async () => {
    const source: WorkflowPackageSource = Object.freeze({ fetch: async () => { throw new Error("adapter failed"); } });
    const f = await resolverFixture(source);
    expect(await f.resolver.resolve("contributed@1.0.0"))
      .toEqual({ ok: false, error: { code: "WORKFLOW_FETCH_FAILED" } });
  });
  it.each([
    ["NOT_FOUND", "WORKFLOW_NOT_FOUND"],
    ["UNAVAILABLE", "WORKFLOW_FETCH_FAILED"],
    ["DIGEST_MISMATCH", "WORKFLOW_DIGEST_MISMATCH"],
    ["INVALID", "WORKFLOW_PACKAGE_INVALID"],
  ] as const)("maps configured Source %s without fallback", async (kind, code) => {
    const source = new QueuedSource([{ kind }]);
    const f = await resolverFixture(source);
    expect(await f.resolver.resolve("contributed@1.0.0")).toEqual({ ok: false, error: { code } });
    expect(source.calls).toHaveLength(1);
  });

  it("rejects candidate/request version mismatch before READY publication", async () => {
    const candidate = await candidateFrom(contributedDefinition);
    const f = await resolverFixture(new QueuedSource([{ kind: "FOUND", candidate: { ...candidate, exactVersion: "2.0.0" } }]));
    expect(await f.resolver.resolve(`${candidate.name}@${candidate.exactVersion}`))
      .toEqual({ ok: false, error: { code: "WORKFLOW_VERSION_MISMATCH" } });
    expect(await f.store.lookupExact(candidate.name, candidate.exactVersion)).toBeUndefined();
  });

  it("rejects Package-declared version mismatch after staging", async () => {
    const candidate = await candidateFrom(contributedDefinition);
    const mismatched = { ...candidate, exactVersion: "2.0.0" };
    const f = await resolverFixture(new QueuedSource([{ kind: "FOUND", candidate: mismatched }]));
    expect(await f.resolver.resolve(`${candidate.name}@2.0.0`))
      .toEqual({ ok: false, error: { code: "WORKFLOW_VERSION_MISMATCH" } });
  });

  it("returns DSH incompatible when declared capabilities exceed the production target", async () => {
    const candidate = await candidateFrom(contributedDefinition);
    const root = await mkdtemp(join(tmpdir(), "workflow-package-incompatible-"));
    const store = new WorkflowPackageStore({ readyRoot: join(root, "store"), stagingRoot: join(root, "staging") });
    const validator = new FrozenWorkflowPackageValidator(Object.freeze({
      ...compatibility,
      providerCapabilities: Object.freeze(["structured-completion"] as const),
    }));
    const resolver = new WorkflowPackageResolver(store, new QueuedSource([{ kind: "FOUND", candidate }]), validator);
    expect(await resolver.resolve(`${candidate.name}@${candidate.exactVersion}`))
      .toEqual({ ok: false, error: { code: "WORKFLOW_DSH_INCOMPATIBLE" } });
  });

  it("maps READY publication failure without exposing STAGING", async () => {
    const candidate = await candidateFrom(contributedDefinition);
    const root = await mkdtemp(join(tmpdir(), "workflow-package-publish-failure-"));
    class FailingPublishStore extends WorkflowPackageStore {
      override async publish(): Promise<never> { throw new WorkflowPackageStoreError("WORKFLOW_CACHE_PUBLISH_FAILED"); }
    }
    const store = new FailingPublishStore({ readyRoot: join(root, "store"), stagingRoot: join(root, "staging") });
    const resolver = new WorkflowPackageResolver(
      store,
      new QueuedSource([{ kind: "FOUND", candidate }]),
      new FrozenWorkflowPackageValidator(compatibility),
    );
    expect(await resolver.resolve(`${candidate.name}@${candidate.exactVersion}`))
      .toEqual({ ok: false, error: { code: "WORKFLOW_CACHE_PUBLISH_FAILED" } });
    expect(await store.lookupExact(candidate.name, candidate.exactVersion)).toBeUndefined();
  });

  it("distinguishes package digest and schema/closure failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-package-invalid-"));
    const definition = join(root, "definition");
    await cp(contributedDefinition, definition, { recursive: true });
    const packagePath = join(definition, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    pkg.package.digest = `sha256:${"0".repeat(64)}`;
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    const digestCandidate = await candidateFrom(root, "package");
    const digestFixture = await resolverFixture(new QueuedSource([{ kind: "FOUND", candidate: digestCandidate }]));
    expect(await digestFixture.resolver.resolve(`${digestCandidate.name}@${digestCandidate.exactVersion}`))
      .toEqual({ ok: false, error: { code: "WORKFLOW_DIGEST_MISMATCH" } });

    const malformedArchive = Uint8Array.from(Buffer.from("not a tar archive"));
    const malformed = {
      ...digestCandidate,
      archive: malformedArchive,
      archiveDigest: `sha256:${createHash("sha256").update(malformedArchive).digest("hex")}`,
    };
    const malformedFixture = await resolverFixture(new QueuedSource([{ kind: "FOUND", candidate: malformed }]));
    expect(await malformedFixture.resolver.resolve(`${malformed.name}@${malformed.exactVersion}`))
      .toEqual({ ok: false, error: { code: "WORKFLOW_PACKAGE_INVALID" } });

    const schemaRoot = await mkdtemp(join(tmpdir(), "workflow-package-schema-invalid-"));
    const schemaDefinition = join(schemaRoot, "definition");
    await cp(contributedDefinition, schemaDefinition, { recursive: true });
    const schemaPackagePath = join(schemaDefinition, "package.json");
    const schemaPackage = JSON.parse(await readFile(schemaPackagePath, "utf8"));
    schemaPackage.kind = "invalid.package.kind";
    await writeFile(schemaPackagePath, `${JSON.stringify(schemaPackage, null, 2)}\n`);
    const schemaCandidate = await candidateFrom(schemaRoot, "package");
    const schemaFixture = await resolverFixture(new QueuedSource([{ kind: "FOUND", candidate: schemaCandidate }]));
    expect(await schemaFixture.resolver.resolve(`${schemaCandidate.name}@${schemaCandidate.exactVersion}`))
      .toEqual({ ok: false, error: { code: "WORKFLOW_PACKAGE_INVALID" } });
  });

});
