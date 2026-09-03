import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { DeliveryConfigProjection } from "../../src/configuration/index.js";
import type { RunnerActivationContext } from "../../src/contracts/index.js";
import type { ExecutionRuntimeAdapter } from "../../src/execution/runtime-adapter.js";
import type { OwnerFact } from "../../src/bootstrap/index.js";
import {
  CurrentSlotRepository,
  DeliveryLifecycleService,
  DeliveryManifestRepository,
  type DeliveryAdmissionHolder,
  type DeliveryLifecycleOptions,
  type DeliveryRuntimeFactoryInput,
  type DeliveryManifest,
  type PersistBoundInput,
} from "../../src/delivery/index.js";
import { validRunnerActivation } from "../support/runner-activation-fixtures.js";
import { ManagedWorkspaceSnapshotError } from "../../src/custody/managed-workspace-snapshot.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}` as const;

function projection(): DeliveryConfigProjection {
  return Object.freeze({
    identity: sha("projection"),
    value: Object.freeze({
      schemaVersion: "execution.delivery-config@1.0.0",
      paths: Object.freeze({ repositoryRoot: "/repo", workspaceRoot: "/workspace", allowedWorktreeRoots: Object.freeze(["/workspace"]), runnerResources: Object.freeze({ journal: "runner/journal", checkpoints: "runner/checkpoints", sessions: "runner/sessions", custody: "runner/custody" }) }),
      runner: Object.freeze({ implementationKey: "runner.v1", host: Object.freeze({ engine: "langgraph" }), provider: Object.freeze({ key: "dsh", route: "deepseek", modelId: "deepseek-chat", baseUrl: "https://api.example.test", credentialRef: "PROVIDER_KEY", maxParallelToolCalls: 1 }) }),
      controls: Object.freeze({ executionTimeoutMs: 60_000, maxConcurrentDeliveries: 2, allowExplicitRefresh: false }),
    }),
  }) as unknown as DeliveryConfigProjection;
}

