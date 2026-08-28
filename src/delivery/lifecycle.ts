import type { ExecutionFailure, ExecutionResult } from "../application/execution-application.js";
import type { AttachmentContentPort, ClockPort, DisabledObservationSink, IdPort, OwnerFact, OwnerFactIngress } from "../bootstrap/contracts.js";
import { deepFreeze, type DeliveryConfigProjection } from "../configuration/index.js";
import type { RunnerActivationContext } from "../contracts/index.js";
import type { RunnerStartCorrelationFact, RunnerStartCorrelationPort } from "../coordinator/runner-coordinator.js";
import type { ExecutionPrebindingReady } from "../core/execution-core.js";
import { EXECUTION_RUNTIME_ADAPTER_VERSION, type ExecutionRuntimeAdapter, type ExecutionRuntimeResult } from "../execution/runtime-adapter.js";
import type { DeliveryAdmissionHolder } from "./admission.js";
import type { CurrentSlotRepository, OccupiedCurrentSlot } from "./current-slot.js";
import {
  captureTaskPromptSnapshot,
  createDeliveryManifest,
  type DeliveryManifest,
  type DeliveryManifestRepository,
  discardTaskPromptSnapshot,
} from "./manifest.js";
import type { WorkflowPackageResolver, WorkflowPackageResolutionResult } from "./workflow-package-resolver.js";

export interface DeliveryActivationProjector {
  project(manifest: DeliveryManifest): Promise<RunnerActivationContext>;
}

export interface DeliveryRuntimeFactoryInput {
  readonly manifest: DeliveryManifest;
  readonly activation: RunnerActivationContext;
  readonly ownerFacts: OwnerFactIngress;
  readonly startCorrelation: RunnerStartCorrelationPort;
}

export interface DeliveryRuntimeFactory {
  ownerFacts?(manifest: DeliveryManifest, activation: RunnerActivationContext): OwnerFactIngress;
  create(input: DeliveryRuntimeFactoryInput): Promise<ExecutionRuntimeAdapter>;
}

export interface DeliveryLifecycleOptions {
  readonly resolver: Pick<WorkflowPackageResolver, "resolve">;
  readonly manifests: DeliveryManifestRepository;
  readonly snapshotRoot: string;
  readonly attachments: AttachmentContentPort;
  readonly projector: DeliveryActivationProjector;
  readonly runtime: DeliveryRuntimeFactory;
  readonly ownerFacts: OwnerFactIngress;
  readonly slots: CurrentSlotRepository;
  readonly clock: ClockPort;
  readonly ids: IdPort;
}

export const DISABLED_DELIVERY_OBSERVATION_SINK: DisabledObservationSink = Object.freeze({
  kind: "disabled",
  emit(): void {},
});

function failure(code: ExecutionFailure["code"]): ExecutionFailure {
  return Object.freeze({ kind: "ERROR", code, message: code });
}

function safeEmit(ingress: OwnerFactIngress, fact: OwnerFact): void {
  try { ingress.emit(Object.freeze(fact)); } catch { /* Observation is non-controlling. */ }
}

function projectionFrom(ready: ExecutionPrebindingReady): DeliveryConfigProjection {
  return deepFreeze({
    value: ready.command.deliveryConfigProjection,
    identity: ready.command.deliveryConfigProjectionIdentity,
  }) as DeliveryConfigProjection;
}

function exactDelivery(activation: RunnerActivationContext) {
  return Object.freeze({
    deliveryIdentity: activation.correlation.deliveryIdentity,
    manifestBindingIdentity: activation.correlation.manifestBindingIdentity,
    activationBindingIdentity: activation.bindingIdentity,
  });
}

function exactStartCorrelationFact(value: RunnerStartCorrelationFact, activation: RunnerActivationContext): boolean {
  return Object.isFrozen(value) && Object.isFrozen(value.delivery)
    && Object.keys(value).sort().join(",") === "delivery,schemaVersion"
    && Object.keys(value.delivery).sort().join(",") === "activationBindingIdentity,deliveryIdentity,manifestBindingIdentity"
    && value.schemaVersion === "runner.start-correlation@1.0.0"
    && value.delivery.deliveryIdentity === activation.correlation.deliveryIdentity
    && value.delivery.manifestBindingIdentity === activation.correlation.manifestBindingIdentity
    && value.delivery.activationBindingIdentity === activation.bindingIdentity;
}

