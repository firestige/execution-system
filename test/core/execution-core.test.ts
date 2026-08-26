import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ImmediateConcurrencyController } from "../../src/bootstrap/index.js";
import { createDeliveryConfigProjection, deepFreeze, type ExecutionInstallationConfig } from "../../src/configuration/index.js";
import {
  ExecutionCoreAdmission,
  createExecutionEnvironment,
  type ExecutionPrebindingCommand,
} from "../../src/core/index.js";
import {
  CurrentSlotRepository,
  DeliveryAdmissionService,
  DeliveryRecoveryService,
} from "../../src/delivery/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "execution-core-"));
  const workspace = join(root, "workspace");
  const worktree = join(workspace, "feature");
  const slots = join(root, "state", "current-slots");
  await mkdir(join(worktree, ".git"), { recursive: true });
  await mkdir(slots, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const canonicalWorktree = await realpath(worktree);
  const config = deepFreeze({
    paths: {
      repositoryRoot: canonicalWorktree,
      workspaceRoot: canonicalWorkspace,
      allowedWorktreeRoots: [canonicalWorkspace],
      runner: { root: join(root, "state", "runner") },
    },
    runner: {
      implementationKey: "runner.v1",
      host: { engine: "langgraph" },
      provider: {
        key: "dsh", route: "fixture", modelId: "fixture-model", baseUrl: "https://provider.example/v1",
        credentialRef: "provider.default", maxParallelToolCalls: 4,
      },
    },
    controls: { allowExplicitRefresh: false, executionTimeoutMs: 3600000, maxConcurrentDeliveries: 4 },
    intake: { maxCorrelationBytes: 256 },
  }) as unknown as ExecutionInstallationConfig;
  const environment = createExecutionEnvironment(config);
  const repository = new CurrentSlotRepository(slots);
  const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true }));
  const admission = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(4));
  await admission.start();
  return { root, workspace: canonicalWorkspace, worktree: canonicalWorktree, slots, config, environment, repository, admission };
}

function request(worktree: string) {
  return {
    worktree,
    selector: "implementation@latest",
    prompt: { text: "implement the approved change", attachments: [] },
    intakeCorrelation: "session:42",
  } as const;
}

