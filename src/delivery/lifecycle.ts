import type { ExecutionFailure, ExecutionResult } from "../application/execution-application.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentContentPort, ClockPort, DisabledObservationSink, IdPort, OwnerFact, OwnerFactIngress } from "../bootstrap/contracts.js";
import { deepFreeze, type DeliveryConfigProjection, type DeliveryConfigProjectionV2 } from "../configuration/index.js";
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
import { createDeliveryManifestV2, type DeliveryManifestRepositoryV2, type DeliveryManifestV2 } from "./manifest-v2.js";
import { loadRepositoryModelBindings } from "./repository-model-bindings.js";
import { resolveRoleModelBindings, type AgentProviderAdmissionRegistry } from "./resolved-role-model-bindings.js";
import { extractWorkflowV2RoleSnapshot } from "./workflow-v2-role-snapshot.js";
import type { WorkflowPackageResolver, WorkflowPackageResolutionResult } from "./workflow-package-resolver.js";

export type ProductionDeliveryManifest = DeliveryManifest | DeliveryManifestV2;

export interface DeliveryActivationProjector {
  project(manifest: ProductionDeliveryManifest): Promise<RunnerActivationContext>;
}

export interface DeliveryRuntimeFactoryInput {
  readonly manifest: ProductionDeliveryManifest;
  readonly activation: RunnerActivationContext;
  readonly ownerFacts: OwnerFactIngress;
  readonly startCorrelation: RunnerStartCorrelationPort;
}

export interface DeliveryRuntimeFactory {
  ownerFacts?(manifest: ProductionDeliveryManifest, activation: RunnerActivationContext): OwnerFactIngress;
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
  readonly invalidations?: Readonly<{ publish(): void }>;
  readonly completed?: Readonly<{
    publish(manifest: ProductionDeliveryManifest, terminal: Readonly<{ outcome: "SUCCEEDED" | "FAILED" | "CANCELLED"; finishedAt: number }>, error: Readonly<{ code: string }> | null): Promise<void>;
  }>;
}