async function fixture(runtimeResult: "start-failed" | "unknown" | "invalid" | "terminal") {
  const root = await mkdtemp(join(tmpdir(), "delivery-lifecycle-"));
  const worktree = join(root, "workspace");
  await mkdir(worktree);
  const slots = new CurrentSlotRepository(join(root, "slots"));
  const manifests = new DeliveryManifestRepository(join(root, "manifests"));
  const events: string[] = [];
  let time = 0;
  const holder: DeliveryAdmissionHolder = Object.freeze({
    admissionId: "admission-1",
    worktree,
    cancellation: Object.freeze({ cancelled: false }),
    ownPreDeliveryResource() {},
    async persistBinding(input: Omit<PersistBoundInput, "worktree">) {
      events.push("current-slot:BOUND");
      return slots.persistBound({ ...input, worktree });
    },
    async release() { events.push("holder:release"); },
  });
  const resolved = Object.freeze({ name: "implementation", exactVersion: "1.1.0", packageDigest: sha("package"), localPath: join(root, "ready-package"), workflowId: "workflow.implementation" });
  await mkdir(resolved.localPath);
  let activation: RunnerActivationContext | undefined;
  const runtime: ExecutionRuntimeAdapter = Object.freeze({
    execute: vi.fn(async (request) => {
      events.push("runtime:execute");
      const delivery = {
        deliveryIdentity: request.activation.correlation.deliveryIdentity,
        manifestBindingIdentity: request.activation.correlation.manifestBindingIdentity,
        activationBindingIdentity: request.activation.bindingIdentity,
      };
      return runtimeResult === "start-failed"
        ? { ok: true as const, value: Object.freeze({ kind: "start-failed" as const, code: "START_FAILED" as const, detail: Object.freeze({ reason: "compile" }) }) }
        : runtimeResult === "unknown"
          ? { ok: true as const, value: Object.freeze({ kind: "unknown" as const, delivery, detail: Object.freeze({
            reason: "HOST_START_DISPOSITION_UNRESOLVED", stage: "HOST_START", causeCode: "CHECKPOINT_ORDER_VIOLATION",
          }) }) }
          : runtimeResult === "invalid"
            ? { ok: true as const, value: Object.freeze({ kind: "unknown" as const, delivery, detail: "malformed" }) as never }
            : { ok: true as const, value: Object.freeze({ kind: "terminal" as const, outcome: "COMPLETED" as const, settlement: Object.freeze({ delivery }), result: Object.freeze({}) }) as never };
    }),
    inspect: vi.fn(async () => ({ ok: false as const, error: { code: "ADAPTER_UNAVAILABLE" as const } })),
    cancel: vi.fn(async () => ({ ok: false as const, error: { code: "ADAPTER_UNAVAILABLE" as const } })),
  });
  const options: DeliveryLifecycleOptions = {
    resolver: Object.freeze({ resolve: async () => { events.push("package:resolve"); return { ok: true as const, value: resolved }; } }),
    manifests,
    snapshotRoot: join(root, "snapshots"),
    attachments: Object.freeze({ read: async () => { events.push("attachment:read"); return new Uint8Array(); } }),
    projector: Object.freeze({ project: async (manifest: DeliveryManifest) => {
      events.push("activation:project");
      activation = validRunnerActivation({ correlation: Object.freeze({
        ...validRunnerActivation().correlation,
        deliveryIdentity: manifest.deliveryId as never,
        taskIdentity: manifest.taskId as never,
        manifestBindingIdentity: manifest.deliveryBindingIdentity as never,
        packageIdentity: `${manifest.resolvedPackage.name}@${manifest.resolvedPackage.exactVersion}` as never,
        packageDigest: manifest.resolvedPackage.packageDigest as never,
        snapshotIdentity: manifest.prompt.snapshotIdentity as never,
        snapshotDigest: manifest.prompt.snapshotDigest as never,
        workflowIdentity: manifest.resolvedPackage.workflowId as never,
      }) });
      return activation;
    } }),
    runtime: Object.freeze({ create: async ({ ownerFacts }: DeliveryRuntimeFactoryInput) => {
      events.push("runtime:create");
      ownerFacts.emit(Object.freeze({ owner: "M02", name: "runner-wired", occurredAt: 0 }));
      return runtime;
    } }),
    ownerFacts: Object.freeze({ emit: (fact: OwnerFact) => { events.push(`fact:${fact.owner}:${fact.name}`); } }),
    slots,
    clock: Object.freeze({ now: () => ++time }),
    ids: Object.freeze({ create: () => "delivery-1" }),
  };
  const service = new DeliveryLifecycleService(options);
  const ready = Object.freeze({
    kind: "NEW" as const,
    holder,
    command: Object.freeze({
      schemaVersion: "execution.prebinding-command@1.1.0" as const,
      admissionId: "admission-1",
      canonicalWorktree: worktree,
      selector: "implementation@1.1.0",
      prompt: Object.freeze({ text: "implement", attachments: Object.freeze([]) }),
      taskSelection: Object.freeze({
        schemaVersion: "execution.task-selection@0.1.0" as const,
        mode: "NEW_TASK" as const,
      }),
      refresh: false,
      deliveryConfigProjection: projection().value,
      deliveryConfigProjectionIdentity: projection().identity,
    }),
  });
  return { root, worktree, slots, manifests, service, options, ready, events, runtime, get activation() { return activation; } };
}