describe("Execution Core admission", () => {
  it("builds one frozen pre-binding command from a NEW admission and config-only projection", async () => {
    const f = await fixture();
    const core = new ExecutionCoreAdmission(f.environment, f.admission);
    const result = await core.begin(request(f.worktree));
    expect(result.kind).toBe("NEW");
    if (result.kind !== "NEW") return;
    const command: ExecutionPrebindingCommand = result.command;
    expect(command).toMatchObject({
      schemaVersion: "execution.prebinding-command@1.0.0",
      canonicalWorktree: f.worktree,
      selector: "implementation@latest",
      prompt: { text: "implement the approved change", attachments: [] },
      deliveryConfigProjectionIdentity: f.environment.deliveryConfigProjection.identity,
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(f.environment.deliveryConfigProjection).toEqual(createDeliveryConfigProjection(f.config));
    const serialized = JSON.stringify(command);
    expect(serialized).not.toContain("workflowSource");
    expect(serialized).not.toContain("observation");
    expect(serialized).not.toContain("credentialStorePath");
    await result.holder.release();
  });

  it("returns CONTENDED without reading selector or TaskPrompt while an ordinary holder exists", async () => {
    const f = await fixture();
    const core = new ExecutionCoreAdmission(f.environment, f.admission);
    const first = await core.begin(request(f.worktree));
    expect(first.kind).toBe("NEW");
    let touched = 0;
    const conflicting = Object.defineProperties({}, {
      worktree: { enumerable: true, value: f.worktree },
      selector: { enumerable: true, get() { touched += 1; throw new Error("selector must not be read"); } },
      prompt: { enumerable: true, get() { touched += 1; throw new Error("prompt must not be read"); } },
    });
    const result = await core.begin(conflicting);
    expect(result).toMatchObject({ kind: "CONTENDED", worktree: f.worktree });
    expect(touched).toBe(0);
    if (first.kind === "NEW") await first.holder.release();
  });

  it("returns RECOVERY from persisted owner truth without reading the new selector or prompt", async () => {
    const f = await fixture();
    const manifestPath = join(f.root, "state", "manifests", "delivery-1.json");
    await mkdir(join(f.root, "state", "manifests"), { recursive: true });
    await writeFile(manifestPath, "{}");
    await f.repository.persistBound({
      worktree: f.worktree,
      deliveryId: "delivery-1",
      manifestPath,
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    const recovery = new DeliveryRecoveryService(f.repository, Object.freeze({ verify: async () => true }));
    const admission = new DeliveryAdmissionService(f.repository, recovery, new ImmediateConcurrencyController(4));
    await admission.start();
    const core = new ExecutionCoreAdmission(f.environment, admission);
    let touched = 0;
    const incoming = Object.defineProperties({}, {
      worktree: { enumerable: true, value: f.worktree },
      selector: { enumerable: true, get() { touched += 1; throw new Error("selector must not be read"); } },
      prompt: { enumerable: true, get() { touched += 1; throw new Error("prompt must not be read"); } },
    });
    expect(await core.begin(incoming)).toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-1", state: "BOUND" });
    expect(touched).toBe(0);
  });

  it("canonicalizes aliases to a Git worktree root and rejects paths outside configured scope", async () => {
    const f = await fixture();
    const nested = join(f.worktree, "src", "nested");
    await mkdir(nested, { recursive: true });
    const core = new ExecutionCoreAdmission(f.environment, f.admission);
    const result = await core.begin(request(nested));
    expect(result.kind).toBe("NEW");
    if (result.kind === "NEW") {
      expect(result.command.canonicalWorktree).toBe(f.worktree);
      await result.holder.release();
    }
    const outside = join(f.root, "outside");
    await mkdir(join(outside, ".git"), { recursive: true });
    expect(await core.begin(request(outside))).toMatchObject({ kind: "ERROR", code: "WORKTREE_OUT_OF_SCOPE" });
  });

  it("admits an exact conversation workspace authority without widening to its parent", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside-workspace");
    await mkdir(join(outside, ".git"), { recursive: true });
    const canonicalOutside = await realpath(outside);
    const core = new ExecutionCoreAdmission(f.environment, f.admission);
    const authorize = (workspace: string) => Object.freeze({
      schemaVersion: "execution.conversation-workspace-authorization@1.0.0" as const,
      sessionKey: "session-a", workspaceId: "workspace-a", path: workspace,
    });

    expect(await core.begin(request(canonicalOutside))).toMatchObject({ kind: "ERROR", code: "WORKTREE_OUT_OF_SCOPE" });
    expect(await core.begin(request(canonicalOutside), authorize(f.root)))
      .toMatchObject({ kind: "ERROR", code: "WORKTREE_OUT_OF_SCOPE" });

    const result = await core.begin(request(canonicalOutside), authorize(canonicalOutside));
    expect(result.kind).toBe("NEW");
    if (result.kind === "NEW") {
      expect(result.command.canonicalWorktree).toBe(canonicalOutside);
      await result.holder.release();
    }
  });

  it("validates TaskPrompt and refresh only after NEW, then releases a rejected holder", async () => {
    const f = await fixture();
    const core = new ExecutionCoreAdmission(f.environment, f.admission);
    expect(await core.begin({ ...request(f.worktree), prompt: { text: "", attachments: [] } }))
      .toMatchObject({ kind: "ERROR", code: "INVALID_EXECUTION_REQUEST" });
    expect(await core.begin({ ...request(f.worktree), refresh: true }))
      .toMatchObject({ kind: "ERROR", code: "REFRESH_DISABLED" });
    expect(await core.begin({ ...request(f.worktree), intakeCorrelation: "x".repeat(257) }))
      .toMatchObject({ kind: "ERROR", code: "INVALID_EXECUTION_REQUEST" });
    const next = await core.begin({
      ...request(f.worktree),
      prompt: {
        text: "",
        attachments: [{
          identity: "attachment-1",
          filename: "design.md",
          mediaType: "text/markdown",
          byteLength: 12,
          digest: `sha256:${"c".repeat(64)}`,
          contentRef: "opaque:intake:42",
        }],
      },
    });
    expect(next.kind).toBe("NEW");
    if (next.kind === "NEW") {
      expect(next.command.prompt.attachments[0]).toMatchObject({ contentRef: "opaque:intake:42", byteLength: 12 });
      expect(Object.isFrozen(next.command.prompt.attachments[0])).toBe(true);
      await next.holder.release();
    }
  });

  it("returns typed failures for malformed requests and invalid worktree references", async () => {
    const f = await fixture();
    const core = new ExecutionCoreAdmission(f.environment, f.admission);
    expect(await core.begin(null)).toMatchObject({ kind: "ERROR", code: "INVALID_EXECUTION_REQUEST" });
    expect(await core.begin(request(join(f.workspace, "missing"))))
      .toMatchObject({ kind: "ERROR", code: "INVALID_WORKTREE" });
    const ordinaryDirectory = join(f.workspace, "ordinary");
    await mkdir(ordinaryDirectory);
    expect(await core.begin(request(ordinaryDirectory)))
      .toMatchObject({ kind: "ERROR", code: "INVALID_WORKTREE" });
    const file = join(f.workspace, "not-a-directory");
    await writeFile(file, "fixture");
    expect(await core.begin(request(file))).toMatchObject({ kind: "ERROR", code: "INVALID_WORKTREE" });
  });

  it("rejects non-canonical request values and maps the installation concurrency bound", async () => {
    const f = await fixture();
    expect(() => createExecutionEnvironment({ ...f.config } as ExecutionInstallationConfig))
      .toThrow("immutable canonical configuration");
    const admission = new DeliveryAdmissionService(
      f.repository,
      new DeliveryRecoveryService(f.repository, Object.freeze({ verify: async () => true })),
      new ImmediateConcurrencyController(1),
    );
    await admission.start();
    const core = new ExecutionCoreAdmission(f.environment, admission);
    const first = await core.begin(request(f.worktree));
    expect(first.kind).toBe("NEW");
    const second = join(f.workspace, "second");
    await mkdir(join(second, ".git"), { recursive: true });
    const worktreeB = await realpath(second);
    expect(await core.begin(request(worktreeB))).toMatchObject({ kind: "ERROR", code: "EXECUTION_BUSY" });
    if (first.kind === "NEW") {
      expect(await core.cancelPreDelivery(first.holder.admissionId)).toMatchObject({ kind: "PRE_DELIVERY_CANCELLED" });
    }
    expect(await core.begin({ ...request(f.worktree), prompt: { text: 42, attachments: [] } }))
      .toMatchObject({ kind: "ERROR", code: "INVALID_EXECUTION_REQUEST" });
    expect(await core.begin({
      ...request(f.worktree),
      prompt: {
        text: "",
        attachments: [{
          identity: "attachment-1",
          filename: "bad.bin",
          mediaType: "application/octet-stream",
          byteLength: -1,
          digest: "not-a-digest",
          contentRef: "opaque:bad",
        }],
      },
    })).toMatchObject({ kind: "ERROR", code: "INVALID_EXECUTION_REQUEST" });
  });
});