export interface DeliveryLifecycleOptionsV2 extends Omit<DeliveryLifecycleOptions, "manifests"> {
  readonly manifestVersion: "2.0.0";
  readonly manifests: DeliveryManifestRepositoryV2;
  readonly agentProviders: AgentProviderAdmissionRegistry;
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

function projectionFromV2(ready: ExecutionPrebindingReady): DeliveryConfigProjectionV2 {
  return deepFreeze({ value: ready.command.deliveryConfigProjection, identity: ready.command.deliveryConfigProjectionIdentity }) as DeliveryConfigProjectionV2;
}

function packageBinding(manifest: ProductionDeliveryManifest): Readonly<{ name: string; exactVersion: string; packageDigest: string; localPath: string; workflowId: string }> {
  return manifest.schemaVersion === "execution.delivery-manifest@2.0.0"
    ? { name: manifest.workflowPackage.name, exactVersion: manifest.workflowPackage.exactVersion, packageDigest: manifest.workflowPackage.packageDigest, localPath: manifest.workflowPackage.localMaterializationPath, workflowId: manifest.workflowSnapshot.workflowId }
    : manifest.resolvedPackage;
}

async function workflowV2Snapshot(localPath: string) {
  const material = await realpath(localPath);
  const definition = await stat(join(material, "package.json")).then((value) => value.isFile() ? material : join(material, "definition")).catch(() => join(material, "definition"));
  const json = async (name: string) => JSON.parse(await readFile(join(definition, name), "utf8")) as unknown;
  const pkg = await json("package.json") as Record<string, any>;
  return extractWorkflowV2RoleSnapshot({
    packageDocument: pkg,
    snapshotDocument: await json("snapshot.json"),
    actionsDocument: await json(String(pkg.documents.actions)),
    rolesDocument: await json(String(pkg.documents.roles)),
    routesDocument: await json(String(pkg.documents.routes)),
  });
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
  readonly #options: DeliveryLifecycleOptions | DeliveryLifecycleOptionsV2;
  readonly #ownerFacts: OwnerFactIngress;
  constructor(options: DeliveryLifecycleOptions | DeliveryLifecycleOptionsV2) {
    this.#options = options;
    this.#ownerFacts = Object.freeze({ emit: (fact: OwnerFact) => safeEmit(options.ownerFacts, fact) });
  }

  #publishChange(): void {
    try { this.#options.invalidations?.publish(); } catch { /* Read models are non-controlling. */ }
  }

  async #publishCompleted(manifest: ProductionDeliveryManifest, outcome: "SUCCEEDED" | "FAILED" | "CANCELLED", finishedAt: number, error: Readonly<{ code: string }> | null): Promise<void> {
    await this.#options.completed?.publish(manifest, Object.freeze({ outcome, finishedAt }), error).catch(() => undefined);
    this.#publishChange();
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

    let manifest: ProductionDeliveryManifest;
    try {
      if ("manifestVersion" in this.#options) {
        const extracted = await workflowV2Snapshot(resolved.value.localPath);
        const repositoryModelBindings = await loadRepositoryModelBindings(ready.command.canonicalWorktree);
        const resolvedRoleBindings = resolveRoleModelBindings({ registry: this.#options.agentProviders, repository: repositoryModelBindings, agentActionRoles: extracted.agentActionRoles });
        manifest = createDeliveryManifestV2({
          deliveryId, taskId, ...(taskDisplayName === undefined ? {} : { taskDisplayName }), createdAt: this.#options.clock.now(),
          canonicalWorktree: ready.command.canonicalWorktree,
          workflowPackage: { name: resolved.value.name, exactVersion: resolved.value.exactVersion, packageDigest: resolved.value.packageDigest, localMaterializationPath: resolved.value.localPath },
          workflowSnapshot: extracted.workflowSnapshot,
          agentActionRoles: extracted.agentActionRoles,
          repositoryModelBindings,
          resolvedRoleBindings,
          promptSnapshot: snapshot,
          deliveryConfigProjection: projectionFromV2(ready),
        });
      } else {
        manifest = createDeliveryManifest({
          deliveryId, taskId, ...(taskDisplayName === undefined ? {} : { taskDisplayName }), createdAt: this.#options.clock.now(),
          canonicalWorktree: ready.command.canonicalWorktree, resolvedPackage: resolved.value, promptSnapshot: snapshot,
          deliveryConfigProjection: projectionFrom(ready),
        });
      }
    } catch {
      await ready.holder.release();
      return failure("DELIVERY_BINDING_FAILED");
    }

    let persisted;
    try {
      const manifests = this.#options.manifests as unknown as Readonly<{
        persist(value: ProductionDeliveryManifest): Promise<Readonly<{ path: string }>>;
        discard(path: string): Promise<void>;
      }>;
      persisted = await manifests.persist(manifest);
      await ready.holder.persistBinding({
        deliveryId,
        manifestPath: persisted.path,
        deliveryBindingIdentity: manifest.deliveryBindingIdentity,
        updatedAt: this.#options.clock.now(),
      });
      this.#publishChange();
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
        workflowIdentity: packageBinding(manifest).workflowId,
      });
    } catch {
      if (persisted !== undefined) await (this.#options.manifests as unknown as Readonly<{ discard(path: string): Promise<void> }>).discard(persisted.path).catch(() => undefined);
      await ready.holder.release().catch(() => undefined);
      return failure("DELIVERY_CREATE_FAILED");
    }
    return this.#start(manifest, "BOUND");
  }

