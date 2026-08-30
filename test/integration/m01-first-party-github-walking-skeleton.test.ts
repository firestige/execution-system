import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ImmediateConcurrencyController } from "../../src/bootstrap/index.js";
import { RunnerFactory, type RunnerFactoryConfig } from "../../src/index.js";
import { ExecutionCoreAdmission } from "../../src/core/index.js";
import {
  CurrentSlotRepository,
  DeliveryAdmissionProjector,
  DeliveryAdmissionService,
  DeliveryLifecycleService,
  DeliveryManifestRepository,
  DeliveryRecoveryService,
  type DeliveryRuntimeFactoryInput,
  DISABLED_DELIVERY_OBSERVATION_SINK,
  FrozenWorkflowPackageValidator,
  GitHubWorkflowPackageSource,
  WorkflowPackageResolver,
  WorkflowPackageStore,
  type WorkflowPackageCompatibilityTarget,
} from "../../src/delivery/index.js";

const repositoryRoot = path.dirname(fileURLToPath(new URL("../..", import.meta.url)));
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function completion(result: unknown): string {
  return [
    `data: ${JSON.stringify({ id: "completion-1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "workflow_complete", arguments: JSON.stringify({ result }) } }] }, finish_reason: "tool_calls" }] })}`,
    "", "data: [DONE]", "", "",
  ].join("\n");
}

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
    execFileSync("git", ["add", "README.md"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });

    const material = path.join(root, "release-material");
    await mkdir(material);
    await cp(path.join(repositoryRoot, "workflow-package", "implementation"), path.join(material, "package"), { recursive: true });
    const archivePath = path.join(root, "workflow-package-implementation-workflow-0.3.0.tar.gz");
    const packed = spawnSync("tar", ["-czf", archivePath, "-C", material, "."], { encoding: "utf8", shell: false });
    if (packed.status !== 0) throw new Error(packed.stderr);
    const archive = await readFile(archivePath);
    const sourceCalls: string[] = [];
    const assetUrl = "https://github.example.test/releases/download/0.3.0/workflow-package-implementation-workflow-0.3.0.tar.gz";
    const descriptorUrl = "https://github.example.test/releases/download/scoped/workflow-package-implementation-workflow-0.3.0.json";
    const checksumUrl = `${assetUrl}.sha256`;
    const archiveDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    const source = new GitHubWorkflowPackageSource({
      kind: "github",
      repository: "firestige/wsr-workflow-package",
      releasesBaseUrl: "https://api.github.example.test/repos/firestige/wsr-workflow-package/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, Object.freeze({ request: async (url: string) => {
      sourceCalls.push(url);
      if (url.includes("/releases?per_page=100&page=1")) return { status: 200, body: Buffer.from(JSON.stringify([{
        tag_name: "workflow-package/implementation-workflow/v0.3.0", draft: false, prerelease: false,
        assets: [
          { name: path.basename(archivePath), browser_download_url: assetUrl },
          { name: "workflow-package-implementation-workflow-0.3.0.json", browser_download_url: descriptorUrl },
          { name: "workflow-package-implementation-workflow-0.3.0.tar.gz.sha256", browser_download_url: checksumUrl },
        ],
      }])) };
      if (url === descriptorUrl) return { status: 200, body: Buffer.from(JSON.stringify({
        schemaVersion: "workflow-package.package-release@1.0.0", revision: "a".repeat(40),
        tag: "workflow-package/implementation-workflow/v0.3.0",
        package: { name: "implementation-workflow", version: "0.3.0", digest: `sha256:${"b".repeat(64)}` },
        archive: { name: path.basename(archivePath), sha256: archiveDigest, bytes: archive.byteLength },
        checksum: { name: "workflow-package-implementation-workflow-0.3.0.tar.gz.sha256" },
      })) };
      if (url === checksumUrl) return { status: 200, body: Buffer.from(`${archiveDigest.slice(7)}  workflow-package-implementation-workflow-0.3.0.tar.gz\n`) };
      return url === assetUrl ? { status: 200, body: Uint8Array.from(archive) } : { status: 404, body: new Uint8Array() };
    } }));
    const store = new WorkflowPackageStore({ readyRoot: path.join(root, "package-store"), stagingRoot: path.join(root, "staging") });
    const compatibility: WorkflowPackageCompatibilityTarget = Object.freeze({
      contractVersion: "1.1.0",
      providerKey: "dsh",
      providerCapabilities: Object.freeze(["structured-completion", "action-interaction"] as const),
      hostCapabilities: Object.freeze(["deterministic-validation", "deterministic-selection", "deterministic-transformation"] as const),
    });
    const resolver = new WorkflowPackageResolver(store, source, new FrozenWorkflowPackageValidator(compatibility));

    const authorization: string[] = [];
    const endpoint = createServer((request, response) => {
      authorization.push(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(completion({ authorityBound: false, designIdentityExact: false, obligationRegisterBound: false, derivableFactMissing: true, routing: "unmatched" }));
    });
    servers.push(endpoint);
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    if (address === null || typeof address === "string") throw new Error("endpoint unavailable");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const credentialPath = path.join(root, "credentials.yml");
    await writeFile(credentialPath, "version: 1\nrefs:\n  PROVIDER_KEY: synthetic-secret\n", "utf8");
    await chmod(credentialPath, 0o600);

    const slots = new CurrentSlotRepository(path.join(root, "current-slots"));
    const recovery = new DeliveryRecoveryService(slots, Object.freeze({ verify: async () => true }));
    const admission = new DeliveryAdmissionService(slots, recovery, new ImmediateConcurrencyController(1));
    await admission.start();
    const deliveryProjection = Object.freeze({
      value: Object.freeze({
        schemaVersion: "execution.delivery-config@1.0.0" as const,
        paths: Object.freeze({ repositoryRoot: workspace, workspaceRoot: workspace, allowedWorktreeRoots: Object.freeze([workspace]), runnerResources: Object.freeze({ journal: "runner/journal" as const, checkpoints: "runner/checkpoints" as const, sessions: "runner/sessions" as const, custody: "runner/custody" as const }) }),
        runner: Object.freeze({ implementationKey: "runner.v1" as const, host: Object.freeze({ engine: "langgraph" as const }), provider: Object.freeze({ key: "dsh" as const, route: "deepseek", modelId: "deepseek-chat", baseUrl, credentialRef: "PROVIDER_KEY", maxParallelToolCalls: 1 }) }),
        controls: Object.freeze({ executionTimeoutMs: 60_000, maxConcurrentDeliveries: 1, allowExplicitRefresh: false }),
      }),
      identity: `sha256:${"a".repeat(64)}`,
    });
    const core = new ExecutionCoreAdmission(Object.freeze({
      schemaVersion: "execution.environment@1.0.0",
      allowedWorktreeRoots: Object.freeze([workspace]),
      allowExplicitRefresh: false,
      maxCorrelationBytes: 256,
      deliveryConfigProjection: deliveryProjection,
    }), admission);
    const ready = await core.begin({ worktree: workspace, selector: "implementation-workflow@0.3.0", prompt: { text: "exercise the first-party path", attachments: [] } });
    if (ready.kind !== "NEW") throw new Error(`expected NEW, got ${ready.kind}`);

    const runnerFactory = new RunnerFactory();
    const adapters: Array<Awaited<ReturnType<RunnerFactory["create"]>>> = [];
    const runtimeConfig = Object.freeze({
      schemaVersion: "runner.factory@1.0.0",
      stateDirectory: path.join(root, "runner", "coordinator"),
      custody: Object.freeze({ recordsDirectory: path.join(root, "runner", "custody"), publication: Object.freeze({ targetIdentity: "publication-target.walking", repositoryPath: workspace, ref: "refs/heads/candidate" }) }),
      provider: Object.freeze({ key: "dsh-headless", configuration: Object.freeze({ providerIdentity: "dsh-headless", workspaceDirectory: workspace, sessionStorageDirectory: path.join(root, "runner", "sessions"), credentialStore: Object.freeze({ path: credentialPath, watch: false }), maxParallelToolCalls: 1 }) }),
      invocation: Object.freeze({ journalDirectory: path.join(root, "runner", "journals") }),
      host: Object.freeze({ engine: "langgraph", checkpointDirectory: path.join(root, "runner", "checkpoints") }),
      implementationIdentity: "implementation.runner.langgraph-dsh",
    }) satisfies RunnerFactoryConfig;
    const lifecycle = new DeliveryLifecycleService({
      resolver,
      manifests: new DeliveryManifestRepository(path.join(root, "manifests")),
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
      expect(result).toMatchObject({ kind: "TERMINAL", deliveryId: "delivery-first-party", outcome: "FAILED" });
      expect(await slots.read(workspace)).toEqual({ state: "EMPTY", worktree: workspace });
      expect(sourceCalls).toEqual([
        "https://api.github.example.test/repos/firestige/wsr-workflow-package/releases?per_page=100&page=1",
        descriptorUrl,
        checksumUrl,
        assetUrl,
      ]);
      expect(authorization).toEqual(["Bearer synthetic-secret"]);
      expect(execFileSync("git", ["rev-parse", "refs/heads/candidate"], { cwd: workspace, encoding: "utf8" }).trim()).toMatch(/^[a-f0-9]{40}$/u);
    } finally {
      await Promise.all(adapters.map((adapter) => runnerFactory.dispose(adapter)));
    }
  }, 30_000);
});
