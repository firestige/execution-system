import type { OccupiedCurrentSlot } from "./current-slot.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type DeliveryProjectionErrorCode =
  | "DELIVERY_PROJECTION_CORRUPT"
  | "DELIVERY_PROJECTION_STALE_BINDING"
  | "DELIVERY_PROJECTION_RECOVERY_MISMATCH"
  | "DELIVERY_PROJECTION_UNAVAILABLE";

export class DeliveryProjectionError extends Error {
  constructor(readonly code: DeliveryProjectionErrorCode, readonly deliveryId?: string) {
    super(code);
    this.name = "DeliveryProjectionError";
  }
}

export interface DeliveryProjectionManifest {
  readonly deliveryId: string;
  readonly taskId: string;
  readonly taskDisplayName?: string;
  readonly createdAt: number;
  readonly canonicalWorktree: string;
  readonly deliveryBindingIdentity: string;
  readonly workflow: Readonly<{
    identity: string;
    packageName: string;
    exactPackageVersion: string;
    packageDigest: string;
    snapshotIdentity: string;
    snapshotDigest: string;
  }>;
}

export interface DeliveryProjectionBinding {
  readonly deliveryId: string;
  readonly deliveryBindingIdentity: string;
  readonly sessionCorrelation?: string;
}

export type DeliveryProjectionCurrent =
  | Readonly<{ kind: "ACTION"; identity: string }>
  | Readonly<{ kind: "INTERVENTION"; identity: string }>
  | null;

export interface DeliveryProjectionRuntime {
  readonly deliveryId: string;
  readonly deliveryBindingIdentity: string;
  readonly current: DeliveryProjectionCurrent;
  readonly terminal: Readonly<{
    outcome: "SUCCEEDED" | "FAILED" | "CANCELLED";
    finishedAt: number;
  }> | null;
  readonly error: Readonly<{ code: string }> | null;
}

export interface DeliveryProjectionCompleted {
  readonly schemaVersion: "execution.delivery-completed@1.0.0";
  readonly manifest: DeliveryProjectionManifest;
  readonly updatedAt: number;
  readonly terminal: NonNullable<DeliveryProjectionRuntime["terminal"]>;
  readonly error: DeliveryProjectionRuntime["error"];
  readonly sessionCorrelation?: string;
}

export interface DeliveryControlPlaneItem {
  readonly deliveryId: string;
  readonly deliveryBindingIdentity: string;
  readonly task: Readonly<{ identity: string; displayName: string | null }>;
  readonly worktree: string;
  readonly workflow: DeliveryProjectionManifest["workflow"];
  readonly lifecycle: OccupiedCurrentSlot["state"] | "TERMINAL";
  readonly detached: boolean;
  readonly recoverable: boolean;
  readonly navigation: Readonly<{ sessionCorrelation: string }> | null;
  readonly current: DeliveryProjectionCurrent;
  readonly timing: Readonly<{ startedAt: number; updatedAt: number; elapsedMs: number }>;
  readonly terminal: DeliveryProjectionRuntime["terminal"];
  readonly error: DeliveryProjectionRuntime["error"];
}

export interface DeliveryControlPlaneSnapshot {
  readonly schemaVersion: "execution.delivery-control-plane@1.0.0";
  readonly generation: number;
  readonly deliveries: readonly DeliveryControlPlaneItem[];
}

export type SessionDeliveryView =
  | Readonly<{ kind: "UNBOUND"; sessionCorrelation: string }>
  | Readonly<{ kind: "BOUND"; sessionCorrelation: string; delivery: DeliveryControlPlaneItem }>;

export interface DeliveryControlPlaneProjectionOptions {
  readonly slots: Pick<import("./current-slot.js").CurrentSlotRepository, "enumerate">;
  readonly manifests: Readonly<{ loadProjection(path: string): Promise<DeliveryProjectionManifest> }>;
  readonly bindings: Readonly<{ enumerateBindings(): readonly DeliveryProjectionBinding[] }>;
  readonly runtime: Readonly<{ enumerateRuntime(): readonly DeliveryProjectionRuntime[] }>;
  readonly completed?: Readonly<{ enumerateCompleted(): Promise<readonly DeliveryProjectionCompleted[]> }>;
  readonly invalidations: Readonly<{ subscribe(listener: () => void): () => void }>;
  readonly now: () => number;
}