  async recover(slot: OccupiedCurrentSlot): Promise<ExecutionResult> {
    let manifest: ProductionDeliveryManifest;
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
      workflowIdentity: packageBinding(manifest).workflowId,
    });
    if (slot.state === "START_FAILED") {
      const finishedAt = this.#options.clock.now();
      await this.#options.slots.transition(slot.worktree, "M01_START_FAILURE_HANDLED", finishedAt);
      this.#publishChange();
      await this.#publishCompleted(manifest, "FAILED", finishedAt, Object.freeze({ code: "RUNNER_START_FAILED" }));
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
      const manifest = await this.#options.manifests.load(current.manifestPath);
      if (manifest.deliveryBindingIdentity !== current.deliveryBindingIdentity) return failure("DELIVERY_UNKNOWN");
      const finishedAt = this.#options.clock.now();
      await this.#options.slots.transition(worktree, "ADMINISTRATIVE_CLOSE", finishedAt, { authorization: deliveryId });
      this.#publishChange();
      await this.#publishCompleted(manifest, "CANCELLED", finishedAt, null);
      this.#ownerFacts.emit({ owner: "M01", name: "authorized-abandonment", occurredAt: this.#options.clock.now() });
      return Object.freeze({ kind: "TERMINAL", worktree, deliveryId, outcome: "CANCELLED", summary: "AUTHORIZED_ABANDONMENT" });
    } catch {
      return failure("DELIVERY_UNKNOWN");
    }
  }

  async #start(manifest: ProductionDeliveryManifest, initialState: OccupiedCurrentSlot["state"]): Promise<ExecutionResult> {
    let activation: RunnerActivationContext;
    try { activation = await this.#options.projector.project(manifest); }
    catch { return failure("DELIVERY_BINDING_FAILED"); }
    if (!Object.isFrozen(activation) || activation.correlation.manifestBindingIdentity !== manifest.deliveryBindingIdentity
      || activation.correlation.deliveryIdentity !== manifest.deliveryId
      || activation.correlation.packageDigest !== packageBinding(manifest).packageDigest) return failure("DELIVERY_BINDING_FAILED");
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
          this.#publishChange();
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
      this.#publishChange();
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
    manifest: ProductionDeliveryManifest,
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
          this.#publishChange();
          state = "RUNNING_CORRELATED";
        }
        if (state === "RUNNING_CORRELATED") {
          ownerFacts.emit({ owner: "M02", name: "result-unresolved", occurredAt: this.#options.clock.now() });
          await this.#options.slots.transition(manifest.canonicalWorktree, "M02_RESULT_UNRESOLVED", this.#options.clock.now());
          this.#publishChange();
        }
      }
      return failure("RUNNER_RESULT_INVALID");
    }
    if (result.kind === "start-failed") {
      if (state !== "START_UNCERTAIN") return failure("RUNNER_RESULT_INVALID");
      ownerFacts.emit({ owner: "M02", name: "start-failed", occurredAt: this.#options.clock.now(), outcome: "START_FAILED" });
      await this.#options.slots.transition(manifest.canonicalWorktree, "M02_START_FAILED", this.#options.clock.now());
      this.#publishChange();
      ownerFacts.emit({ owner: "M01", name: "start-failure-handled", occurredAt: this.#options.clock.now() });
      const finishedAt = this.#options.clock.now();
      await this.#options.slots.transition(manifest.canonicalWorktree, "M01_START_FAILURE_HANDLED", finishedAt);
      this.#publishChange();
      await this.#publishCompleted(manifest, "FAILED", finishedAt, Object.freeze({ code: "RUNNER_START_FAILED" }));
      return failure("RUNNER_START_FAILED");
    }
    if (result.kind === "unknown") {
      if (!correlated(result, activation)) return failure("RUNNER_RESULT_INVALID");
      if (state === "START_UNCERTAIN") {
        ownerFacts.emit({ owner: "M02", name: "start-correlated", occurredAt: this.#options.clock.now() });
        await this.#options.slots.transition(manifest.canonicalWorktree, "M02_START_CORRELATED", this.#options.clock.now());
        this.#publishChange();
        state = "RUNNING_CORRELATED";
      }
      if (state === "RUNNING_CORRELATED") {
        ownerFacts.emit({ owner: "M02", name: "result-unresolved", occurredAt: this.#options.clock.now() });
        await this.#options.slots.transition(manifest.canonicalWorktree, "M02_RESULT_UNRESOLVED", this.#options.clock.now());
        this.#publishChange();
      }
      return Object.freeze({ kind: "UNKNOWN", worktree: manifest.canonicalWorktree, deliveryId: manifest.deliveryId, state: "RESULT_UNRESOLVED" });
    }
    if (!terminalCorrelated(result, activation)) return failure("RUNNER_RESULT_INVALID");
    if (state === "START_UNCERTAIN") {
      ownerFacts.emit({ owner: "M02", name: "start-correlated", occurredAt: this.#options.clock.now() });
      await this.#options.slots.transition(manifest.canonicalWorktree, "M02_START_CORRELATED", this.#options.clock.now());
      this.#publishChange();
      state = "RUNNING_CORRELATED";
    }
    ownerFacts.emit({ owner: "M02", name: "terminal-validated", occurredAt: this.#options.clock.now(), outcome: result.outcome });
    await this.#options.slots.transition(manifest.canonicalWorktree,
      state === "RESULT_UNRESOLVED" ? "M02_RECONCILED_TERMINAL" : "M02_TERMINAL_VALIDATED", this.#options.clock.now());
    this.#publishChange();
    ownerFacts.emit({ owner: "M01", name: "terminal-handling-complete", occurredAt: this.#options.clock.now() });
    const finishedAt = this.#options.clock.now();
    await this.#options.slots.transition(manifest.canonicalWorktree, "M01_TERMINAL_HANDLING_COMPLETE", finishedAt);
    this.#publishChange();
    const outcome = result.outcome === "COMPLETED" ? "SUCCEEDED" : result.outcome === "CANCELLED" ? "CANCELLED" : "FAILED";
    await this.#publishCompleted(manifest, outcome, finishedAt, outcome === "FAILED" ? Object.freeze({ code: result.outcome }) : null);
    return Object.freeze({ kind: "TERMINAL", worktree: manifest.canonicalWorktree, deliveryId: manifest.deliveryId, outcome });
  }
}

export type { DeliveryAdmissionHolder };
