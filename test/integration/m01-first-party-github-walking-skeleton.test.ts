import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ImmediateConcurrencyController } from "../../src/bootstrap/index.js";
import { coordinateIdentity } from "../../src/configuration/index.js";
import { AgentProviderRunnerFactory, type AgentProviderRunnerFactoryConfig } from "../../src/index.js";
import { ExecutionCoreAdmission } from "../../src/core/index.js";
import {
  CurrentSlotRepository,
  DeliveryAdmissionProjector,
  DeliveryAdmissionService,
  DeliveryLifecycleService,
  DeliveryManifestRepositoryV2,
  DeliveryRecoveryService,
  type DeliveryRuntimeFactoryInput,
  DISABLED_DELIVERY_OBSERVATION_SINK,
  FrozenWorkflowPackageValidatorV2,
  GitHubWorkflowPackageSource,
  WorkflowPackageResolver,
  WorkflowPackageStore,
} from "../../src/delivery/index.js";
import { AgentProviderFactoryRegistry, type AgentProviderRealmFactory } from "../../src/providers/provider.js";

const repositoryRoot = path.dirname(fileURLToPath(new URL("../..", import.meta.url)));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Wave 4 production M01 to pinned M02 first-party walking skeleton", () => {
  it("downloads the configured GitHub asset and reaches a validated terminal through the persisted binding", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "m01-first-party-walking-")));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: workspace });
    await writeFile(path.join(workspace, "README.md"), "first-party candidate\n", "utf8");
    const declaredRoles = JSON.parse(await readFile(path.join(repositoryRoot, "workflow-package/implementation/definition/roles.json"), "utf8")) as { roles: Array<{ id: string }> };
    await mkdir(path.join(workspace, ".wsr"));
    await writeFile(path.join(workspace, ".wsr/role-provider-bindings.json"), `${JSON.stringify({
      schemaVersion: "execution.repository-role-provider-bindings@1.0.0",
      bindings: Object.fromEntries(declaredRoles.roles.map(({ id }) => [id, {
        agentProvider: { identity: "provider.dsh", version: "0.1.1-rc.2" },
        model: { provider: "deepseek", model: "deepseek-chat" },
      }])),
    })}\n`, "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });

    const material = path.join(root, "release-material");
    await mkdir(material);
    await cp(path.join(repositoryRoot, "workflow-package", "implementation"), path.join(material, "package"), { recursive: true });
    const packageDocument = JSON.parse(await readFile(path.join(repositoryRoot, "workflow-package/implementation/definition/package.json"), "utf8")) as { package: { digest: string; version: string } };
    const implementationVersion = packageDocument.package.version;
    const archiveName = `workflow-package-implementation-workflow-${implementationVersion}.tar.gz`;
    const archivePath = path.join(root, archiveName);
    const packed = spawnSync("tar", ["-czf", archivePath, "-C", material, "."], { encoding: "utf8", shell: false });
    if (packed.status !== 0) throw new Error(packed.stderr);
    const archive = await readFile(archivePath);
    const sourceCalls: string[] = [];
    const assetUrl = `https://github.example.test/releases/download/${implementationVersion}/${archiveName}`;
    const descriptorName = `workflow-package-implementation-workflow-${implementationVersion}.json`;
    const descriptorUrl = `https://github.example.test/releases/download/scoped/${descriptorName}`;
    const checksumUrl = `${assetUrl}.sha256`;
    const provenanceName = `workflow-package-implementation-workflow-${implementationVersion}.provenance.json`;
    const provenanceUrl = `https://github.example.test/releases/download/scoped/${provenanceName}`;
    const archiveDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    const provenance = Buffer.from(`${JSON.stringify({
      schemaVersion: "workflow-package.provenance@1.0.0",
      subject: { name: path.basename(archivePath), sha256: archiveDigest },
      source: { repository: "firestige/wsr-workflow-package", revision: "a".repeat(40) },
      contract: { repository: "firestige/wsr-contracts", revision: "c".repeat(40) },
      builder: { workflow: ".github/workflows/release-candidate.yml" },
    })}\n`);
    const provenanceDigest = `sha256:${createHash("sha256").update(provenance).digest("hex")}`;
    const source = new GitHubWorkflowPackageSource({
      kind: "github",
      repository: "firestige/wsr-workflow-package",
      releasesBaseUrl: "https://api.github.example.test/repos/firestige/wsr-workflow-package/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, Object.freeze({ request: async (url: string) => {
      sourceCalls.push(url);
      if (url.includes("/releases?per_page=100&page=1")) return { status: 200, body: Buffer.from(JSON.stringify([{
        tag_name: `workflow-package/implementation-workflow/v${implementationVersion}`, draft: false, prerelease: false,
        assets: [
          { name: path.basename(archivePath), browser_download_url: assetUrl },
          { name: descriptorName, browser_download_url: descriptorUrl },
          { name: `${archiveName}.sha256`, browser_download_url: checksumUrl },
          { name: provenanceName, browser_download_url: provenanceUrl },
        ],
      }])) };
      if (url === descriptorUrl) return { status: 200, body: Buffer.from(JSON.stringify({
        schemaVersion: "workflow-package.package-release@2.0.0",
        tag: `workflow-package/implementation-workflow/v${implementationVersion}`,
        package: { name: "implementation-workflow", version: implementationVersion, digest: packageDocument.package.digest },
        archive: { name: path.basename(archivePath), sha256: archiveDigest, bytes: archive.byteLength },
        checksum: { name: `${archiveName}.sha256` },
        provenance: { name: provenanceName, sha256: provenanceDigest },
        contract: { repository: "firestige/wsr-contracts", revision: "c".repeat(40), minVersion: "2.0.0", maxVersion: "2.0.0" },
      })) };
      if (url === checksumUrl) return { status: 200, body: Buffer.from(`${archiveDigest.slice(7)}  ${archiveName}\n`) };
      if (url === provenanceUrl) return { status: 200, body: provenance };
      return url === assetUrl ? { status: 200, body: Uint8Array.from(archive) } : { status: 404, body: new Uint8Array() };
    } }));
    const store = new WorkflowPackageStore({ readyRoot: path.join(root, "package-store"), stagingRoot: path.join(root, "staging") });
    const compatibility = Object.freeze({
      contractVersion: "2.0.0" as const,
      providerIdentity: "provider.registry",
      providerCapabilities: Object.freeze(["structured-completion", "action-interaction"] as const),
      hostCapabilities: Object.freeze(["deterministic-validation", "deterministic-selection", "deterministic-transformation"] as const),
    });
    const resolver = new WorkflowPackageResolver(store, source, new FrozenWorkflowPackageValidatorV2(compatibility));

    const slots = new CurrentSlotRepository(path.join(root, "current-slots"));
    const recovery = new DeliveryRecoveryService(slots, Object.freeze({ verify: async () => true }));
    const admission = new DeliveryAdmissionService(slots, recovery, new ImmediateConcurrencyController(1));
    await admission.start();
    const deliveryProjectionValue = Object.freeze({
        schemaVersion: "execution.delivery-config@2.0.0" as const,
        paths: Object.freeze({ repositoryRoot: workspace, workspaceRoot: workspace, allowedWorktreeRoots: Object.freeze([workspace]), runnerResources: Object.freeze({ journal: "runner/journal" as const, checkpoints: "runner/checkpoints" as const, sessions: "runner/sessions" as const, custody: "runner/custody" as const }) }),
        runner: Object.freeze({ implementationKey: "runner.v2" as const, host: Object.freeze({ engine: "langgraph" as const }), maxParallelToolCalls: 1 }),
        controls: Object.freeze({ executionTimeoutMs: 60_000, maxConcurrentDeliveries: 1, allowExplicitRefresh: false }),
    });
    const deliveryProjection = Object.freeze({
      value: deliveryProjectionValue,
      identity: coordinateIdentity("execution.delivery-config@2.0.0", deliveryProjectionValue as never),
    });
    const core = new ExecutionCoreAdmission(Object.freeze({
      schemaVersion: "execution.environment@2.0.0",
      allowedWorktreeRoots: Object.freeze([workspace]),
      allowExplicitRefresh: false,
      maxCorrelationBytes: 256,
      deliveryConfigProjection: deliveryProjection,
    }), admission);
    const ready = await core.begin({ worktree: workspace, selector: `implementation-workflow@${implementationVersion}`, prompt: { text: "exercise the first-party path", attachments: [] } });
    if (ready.kind !== "NEW") throw new Error(`expected NEW, got ${ready.kind}`);

    const runnerFactory = new AgentProviderRunnerFactory();
    const adapters: Array<Awaited<ReturnType<AgentProviderRunnerFactory["create"]>>> = [];
    const runtimeConfig = Object.freeze({
      schemaVersion: "runner.factory@2.0.0",
      stateDirectory: path.join(root, "runner", "coordinator"),
      custody: Object.freeze({ recordsDirectory: path.join(root, "runner", "custody"), publication: Object.freeze({ targetIdentity: "publication-target.walking", repositoryPath: workspace, ref: "refs/heads/candidate" }) }),
      invocation: Object.freeze({ journalDirectory: path.join(root, "runner", "journals") }),
      host: Object.freeze({ engine: "langgraph", checkpointDirectory: path.join(root, "runner", "checkpoints") }),
      implementationIdentity: "implementation.runner.langgraph-dsh",
    }) satisfies AgentProviderRunnerFactoryConfig;
    const providerFactory: AgentProviderRealmFactory = Object.freeze({
      descriptor: Object.freeze({
        schemaVersion: "execution.agent-provider-factory@1.0.0",
        identity: "provider.dsh",
        version: "0.1.1-rc.2",
        adapterKey: "dsh-headless",
        capabilities: Object.freeze(["action-interaction", "structured-completion"]),
      }),
      async acquire() { throw new Error("the manually composed Runner owns this test realm"); },
    });
    const agentProviders = new AgentProviderFactoryRegistry([providerFactory]);
    let providerRuns = 0;
    const providerSessions = Object.freeze({
      "dsh-headless": Object.freeze({
        async open() {
          return Object.freeze({
            opaqueIdentity: "provider.dsh:walking-skeleton",
            async run() {
              providerRuns += 1;
              return Object.freeze([{ kind: "structured-completion" as const, result: Object.freeze({ authorityBound: false, designIdentityExact: false, obligationRegisterBound: false, derivableFactMissing: true, routing: "unmatched" }) }]);
            },
            async persist() {}, async cancel() {}, async dispose() {},
          });
        },
        async restore() { throw new Error("not used"); },
      }),
    });
    const lifecycle = new DeliveryLifecycleService({
      manifestVersion: "2.0.0",
      resolver,
      manifests: new DeliveryManifestRepositoryV2(path.join(root, "manifests")),
      agentProviders,
      snapshotRoot: path.join(root, "prompt-snapshots"),
      attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }),
      projector: new DeliveryAdmissionProjector(),
      runtime: Object.freeze({ create: async ({ ownerFacts, startCorrelation }: DeliveryRuntimeFactoryInput) => {
        ownerFacts.emit(Object.freeze({ owner: "M02", name: "runner-composed", occurredAt: 0 }));
        const adapter = await runnerFactory.create(runtimeConfig, Object.freeze({
          interaction: Object.freeze({ publish: async () => ({ ok: true as const, value: undefined }), requestInput: async () => { throw new Error("not requested"); } }),
          workflow: Object.freeze({ request: async () => { throw new Error("not requested"); } }),
          observation: Object.freeze({ async observe() {} }),
          startCorrelation,
          hostOperations: Object.freeze({ "validator.intake-checks": Object.freeze({ execute: async () => Object.freeze({ accepted: true, value: null }) }) }),
          providerSessions,
          providerOwner: Object.freeze({ async dispose() {} }),
        }));
        adapters.push(adapter);
        return adapter;
      } }),
      ownerFacts: DISABLED_DELIVERY_OBSERVATION_SINK,
      slots,
      clock: Object.freeze({ now: () => Date.now() }),
      ids: Object.freeze({ create: () => "delivery-first-party" }),
    });

    try {
      const result = await lifecycle.activate(ready);
      expect(result, JSON.stringify(result)).toMatchObject({ kind: "TERMINAL", deliveryId: "delivery-first-party", outcome: "FAILED" });
      expect(await slots.read(workspace)).toEqual({ state: "EMPTY", worktree: workspace });
      expect(sourceCalls).toEqual([
        "https://api.github.example.test/repos/firestige/wsr-workflow-package/releases?per_page=100&page=1",
        descriptorUrl,
        provenanceUrl,
        checksumUrl,
        assetUrl,
      ]);
      expect(providerRuns).toBe(1);
      expect(execFileSync("git", ["rev-parse", "refs/heads/candidate"], { cwd: workspace, encoding: "utf8" }).trim()).toMatch(/^[a-f0-9]{40}$/u);
    } finally {
      await Promise.all(adapters.map((adapter) => runnerFactory.dispose(adapter)));
    }
  }, 30_000);
});