function correlated(result: Extract<ExecutionRuntimeResult, { kind: "unknown" }>, activation: RunnerActivationContext): boolean {
  const expected = exactDelivery(activation);
  return result.delivery.deliveryIdentity === expected.deliveryIdentity
    && result.delivery.manifestBindingIdentity === expected.manifestBindingIdentity
    && result.delivery.activationBindingIdentity === expected.activationBindingIdentity;
}

function terminalCorrelated(result: Extract<ExecutionRuntimeResult, { kind: "terminal" }>, activation: RunnerActivationContext): boolean {
  const expected = exactDelivery(activation);
  const actual = result.settlement.delivery;
  return actual.deliveryIdentity === expected.deliveryIdentity
    && actual.manifestBindingIdentity === expected.manifestBindingIdentity
    && actual.activationBindingIdentity === expected.activationBindingIdentity;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function runtimeResultShape(value: unknown): value is ExecutionRuntimeResult {
  if (!object(value) || typeof value.kind !== "string") return false;
  if (value.kind === "start-failed") {
    return exactKeys(value, ["kind", "code", "detail"])
      && value.code === "START_FAILED" && object(value.detail);
  }
  if (value.kind === "unknown") {
    return exactKeys(value, ["kind", "delivery", "detail"])
      && object(value.delivery) && exactKeys(value.delivery, ["deliveryIdentity", "manifestBindingIdentity", "activationBindingIdentity"])
      && typeof value.delivery.deliveryIdentity === "string"
      && typeof value.delivery.manifestBindingIdentity === "string"
      && typeof value.delivery.activationBindingIdentity === "string"
      && object(value.detail);
  }
  if (value.kind === "terminal") {
    return exactKeys(value, ["kind", "outcome", "settlement", "result"])
      && new Set(["COMPLETED", "FAILED", "INCOMPLETE", "CANCELLED"]).has(String(value.outcome))
      && object(value.settlement) && object(value.settlement.delivery);
  }
  return false;
}

function resultCarriesExactDelivery(value: unknown, activation: RunnerActivationContext): boolean {
  if (!object(value)) return false;
  const delivery = value.kind === "unknown" && object(value.delivery)
    ? value.delivery
    : value.kind === "terminal" && object(value.settlement) && object(value.settlement.delivery)
      ? value.settlement.delivery
      : undefined;
  const expected = exactDelivery(activation);
  return delivery !== undefined
    && delivery.deliveryIdentity === expected.deliveryIdentity
    && delivery.manifestBindingIdentity === expected.manifestBindingIdentity
    && delivery.activationBindingIdentity === expected.activationBindingIdentity;
}

export class DeliveryLifecycleService {
  readonly #options: DeliveryLifecycleOptions;
  readonly #ownerFacts: OwnerFactIngress;
  constructor(options: DeliveryLifecycleOptions) {
    this.#options = options;
    this.#ownerFacts = Object.freeze({ emit: (fact: OwnerFact) => safeEmit(options.ownerFacts, fact) });
  }

  async activate(ready: ExecutionPrebindingReady): Promise<ExecutionResult> {
    let resolved: WorkflowPackageResolutionResult;
    try { resolved = await this.#options.resolver.resolve(ready.command.selector, ready.command.refresh); }
    catch { resolved = Object.freeze({ ok: false, error: Object.freeze({ code: "WORKFLOW_FETCH_FAILED" }) }); }
    if (!resolved.ok) {
      await ready.holder.release();
      return failure(resolved.error.code);
    }

    const deliveryId = this.#options.ids.create();
    const taskId = ready.command.taskSelection.mode === "REUSE_TASK"
      ? ready.command.taskSelection.taskId
      : `task-${deliveryId}`;
    const taskDisplayName = ready.command.taskSelection.mode === "NEW_TASK"
      ? ready.command.taskSelection.displayName
      : undefined;
    let snapshot;
    try {
      snapshot = await captureTaskPromptSnapshot({
        root: this.#options.snapshotRoot,
        deliveryId,
        prompt: ready.command.prompt,
        attachments: this.#options.attachments,
      });
      ready.holder.ownPreDeliveryResource(Object.freeze({ cleanup: () => discardTaskPromptSnapshot(snapshot!) }));
    } catch {
      await ready.holder.release();
      return failure("DELIVERY_BINDING_FAILED");
    }

    let manifest: DeliveryManifest;
    try {
      manifest = createDeliveryManifest({
        deliveryId,
        taskId,
        ...(taskDisplayName === undefined ? {} : { taskDisplayName }),
        createdAt: this.#options.clock.now(),
        canonicalWorktree: ready.command.canonicalWorktree,
        resolvedPackage: resolved.value,
        promptSnapshot: snapshot,
        deliveryConfigProjection: projectionFrom(ready),
      });
    } catch {
      await ready.holder.release();
      return failure("DELIVERY_BINDING_FAILED");
    }

    let persisted;
    try {
      persisted = await this.#options.manifests.persist(manifest);
      await ready.holder.persistBinding({
        deliveryId,
        manifestPath: persisted.path,
        deliveryBindingIdentity: manifest.deliveryBindingIdentity,
        updatedAt: this.#options.clock.now(),
      });
      await ready.holder.release();
      safeEmit(this.#ownerFacts, {
        owner: "M01",
        name: "delivery-bound",
        occurredAt: this.#options.clock.now(),
        deliveryId: manifest.deliveryId,
        taskId: manifest.taskId,
        ...(manifest.taskDisplayName === undefined
          ? {}
          : { taskDisplayName: manifest.taskDisplayName }),
        deliveryBindingIdentity: manifest.deliveryBindingIdentity,
        workflowIdentity: manifest.resolvedPackage.workflowId,
      });
    } catch {
      if (persisted !== undefined) await this.#options.manifests.discard(persisted.path).catch(() => undefined);
      await ready.holder.release().catch(() => undefined);
      return failure("DELIVERY_CREATE_FAILED");
    }
    return this.#start(manifest, "BOUND");
  }

  async recover(slot: OccupiedCurrentSlot): Promise<ExecutionResult> {
    let manifest: DeliveryManifest;
    try {
      manifest = await this.#options.manifests.load(slot.manifestPath);
      if (manifest.deliveryId !== slot.deliveryId || manifest.canonicalWorktree !== slot.worktree
        || manifest.deliveryBindingIdentity !== slot.deliveryBindingIdentity) return failure("DELIVERY_BINDING_FAILED");
    } catch {
      return failure("DELIVERY_BINDING_FAILED");
    }
    safeEmit(this.#ownerFacts, {
      owner: "M01",
      name: "delivery-bound",
      occurredAt: this.#options.clock.now(),
      deliveryId: manifest.deliveryId,
      taskId: manifest.taskId,
      ...(manifest.taskDisplayName === undefined
        ? {}
        : { taskDisplayName: manifest.taskDisplayName }),
      deliveryBindingIdentity: manifest.deliveryBindingIdentity,
      workflowIdentity: manifest.resolvedPackage.workflowId,
    });
    if (slot.state === "START_FAILED") {
      await this.#options.slots.transition(slot.worktree, "M01_START_FAILURE_HANDLED", this.#options.clock.now());
      return failure("RUNNER_START_FAILED");
    }
    if (slot.state === "TERMINAL_HANDLING") {
      return Object.freeze({ kind: "RECOVERY", worktree: slot.worktree, deliveryId: slot.deliveryId, state: slot.state });
    }
    return this.#start(manifest, slot.state);
  }

  async abandon(worktree: string, deliveryId: string): Promise<ExecutionResult> {
    try {
      const current = await this.#options.slots.read(worktree);
      if (current.state === "EMPTY" || current.deliveryId !== deliveryId) return failure("DELIVERY_UNKNOWN");
      await this.#options.slots.transition(worktree, "ADMINISTRATIVE_CLOSE", this.#options.clock.now(), { authorization: deliveryId });
      this.#ownerFacts.emit({ owner: "M01", name: "authorized-abandonment", occurredAt: this.#options.clock.now() });
      return Object.freeze({ kind: "TERMINAL", worktree, deliveryId, outcome: "CANCELLED", summary: "AUTHORIZED_ABANDONMENT" });
    } catch {
      return failure("DELIVERY_UNKNOWN");
    }
  }

  async #start(manifest: DeliveryManifest, initialState: OccupiedCurrentSlot["state"]): Promise<ExecutionResult> {
    let activation: RunnerActivationContext;
    try { activation = await this.#options.projector.project(manifest); }
    catch { return failure("DELIVERY_BINDING_FAILED"); }
    if (!Object.isFrozen(activation) || activation.correlation.manifestBindingIdentity !== manifest.deliveryBindingIdentity
      || activation.correlation.deliveryIdentity !== manifest.deliveryId
      || activation.correlation.packageDigest !== manifest.resolvedPackage.packageDigest) return failure("DELIVERY_BINDING_FAILED");
    let state = initialState;
    const ownerFacts = this.#options.runtime.ownerFacts?.(manifest, activation) ?? this.#ownerFacts;
    const startCorrelation: RunnerStartCorrelationPort = Object.freeze({
      acknowledge: async (fact: RunnerStartCorrelationFact) => {
        if (!exactStartCorrelationFact(fact, activation)) return Object.freeze({ ok: false as const, error: Object.freeze({ code: "CORRELATION_MISMATCH" as const }) });
        const current = await this.#options.slots.read(manifest.canonicalWorktree);
        if (current.state === "EMPTY" || current.deliveryId !== manifest.deliveryId
          || current.deliveryBindingIdentity !== manifest.deliveryBindingIdentity) {
          return Object.freeze({ ok: false as const, error: Object.freeze({ code: "CORRELATION_MISMATCH" as const }) });
        }
        if (current.state === "START_UNCERTAIN") {
          await this.#options.slots.transition(manifest.canonicalWorktree, "M02_START_CORRELATED", this.#options.clock.now());
          safeEmit(ownerFacts, { owner: "M02", name: "start-correlated", occurredAt: this.#options.clock.now() });
        } else if (current.state !== "RUNNING_CORRELATED") {
          return Object.freeze({ ok: false as const, error: Object.freeze({ code: "CORRELATION_MISMATCH" as const }) });
        }
        state = "RUNNING_CORRELATED";
        return Object.freeze({ ok: true as const, value: undefined });
      },
    });
    if (state === "BOUND") {
      ownerFacts.emit({ owner: "M01", name: "runner-launch-requested", occurredAt: this.#options.clock.now() });
      await this.#options.slots.transition(manifest.canonicalWorktree, "M01_RUNNER_LAUNCH_REQUESTED", this.#options.clock.now());
      state = "START_UNCERTAIN";
    }
    let runtime: ExecutionRuntimeAdapter;
    try { runtime = await this.#options.runtime.create({ manifest, activation, ownerFacts, startCorrelation }); }
    catch { return Object.freeze({ kind: "UNKNOWN", worktree: manifest.canonicalWorktree, deliveryId: manifest.deliveryId, state: "START_UNCERTAIN" }); }
    const called = await runtime.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation }).catch(() => undefined);
    if (called === undefined || !called.ok) {
      if (state === "RUNNING_CORRELATED") {
        return Object.freeze({ kind: "RECOVERY", worktree: manifest.canonicalWorktree, deliveryId: manifest.deliveryId, state });
      }
      return Object.freeze({ kind: "UNKNOWN", worktree: manifest.canonicalWorktree, deliveryId: manifest.deliveryId, state: state === "RESULT_UNRESOLVED" ? "RESULT_UNRESOLVED" : "START_UNCERTAIN" });
    }
    return this.#handleRuntimeResult(manifest, activation, state, called.value, ownerFacts);
  }

  async #handleRuntimeResult(
    manifest: DeliveryManifest,
    activation: RunnerActivationContext,
    state: OccupiedCurrentSlot["state"],
    result: ExecutionRuntimeResult,
    ownerFacts: OwnerFactIngress,
  ): Promise<ExecutionResult> {
    if (!runtimeResultShape(result)) {
      if (resultCarriesExactDelivery(result, activation)) {
        if (state === "START_UNCERTAIN") {
          ownerFacts.emit({ owner: "M02", name: "start-correlated", occurredAt: this.#options.clock.now() });
          await this.#options.slots.transition(manifest.canonicalWorktree, "M02_START_CORRELATED", this.#options.clock.now());
          state = "RUNNING_CORRELATED";
        }
        if (state === "RUNNING_CORRELATED") {
          ownerFacts.emit({ owner: "M02", name: "result-unresolved", occurredAt: this.#options.clock.now() });
          await this.#options.slots.transition(manifest.canonicalWorktree, "M02_RESULT_UNRESOLVED", this.#options.clock.now());
        }
      }
      return failure("RUNNER_RESULT_INVALID");
    }
    if (result.kind === "start-failed") {
      if (state !== "START_UNCERTAIN") return failure("RUNNER_RESULT_INVALID");
      ownerFacts.emit({ owner: "M02", name: "start-failed", occurredAt: this.#options.clock.now(), outcome: "START_FAILED" });
      await this.#options.slots.transition(manifest.canonicalWorktree, "M02_START_FAILED", this.#options.clock.now());
      ownerFacts.emit({ owner: "M01", name: "start-failure-handled", occurredAt: this.#options.clock.now() });
      await this.#options.slots.transition(manifest.canonicalWorktree, "M01_START_FAILURE_HANDLED", this.#options.clock.now());
      return failure("RUNNER_START_FAILED");
    }
    if (result.kind === "unknown") {
      if (!correlated(result, activation)) return failure("RUNNER_RESULT_INVALID");
      if (state === "START_UNCERTAIN") {
        ownerFacts.emit({ owner: "M02", name: "start-correlated", occurredAt: this.#options.clock.now() });
        await this.#options.slots.transition(manifest.canonicalWorktree, "M02_START_CORRELATED", this.#options.clock.now());
        state = "RUNNING_CORRELATED";
      }
      if (state === "RUNNING_CORRELATED") {
        ownerFacts.emit({ owner: "M02", name: "result-unresolved", occurredAt: this.#options.clock.now() });
        await this.#options.slots.transition(manifest.canonicalWorktree, "M02_RESULT_UNRESOLVED", this.#options.clock.now());
      }
      return Object.freeze({ kind: "UNKNOWN", worktree: manifest.canonicalWorktree, deliveryId: manifest.deliveryId, state: "RESULT_UNRESOLVED" });
    }
    if (!terminalCorrelated(result, activation)) return failure("RUNNER_RESULT_INVALID");
    if (state === "START_UNCERTAIN") {
      ownerFacts.emit({ owner: "M02", name: "start-correlated", occurredAt: this.#options.clock.now() });
      await this.#options.slots.transition(manifest.canonicalWorktree, "M02_START_CORRELATED", this.#options.clock.now());
      state = "RUNNING_CORRELATED";
    }
    ownerFacts.emit({ owner: "M02", name: "terminal-validated", occurredAt: this.#options.clock.now(), outcome: result.outcome });
    await this.#options.slots.transition(manifest.canonicalWorktree,
      state === "RESULT_UNRESOLVED" ? "M02_RECONCILED_TERMINAL" : "M02_TERMINAL_VALIDATED", this.#options.clock.now());
    ownerFacts.emit({ owner: "M01", name: "terminal-handling-complete", occurredAt: this.#options.clock.now() });
    await this.#options.slots.transition(manifest.canonicalWorktree, "M01_TERMINAL_HANDLING_COMPLETE", this.#options.clock.now());
    const outcome = result.outcome === "COMPLETED" ? "SUCCEEDED" : result.outcome === "CANCELLED" ? "CANCELLED" : "FAILED";
    return Object.freeze({ kind: "TERMINAL", worktree: manifest.canonicalWorktree, deliveryId: manifest.deliveryId, outcome });
  }
}

export type { DeliveryAdmissionHolder };