describe("M01 production Delivery lifecycle", () => {
  it("creates a new Task by default and reuses only an explicitly selected exact Task ID", async () => {
    const fresh = await fixture("unknown");
    await fresh.service.activate(Object.freeze({
      ...fresh.ready,
      command: Object.freeze({
        ...fresh.ready.command,
        taskSelection: Object.freeze({
          schemaVersion: "execution.task-selection@0.1.0" as const,
          mode: "NEW_TASK" as const,
          displayName: "Token tuning",
        }),
      }),
    }));
    const freshSlot = await fresh.slots.read(fresh.worktree);
    if (freshSlot.state === "EMPTY") throw new Error("expected persisted fresh Task binding");
    expect(await fresh.manifests.load(freshSlot.manifestPath)).toMatchObject({
      taskId: "task-delivery-1",
      taskDisplayName: "Token tuning",
    });

    const reused = await fixture("unknown");
    await reused.service.activate(Object.freeze({
      ...reused.ready,
      command: Object.freeze({
        ...reused.ready.command,
        taskSelection: Object.freeze({
          schemaVersion: "execution.task-selection@0.1.0" as const,
          mode: "REUSE_TASK" as const,
          taskId: "task-existing",
        }),
      }),
    }));
    const reusedSlot = await reused.slots.read(reused.worktree);
    if (reusedSlot.state === "EMPTY") throw new Error("expected persisted reused Task binding");
    expect(await reused.manifests.load(reusedSlot.manifestPath)).toMatchObject({
      taskId: "task-existing",
    });
    expect(await reused.manifests.load(reusedSlot.manifestPath)).not.toHaveProperty("taskDisplayName");
  });

  it("durably correlates the Runner start before its first Host or Action effect", async () => {
    const f = await fixture("terminal");
    let stateAtFirstEffect: string | undefined;
    const service = new DeliveryLifecycleService({
      ...f.options,
      runtime: Object.freeze({ create: async (input: DeliveryRuntimeFactoryInput) => Object.freeze({
        execute: async (request: any) => {
          const port = (input as any).startCorrelation;
          if (port !== undefined) {
            const fact = Object.freeze({
              schemaVersion: "runner.start-correlation@1.0.0",
              delivery: Object.freeze({
                deliveryIdentity: request.activation.correlation.deliveryIdentity,
                manifestBindingIdentity: request.activation.correlation.manifestBindingIdentity,
                activationBindingIdentity: request.activation.bindingIdentity,
              }),
            });
            const acknowledged = await port.acknowledge(fact);
            if (!acknowledged.ok) return acknowledged;
            expect(await port.acknowledge(fact)).toMatchObject({ ok: true });
            expect(await port.acknowledge(Object.freeze({
              ...fact,
              delivery: Object.freeze({ ...fact.delivery, deliveryIdentity: "wrong-delivery" }),
            }))).toMatchObject({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
          }
          stateAtFirstEffect = (await f.slots.read(f.worktree)).state;
          return f.runtime.execute(request);
        },
        inspect: f.runtime.inspect,
        cancel: f.runtime.cancel,
      }) }),
    });

    await service.activate(f.ready);

    expect(stateAtFirstEffect).toBe("RUNNING_CORRELATED");
  });

  it("keeps start correlation controlling when Observation rejects its later best-effort copy", async () => {
    const f = await fixture("terminal");
    let stateAtFirstEffect: string | undefined;
    const service = new DeliveryLifecycleService({
      ...f.options,
      ownerFacts: Object.freeze({ emit() { throw new Error("M03 unavailable"); } }),
      runtime: Object.freeze({ create: async (input: DeliveryRuntimeFactoryInput) => Object.freeze({
        execute: async (request: any) => {
          const acknowledged = await input.startCorrelation.acknowledge(Object.freeze({
            schemaVersion: "runner.start-correlation@1.0.0",
            delivery: Object.freeze({
              deliveryIdentity: request.activation.correlation.deliveryIdentity,
              manifestBindingIdentity: request.activation.correlation.manifestBindingIdentity,
              activationBindingIdentity: request.activation.bindingIdentity,
            }),
          }));
          if (!acknowledged.ok) return acknowledged;
          stateAtFirstEffect = (await f.slots.read(f.worktree)).state;
          return f.runtime.execute(request);
        }, inspect: f.runtime.inspect, cancel: f.runtime.cancel,
      }) }),
    });

    expect(await service.activate(f.ready)).toMatchObject({ kind: "TERMINAL", outcome: "SUCCEEDED" });
    expect(stateAtFirstEffect).toBe("RUNNING_CORRELATED");
  });

  it("reports persisted running truth when Runner acknowledgement persistence is interrupted", async () => {
    const f = await fixture("terminal");
    const service = new DeliveryLifecycleService({
      ...f.options,
      runtime: Object.freeze({ create: async (input: DeliveryRuntimeFactoryInput) => Object.freeze({
        execute: async (request: any) => {
          const acknowledged = await input.startCorrelation.acknowledge(Object.freeze({
            schemaVersion: "runner.start-correlation@1.0.0",
            delivery: Object.freeze({
              deliveryIdentity: request.activation.correlation.deliveryIdentity,
              manifestBindingIdentity: request.activation.correlation.manifestBindingIdentity,
              activationBindingIdentity: request.activation.bindingIdentity,
            }),
          }));
          if (!acknowledged.ok) return acknowledged;
          return { ok: false as const, error: { code: "ADAPTER_UNAVAILABLE" as const } };
        }, inspect: f.runtime.inspect, cancel: f.runtime.cancel,
      }) }),
    });

    expect(await service.activate(f.ready)).toMatchObject({
      kind: "RECOVERY", deliveryId: "delivery-1", state: "RUNNING_CORRELATED",
    });
    expect(await f.slots.read(f.worktree)).toMatchObject({ state: "RUNNING_CORRELATED" });
  });

  it("persists the binding and wires owner facts before the first pinned M02 effect", async () => {
    const f = await fixture("start-failed");
    const result = await f.service.activate(f.ready);

    expect(result).toMatchObject({ kind: "ERROR", code: "RUNNER_START_FAILED" });
    expect(f.events).toEqual([
      "package:resolve",
      "current-slot:BOUND",
      "holder:release",
      "fact:M01:delivery-bound",
      "activation:project",
      "fact:M01:runner-launch-requested",
      "runtime:create",
      "fact:M02:runner-wired",
      "runtime:execute",
      "fact:M02:start-failed",
      "fact:M01:start-failure-handled",
    ]);
    expect(await f.slots.read(f.worktree)).toEqual({ state: "EMPTY", worktree: f.worktree });
  });

  it("retains exact persisted truth when M02 returns an exactly correlated unknown result", async () => {
    const f = await fixture("unknown");
    const result = await f.service.activate(f.ready);

    expect(result).toMatchObject({
      kind: "UNKNOWN", deliveryId: "delivery-1", state: "RESULT_UNRESOLVED",
      diagnostic: { stage: "HOST_START", causeCode: "CHECKPOINT_ORDER_VIOLATION" },
    });
    expect(await f.slots.read(f.worktree)).toMatchObject({
      state: "RESULT_UNRESOLVED", deliveryId: "delivery-1",
      diagnostic: { stage: "HOST_START", causeCode: "CHECKPOINT_ORDER_VIOLATION" },
    });
  });

  it("recovers from the persisted Manifest identity and supports exact authorized abandonment", async () => {
    const f = await fixture("unknown");
    await f.service.activate(f.ready);
    const slot = await f.slots.read(f.worktree);
    if (slot.state === "EMPTY") throw new Error("expected occupied slot");

    const recovered = await f.service.recover(slot);
    expect(recovered).toMatchObject({ kind: "UNKNOWN", deliveryId: "delivery-1" });
    expect(f.activation?.correlation.manifestBindingIdentity).toBe(slot.deliveryBindingIdentity);
    expect(await f.service.abandon(f.worktree, "wrong-delivery")).toMatchObject({ kind: "ERROR", code: "DELIVERY_UNKNOWN" });
    expect(await f.service.abandon(f.worktree, "delivery-1")).toMatchObject({ kind: "TERMINAL", deliveryId: "delivery-1", outcome: "CANCELLED" });
    expect(await f.slots.read(f.worktree)).toEqual({ state: "EMPTY", worktree: f.worktree });
  });

  it("rejects a malformed Runner result while retaining recoverable truth", async () => {
    const f = await fixture("invalid");
    const result = await f.service.activate(f.ready);

    expect(result).toMatchObject({ kind: "ERROR", code: "RUNNER_RESULT_INVALID" });
    expect(await f.slots.read(f.worktree)).toMatchObject({ state: "RESULT_UNRESOLVED", deliveryId: "delivery-1" });
  });

  it("validates a correlated terminal result before clearing the slot", async () => {
    const f = await fixture("terminal");
    const result = await f.service.activate(f.ready);

    expect(result).toMatchObject({ kind: "TERMINAL", deliveryId: "delivery-1", outcome: "SUCCEEDED" });
    expect(await f.slots.read(f.worktree)).toEqual({ state: "EMPTY", worktree: f.worktree });
    expect(f.events).toContain("fact:M02:terminal-validated");
    expect(f.events).toContain("fact:M01:terminal-handling-complete");
  });

  it("publishes no projection invalidation between clearing the current slot and persisting terminal truth", async () => {
    const f = await fixture("terminal");
    const observedStates: Array<Promise<string>> = [];
    let enterCompleted!: () => void;
    let releaseCompleted!: () => void;
    const completedEntered = new Promise<void>((resolve) => { enterCompleted = resolve; });
    const completedReleased = new Promise<void>((resolve) => { releaseCompleted = resolve; });
    const service = new DeliveryLifecycleService({
      ...f.options,
      invalidations: Object.freeze({ publish() {
        observedStates.push(f.slots.read(f.worktree).then((slot) => slot.state));
      } }),
      completed: Object.freeze({ async publish() {
        enterCompleted();
        await completedReleased;
      } }),
    });

    const activation = service.activate(f.ready);
    await completedEntered;
    expect(await Promise.all(observedStates)).not.toContain("EMPTY");
    releaseCompleted();
    await expect(activation).resolves.toMatchObject({ kind: "TERMINAL", outcome: "SUCCEEDED" });
    expect(await Promise.all(observedStates)).toContain("EMPTY");
  });

  it("maps preparation and startup boundary failures without fabricating terminal truth", async () => {
    const resolution = await fixture("unknown");
    const resolverFailure = new DeliveryLifecycleService({
      ...resolution.options,
      resolver: Object.freeze({ resolve: async () => { throw new Error("source unavailable"); } }),
    });
    expect(await resolverFailure.activate(resolution.ready)).toMatchObject({ kind: "ERROR", code: "WORKFLOW_FETCH_FAILED" });

    const snapshot = await fixture("unknown");
    const snapshotFailure = new DeliveryLifecycleService({
      ...snapshot.options,
      attachments: Object.freeze({ read: async () => { throw new Error("attachment unavailable"); } }),
    });
    const bytes = new TextEncoder().encode("attachment");
    const readyWithAttachment = Object.freeze({ ...snapshot.ready, command: Object.freeze({
      ...snapshot.ready.command,
      prompt: Object.freeze({ text: "", attachments: Object.freeze([Object.freeze({
        identity: "attachment-1", filename: "input.txt", mediaType: "text/plain", byteLength: bytes.byteLength,
        digest: sha("attachment"), contentRef: "opaque:attachment",
      })]) }),
    }) });
    expect(await snapshotFailure.activate(readyWithAttachment)).toMatchObject({ kind: "ERROR", code: "DELIVERY_BINDING_FAILED" });

    const persistence = await fixture("unknown");
    const persistenceFailure = new DeliveryLifecycleService({
      ...persistence.options,
      manifests: Object.freeze({
        persist: async () => { throw new Error("disk unavailable"); },
        load: persistence.manifests.load.bind(persistence.manifests),
        discard: persistence.manifests.discard.bind(persistence.manifests),
      }) as unknown as DeliveryManifestRepository,
    });
    expect(await persistenceFailure.activate(persistence.ready)).toMatchObject({ kind: "ERROR", code: "DELIVERY_CREATE_FAILED" });

    const projection = await fixture("unknown");
    const projectionFailure = new DeliveryLifecycleService({
      ...projection.options,
      projector: Object.freeze({ project: async () => { throw new Error("projection invalid"); } }),
    });
    expect(await projectionFailure.activate(projection.ready)).toMatchObject({ kind: "ERROR", code: "DELIVERY_BINDING_FAILED" });
    expect(await projection.slots.read(projection.worktree)).toMatchObject({ state: "BOUND" });
    expect(projection.events).toContain("fact:M01:delivery-bound");

    const capacity = await fixture("unknown");
    const capacityFailure = new DeliveryLifecycleService({
      ...capacity.options,
      projector: Object.freeze({ project: async () => {
        throw new ManagedWorkspaceSnapshotError("total-bytes", 100, 101);
      } }),
    });
    expect(await capacityFailure.activate(capacity.ready))
      .toMatchObject({ kind: "ERROR", code: "WORKSPACE_SNAPSHOT_CAPACITY_EXCEEDED" });

    const startup = await fixture("unknown");
    const startupFailure = new DeliveryLifecycleService({
      ...startup.options,
      runtime: Object.freeze({ create: async () => { throw new Error("runner startup uncertain"); } }),
    });
    expect(await startupFailure.activate(startup.ready)).toMatchObject({ kind: "UNKNOWN", state: "START_UNCERTAIN" });
    expect(await startup.slots.read(startup.worktree)).toMatchObject({ state: "START_UNCERTAIN" });
  });

  it("returns persisted terminal-handling recovery without replaying Runner", async () => {
    const f = await fixture("unknown");
    await f.service.activate(f.ready);
    await f.slots.transition(f.worktree, "M02_RECONCILED_TERMINAL", 100);
    const slot = await f.slots.read(f.worktree);
    if (slot.state === "EMPTY") throw new Error("expected terminal handling");

    expect(await f.service.recover(slot)).toMatchObject({ kind: "RECOVERY", state: "TERMINAL_HANDLING", deliveryId: "delivery-1" });
    expect(f.runtime.execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed across persisted lifecycle recovery and Runner boundary mismatches", async () => {
    const invalidManifest = await fixture("unknown");
    const invalidManifestService = new DeliveryLifecycleService({
      ...invalidManifest.options,
      ids: Object.freeze({ create: () => "" }),
    });
    expect(await invalidManifestService.activate(invalidManifest.ready)).toMatchObject({ kind: "ERROR", code: "DELIVERY_BINDING_FAILED" });

    const interruptedPersist = await fixture("unknown");
    const interruptedReady = Object.freeze({ ...interruptedPersist.ready, holder: Object.freeze({
      ...interruptedPersist.ready.holder,
      persistBinding: async () => { throw new Error("slot write interrupted"); },
    }) });
    expect(await interruptedPersist.service.activate(interruptedReady)).toMatchObject({ kind: "ERROR", code: "DELIVERY_CREATE_FAILED" });

    const mismatchedRecovery = await fixture("unknown");
    await mismatchedRecovery.service.activate(mismatchedRecovery.ready);
    const occupied = await mismatchedRecovery.slots.read(mismatchedRecovery.worktree);
    if (occupied.state === "EMPTY") throw new Error("expected occupied slot");
    expect(await mismatchedRecovery.service.recover(Object.freeze({ ...occupied, deliveryBindingIdentity: sha("wrong-binding") })))
      .toMatchObject({ kind: "ERROR", code: "DELIVERY_BINDING_FAILED" });
    expect(await mismatchedRecovery.service.recover(Object.freeze({ ...occupied, manifestPath: join(mismatchedRecovery.root, "missing-manifest.json") })))
      .toMatchObject({ kind: "ERROR", code: "DELIVERY_BINDING_FAILED" });
    await mismatchedRecovery.slots.transition(mismatchedRecovery.worktree, "M02_RECONCILED_RUNNING", 101);
    expect(await mismatchedRecovery.service.abandon(mismatchedRecovery.worktree, "delivery-1"))
      .toMatchObject({ kind: "TERMINAL", outcome: "CANCELLED", summary: "AUTHORIZED_ABANDONMENT" });

    const startFailedRecovery = await fixture("unknown");
    const projectionFailure = new DeliveryLifecycleService({
      ...startFailedRecovery.options,
      projector: Object.freeze({ project: async () => { throw new Error("projection unavailable"); } }),
    });
    await projectionFailure.activate(startFailedRecovery.ready);
    await startFailedRecovery.slots.transition(startFailedRecovery.worktree, "M01_RUNNER_LAUNCH_REQUESTED", 10);
    await startFailedRecovery.slots.transition(startFailedRecovery.worktree, "M02_START_FAILED", 11);
    const startFailed = await startFailedRecovery.slots.read(startFailedRecovery.worktree);
    if (startFailed.state === "EMPTY") throw new Error("expected START_FAILED");
    expect(await startFailedRecovery.service.recover(startFailed)).toMatchObject({ kind: "ERROR", code: "RUNNER_START_FAILED" });

    const callFailure = await fixture("unknown");
    const callFailureService = new DeliveryLifecycleService({
      ...callFailure.options,
      runtime: Object.freeze({ create: async () => Object.freeze({
        execute: async () => { throw new Error("call interrupted"); },
        inspect: async () => ({ ok: false as const, error: { code: "ADAPTER_UNAVAILABLE" as const } }),
        cancel: async () => ({ ok: false as const, error: { code: "ADAPTER_UNAVAILABLE" as const } }),
      }) }),
    });
    expect(await callFailureService.activate(callFailure.ready)).toMatchObject({ kind: "UNKNOWN", state: "START_UNCERTAIN" });

    const invalidActivation = await fixture("unknown");
    const invalidActivationService = new DeliveryLifecycleService({
      ...invalidActivation.options,
      projector: Object.freeze({ project: async (manifest: DeliveryManifest) => ({
        ...validRunnerActivation(),
        correlation: { ...validRunnerActivation().correlation, deliveryIdentity: manifest.deliveryId },
      }) as RunnerActivationContext }),
    });
    expect(await invalidActivationService.activate(invalidActivation.ready)).toMatchObject({ kind: "ERROR", code: "DELIVERY_BINDING_FAILED" });
  });
});