export interface DeliveryControlPlaneReadModel {
  snapshot(): Promise<DeliveryControlPlaneSnapshot>;
  session(sessionCorrelation: string): Promise<SessionDeliveryView>;
  subscribe(listener: (snapshot: DeliveryControlPlaneSnapshot) => void, onError?: (error: DeliveryProjectionError) => void): Promise<() => void>;
}

function freeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const identity = key(item);
    if (identity.length === 0 || result.has(identity)) throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT");
    result.set(identity, item);
  }
  return result;
}

function validManifest(value: DeliveryProjectionManifest): boolean {
  return value !== null && typeof value === "object"
    && ["canonicalWorktree,createdAt,deliveryBindingIdentity,deliveryId,taskId,workflow", "canonicalWorktree,createdAt,deliveryBindingIdentity,deliveryId,taskDisplayName,taskId,workflow"].includes(Object.keys(value).sort().join(","))
    && Object.keys(value.workflow ?? {}).sort().join(",") === "exactPackageVersion,identity,packageDigest,packageName,snapshotDigest,snapshotIdentity"
    && typeof value.deliveryId === "string" && value.deliveryId.length > 0
    && typeof value.taskId === "string" && value.taskId.length > 0
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && typeof value.canonicalWorktree === "string" && value.canonicalWorktree.startsWith("/")
    && SHA256.test(value.deliveryBindingIdentity)
    && typeof value.workflow?.identity === "string" && value.workflow.identity.length > 0
    && typeof value.workflow.packageName === "string" && value.workflow.packageName.length > 0
    && typeof value.workflow.exactPackageVersion === "string" && value.workflow.exactPackageVersion.length > 0
    && SHA256.test(value.workflow.packageDigest)
    && typeof value.workflow.snapshotIdentity === "string" && value.workflow.snapshotIdentity.length > 0
    && SHA256.test(value.workflow.snapshotDigest);
}

export class DeliveryControlPlaneProjection implements DeliveryControlPlaneReadModel {
  readonly #options: DeliveryControlPlaneProjectionOptions;
  readonly #listeners = new Set<(snapshot: DeliveryControlPlaneSnapshot) => void>();
  readonly #errorListeners = new Set<(error: DeliveryProjectionError) => void>();
  #generation = 0;
  #refresh: Promise<void> = Promise.resolve();

  constructor(options: DeliveryControlPlaneProjectionOptions) {
    this.#options = options;
    options.invalidations.subscribe(() => {
      this.#refresh = this.#refresh.then(async () => {
        if (this.#listeners.size === 0) return;
        const snapshot = await this.snapshot();
        for (const listener of [...this.#listeners]) listener(snapshot);
      }).catch((cause: unknown) => {
        const error = cause instanceof DeliveryProjectionError ? cause : new DeliveryProjectionError("DELIVERY_PROJECTION_UNAVAILABLE");
        for (const listener of [...this.#errorListeners]) listener(error);
      });
    });
  }

  async snapshot(): Promise<DeliveryControlPlaneSnapshot> {
    let slots: readonly OccupiedCurrentSlot[];
    let bindings: readonly DeliveryProjectionBinding[];
    let runtimes: readonly DeliveryProjectionRuntime[];
    let completed: readonly DeliveryProjectionCompleted[];
    try {
      [slots, bindings, runtimes, completed] = await Promise.all([
        this.#options.slots.enumerate(),
        Promise.resolve(this.#options.bindings.enumerateBindings()),
        Promise.resolve(this.#options.runtime.enumerateRuntime()),
        this.#options.completed?.enumerateCompleted() ?? Promise.resolve([]),
      ]);
    } catch {
      throw new DeliveryProjectionError("DELIVERY_PROJECTION_UNAVAILABLE");
    }
    const slotsByDelivery = uniqueBy(slots, (value) => value.deliveryId);
    if (uniqueBy(slots, (value) => value.worktree).size !== slotsByDelivery.size) {
      throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT");
    }
    const bindingsByDelivery = uniqueBy(bindings, (value) => value.deliveryId);
    const runtimesByDelivery = uniqueBy(runtimes, (value) => value.deliveryId);
    const completedByDelivery = uniqueBy(completed, (value) => value.manifest.deliveryId);
    for (const deliveryId of completedByDelivery.keys()) {
      if (slotsByDelivery.has(deliveryId)) throw new DeliveryProjectionError("DELIVERY_PROJECTION_RECOVERY_MISMATCH", deliveryId);
    }
    const correlations = new Set<string>();
    for (const value of bindings) {
      const expectedKeys = value.sessionCorrelation === undefined ? "deliveryBindingIdentity,deliveryId" : "deliveryBindingIdentity,deliveryId,sessionCorrelation";
      if (Object.keys(value).sort().join(",") !== expectedKeys || !SHA256.test(value.deliveryBindingIdentity)) throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT", value.deliveryId);
      if (value.sessionCorrelation !== undefined) {
        if (value.sessionCorrelation.length === 0 || correlations.has(value.sessionCorrelation)) {
          throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT", value.deliveryId);
        }
        correlations.add(value.sessionCorrelation);
      }
    }
    for (const deliveryId of bindingsByDelivery.keys()) {
      if (!slotsByDelivery.has(deliveryId) && !completedByDelivery.has(deliveryId)) throw new DeliveryProjectionError("DELIVERY_PROJECTION_STALE_BINDING", deliveryId);
    }
    for (const deliveryId of runtimesByDelivery.keys()) {
      if (!slotsByDelivery.has(deliveryId) && !completedByDelivery.has(deliveryId)) throw new DeliveryProjectionError("DELIVERY_PROJECTION_RECOVERY_MISMATCH", deliveryId);
    }

    const now = this.#options.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT");
    const deliveries: DeliveryControlPlaneItem[] = [];
    for (const slot of [...slots].sort((left, right) => left.deliveryId.localeCompare(right.deliveryId))) {
      let manifest: DeliveryProjectionManifest;
      try { manifest = await this.#options.manifests.loadProjection(slot.manifestPath); }
      catch { throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT", slot.deliveryId); }
      if (!validManifest(manifest)
        || manifest.deliveryId !== slot.deliveryId
        || manifest.canonicalWorktree !== slot.worktree
        || manifest.deliveryBindingIdentity !== slot.deliveryBindingIdentity) {
        throw new DeliveryProjectionError("DELIVERY_PROJECTION_STALE_BINDING", slot.deliveryId);
      }
      const binding = bindingsByDelivery.get(slot.deliveryId);
      const runtime = runtimesByDelivery.get(slot.deliveryId);
      if ((binding !== undefined && binding.deliveryBindingIdentity !== slot.deliveryBindingIdentity)
        || (runtime !== undefined && runtime.deliveryBindingIdentity !== slot.deliveryBindingIdentity)) {
        throw new DeliveryProjectionError("DELIVERY_PROJECTION_STALE_BINDING", slot.deliveryId);
      }
      if (runtime?.terminal !== null && runtime?.terminal !== undefined) {
        throw new DeliveryProjectionError("DELIVERY_PROJECTION_RECOVERY_MISMATCH", slot.deliveryId);
      }
      if (runtime !== undefined && (runtime.current !== null
        && (!new Set(["ACTION", "INTERVENTION"]).has(runtime.current.kind) || runtime.current.identity.length === 0))) {
        throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT", slot.deliveryId);
      }
      const navigation = binding?.sessionCorrelation === undefined ? null : { sessionCorrelation: binding.sessionCorrelation };
      deliveries.push(freeze({
        deliveryId: slot.deliveryId,
        deliveryBindingIdentity: slot.deliveryBindingIdentity,
        task: { identity: manifest.taskId, displayName: manifest.taskDisplayName ?? null },
        worktree: slot.worktree,
        workflow: manifest.workflow,
        lifecycle: slot.state,
        detached: navigation === null,
        recoverable: true,
        navigation,
        current: runtime?.current ?? null,
        timing: { startedAt: manifest.createdAt, updatedAt: slot.updatedAt, elapsedMs: Math.max(0, now - manifest.createdAt) },
        terminal: null,
        error: runtime?.error ?? null,
      }));
    }
    for (const completedFact of completed) {
      const manifest = completedFact.manifest;
      const errorKeys = completedFact.error === null ? true : Object.keys(completedFact.error).sort().join(",") === "code";
      const completedKeys = completedFact.sessionCorrelation === undefined
        ? "error,manifest,schemaVersion,terminal,updatedAt"
        : "error,manifest,schemaVersion,sessionCorrelation,terminal,updatedAt";
      if (completedFact.schemaVersion !== "execution.delivery-completed@1.0.0"
        || Object.keys(completedFact).sort().join(",") !== completedKeys
        || Object.keys(completedFact.terminal).sort().join(",") !== "finishedAt,outcome" || !errorKeys
        || (completedFact.sessionCorrelation !== undefined && completedFact.sessionCorrelation.length === 0)
        || !validManifest(manifest) || !Number.isSafeInteger(completedFact.updatedAt) || completedFact.updatedAt < manifest.createdAt
        || !Number.isSafeInteger(completedFact.terminal.finishedAt) || completedFact.terminal.finishedAt !== completedFact.updatedAt
        || !new Set(["SUCCEEDED", "FAILED", "CANCELLED"]).has(completedFact.terminal.outcome)) {
        throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT", manifest.deliveryId);
      }
      const binding = bindingsByDelivery.get(manifest.deliveryId);
      const runtime = runtimesByDelivery.get(manifest.deliveryId);
      if ((binding !== undefined && binding.deliveryBindingIdentity !== manifest.deliveryBindingIdentity)
        || (runtime !== undefined && runtime.deliveryBindingIdentity !== manifest.deliveryBindingIdentity)
        || runtime?.current !== null && runtime?.current !== undefined) {
        throw new DeliveryProjectionError("DELIVERY_PROJECTION_STALE_BINDING", manifest.deliveryId);
      }
      const sessionCorrelation = binding?.sessionCorrelation ?? completedFact.sessionCorrelation;
      if (sessionCorrelation !== undefined) {
        if (correlations.has(sessionCorrelation) && binding?.sessionCorrelation !== sessionCorrelation) {
          throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT", manifest.deliveryId);
        }
        correlations.add(sessionCorrelation);
      }
      const navigation = sessionCorrelation === undefined ? null : { sessionCorrelation };
      deliveries.push(freeze({
        deliveryId: manifest.deliveryId,
        deliveryBindingIdentity: manifest.deliveryBindingIdentity,
        task: { identity: manifest.taskId, displayName: manifest.taskDisplayName ?? null },
        worktree: manifest.canonicalWorktree,
        workflow: manifest.workflow,
        lifecycle: "TERMINAL" as const,
        detached: navigation === null,
        recoverable: false,
        navigation,
        current: null,
        timing: { startedAt: manifest.createdAt, updatedAt: completedFact.updatedAt, elapsedMs: completedFact.updatedAt - manifest.createdAt },
        terminal: completedFact.terminal,
        error: completedFact.error,
      }));
    }
    deliveries.sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
    return freeze({
      schemaVersion: "execution.delivery-control-plane@1.0.0" as const,
      generation: ++this.#generation,
      deliveries,
    });
  }

  async session(sessionCorrelation: string): Promise<SessionDeliveryView> {
    if (sessionCorrelation.length === 0) throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT");
    const snapshot = await this.snapshot();
    const matches = snapshot.deliveries.filter((delivery) => delivery.navigation?.sessionCorrelation === sessionCorrelation);
    if (matches.length > 1) throw new DeliveryProjectionError("DELIVERY_PROJECTION_CORRUPT");
    return matches.length === 0
      ? freeze({ kind: "UNBOUND" as const, sessionCorrelation })
      : freeze({ kind: "BOUND" as const, sessionCorrelation, delivery: matches[0]! });
  }

  async subscribe(listener: (snapshot: DeliveryControlPlaneSnapshot) => void, onError?: (error: DeliveryProjectionError) => void): Promise<() => void> {
    if (typeof listener !== "function") throw new TypeError("Delivery projection listener must be callable");
    let ready = false;
    const buffered: DeliveryControlPlaneSnapshot[] = [];
    const guarded = (snapshot: DeliveryControlPlaneSnapshot) => { if (ready) listener(snapshot); else buffered.push(snapshot); };
    this.#listeners.add(guarded);
    if (onError !== undefined) this.#errorListeners.add(onError);
    try {
      listener(await this.snapshot());
      ready = true;
      for (const snapshot of buffered) listener(snapshot);
      return () => { this.#listeners.delete(guarded); if (onError !== undefined) this.#errorListeners.delete(onError); };
    } catch (cause) {
      this.#listeners.delete(guarded);
      if (onError !== undefined) this.#errorListeners.delete(onError);
      throw cause;
    }
  }
}
