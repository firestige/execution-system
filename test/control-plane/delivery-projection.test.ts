import { describe, expect, it, vi } from "vitest";

import {
  DeliveryControlPlaneProjection,
  DeliveryProjectionError,
  type DeliveryProjectionBinding,
  type DeliveryProjectionManifest,
  type DeliveryProjectionRuntime,
  type DeliveryProjectionCompleted,
  type OccupiedCurrentSlot,
} from "../../src/delivery/index.js";

const sha = (character: string) => `sha256:${character.repeat(64)}`;

function slot(overrides: Partial<OccupiedCurrentSlot> = {}): OccupiedCurrentSlot {
  return Object.freeze({
    schemaVersion: "execution.current-slot@2.0.0",
    state: "RUNNING_CORRELATED",
    worktree: "/workspace/zeta",
    deliveryId: "delivery-zeta",
    manifestPath: "/state/manifests/zeta.json",
    deliveryBindingIdentity: sha("a"),
    updatedAt: 120,
    diagnostic: null,
    ...overrides,
  });
}

function manifest(overrides: Partial<DeliveryProjectionManifest> = {}): DeliveryProjectionManifest {
  return Object.freeze({
    deliveryId: "delivery-zeta",
    taskId: "task-zeta",
    taskDisplayName: "Zeta task",
    createdAt: 100,
    canonicalWorktree: "/workspace/zeta",
    deliveryBindingIdentity: sha("a"),
    workflow: Object.freeze({
      identity: "workflow.implementation",
      packageName: "implementation",
      exactPackageVersion: "1.2.3",
      packageDigest: sha("b"),
      snapshotIdentity: sha("c"),
      snapshotDigest: sha("d"),
    }),
    ...overrides,
  });
}

function binding(overrides: Partial<DeliveryProjectionBinding> = {}): DeliveryProjectionBinding {
  const value: { deliveryId: string; deliveryBindingIdentity: string; sessionCorrelation?: string } = {
    deliveryId: "delivery-zeta",
    deliveryBindingIdentity: sha("a"),
    sessionCorrelation: "conversation-9",
    ...overrides,
  };
  if (value.sessionCorrelation === undefined) delete value.sessionCorrelation;
  return Object.freeze(value);
}

function runtime(overrides: Partial<DeliveryProjectionRuntime> = {}): DeliveryProjectionRuntime {
  return Object.freeze({
    deliveryId: "delivery-zeta",
    deliveryBindingIdentity: sha("a"),
    current: Object.freeze({ kind: "ACTION", identity: "action.review" }),
    terminal: null,
    error: null,
    ...overrides,
  });
}

function harness(options: {
  slots?: readonly OccupiedCurrentSlot[];
  manifests?: Readonly<Record<string, DeliveryProjectionManifest>>;
  bindings?: readonly DeliveryProjectionBinding[];
  runtimes?: readonly DeliveryProjectionRuntime[];
  completed?: readonly DeliveryProjectionCompleted[];
} = {}) {
  let slots = options.slots ?? [slot()];
  let bindings = options.bindings ?? [binding()];
  let runtimes = options.runtimes ?? [runtime()];
  let completed = options.completed ?? [];
  const manifests = options.manifests ?? { "/state/manifests/zeta.json": manifest() };
  const invalidations = new Set<() => void>();
  const projection = new DeliveryControlPlaneProjection({
    slots: Object.freeze({ enumerate: async () => slots }),
    manifests: Object.freeze({ loadProjection: async (path: string) => {
      const value = manifests[path];
      if (value === undefined) throw new Error("missing");
      return value;
    } }),
    bindings: Object.freeze({ enumerateBindings: () => bindings }),
    runtime: Object.freeze({ enumerateRuntime: () => runtimes }),
    completed: Object.freeze({ enumerateCompleted: async () => completed }),
    invalidations: Object.freeze({ subscribe(listener: () => void) { invalidations.add(listener); return () => invalidations.delete(listener); } }),
    now: () => 150,
  });
  return {
    projection,
    setSlots(next: readonly OccupiedCurrentSlot[]) { slots = next; },
    setBindings(next: readonly DeliveryProjectionBinding[]) { bindings = next; },
    setRuntimes(next: readonly DeliveryProjectionRuntime[]) { runtimes = next; },
    setCompleted(next: readonly DeliveryProjectionCompleted[]) { completed = next; },
    invalidate() { for (const listener of invalidations) listener(); },
  };
}

describe("Execution Delivery control-plane projection", () => {
  it("publishes deterministic inventory and an exact Session-to-Delivery view without host-native values", async () => {
    const second = slot({ deliveryId: "delivery-alpha", worktree: "/workspace/alpha", manifestPath: "/state/manifests/alpha.json", deliveryBindingIdentity: sha("e") });
    const h = harness({
      slots: [slot(), second],
      manifests: {
        "/state/manifests/zeta.json": manifest(),
        "/state/manifests/alpha.json": manifest({ deliveryId: "delivery-alpha", taskId: "task-alpha", canonicalWorktree: "/workspace/alpha", deliveryBindingIdentity: sha("e") }),
      },
      bindings: [binding(), binding({ deliveryId: "delivery-alpha", deliveryBindingIdentity: sha("e"), sessionCorrelation: undefined })],
      runtimes: [runtime(), runtime({ deliveryId: "delivery-alpha", deliveryBindingIdentity: sha("e"), current: null })],
    });

    const snapshot = await h.projection.snapshot();
    expect(snapshot.schemaVersion).toBe("execution.delivery-control-plane@1.0.0");
    expect(snapshot.deliveries.map((item) => item.deliveryId)).toEqual(["delivery-alpha", "delivery-zeta"]);
    expect(snapshot.deliveries[0]).toMatchObject({ detached: true, recoverable: true, navigation: null });
    expect(snapshot.deliveries[1]).toMatchObject({
      deliveryId: "delivery-zeta", lifecycle: "RUNNING_CORRELATED", detached: false, recoverable: true,
      navigation: { sessionCorrelation: "conversation-9" }, current: { kind: "ACTION", identity: "action.review" },
      timing: { startedAt: 100, updatedAt: 120, elapsedMs: 50 },
    });
    expect(await h.projection.session("conversation-9")).toMatchObject({
      kind: "BOUND", sessionCorrelation: "conversation-9",
      delivery: { deliveryId: "delivery-zeta", workflow: { identity: "workflow.implementation" } },
    });
    expect(await h.projection.session("conversation-missing")).toEqual({ kind: "UNBOUND", sessionCorrelation: "conversation-missing" });
    expect(JSON.stringify(snapshot)).not.toMatch(/credential|cordis|dsh|nativeSession/iu);
  });

  it("replays one coherent snapshot before ordered updates and stops after unsubscribe", async () => {
    const h = harness();
    const observed: string[][] = [];
    const unsubscribe = await h.projection.subscribe((snapshot) => observed.push(snapshot.deliveries.map((item) => item.lifecycle)));
    h.setSlots([slot({ state: "RESULT_UNRESOLVED", updatedAt: 140 })]);
    h.setRuntimes([runtime({ current: null, error: Object.freeze({ code: "RESULT_UNRESOLVED" }) })]);
    h.invalidate();
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    expect(observed).toEqual([["RUNNING_CORRELATED"], ["RESULT_UNRESOLVED"]]);
    unsubscribe();
    h.setSlots([slot({ state: "TERMINAL_HANDLING", updatedAt: 145 })]);
    h.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(observed).toHaveLength(2);
  });

  it("coalesces concurrent invalidations while preserving monotonically coherent snapshots", async () => {
    const h = harness();
    const generations: number[] = [];
    await h.projection.subscribe((snapshot) => generations.push(snapshot.generation));
    h.setSlots([slot({ state: "RESULT_UNRESOLVED", updatedAt: 130 })]);
    h.invalidate();
    h.setSlots([slot({ state: "RUNNING_CORRELATED", updatedAt: 140 })]);
    h.invalidate();
    await vi.waitFor(() => expect(generations.length).toBeGreaterThan(1));
    expect(generations).toEqual([...generations].sort((left, right) => left - right));
    expect(new Set(generations).size).toBe(generations.length);
  });

  it("reports subscription corruption without replaying a stale update", async () => {
    const h = harness();
    const snapshots: number[] = [];
    const errors: string[] = [];
    await h.projection.subscribe((snapshot) => snapshots.push(snapshot.generation), (error) => errors.push(error.code));
    h.setBindings([binding({ deliveryBindingIdentity: sha("f") })]);
    h.invalidate();
    await vi.waitFor(() => expect(errors).toEqual(["DELIVERY_PROJECTION_STALE_BINDING"]));
    expect(snapshots).toHaveLength(1);
  });

  it("maps unavailable owner sources and removes a subscriber whose initial replay fails", async () => {
    const invalidations = Object.freeze({ subscribe() { return () => undefined; } });
    const projection = new DeliveryControlPlaneProjection({
      slots: Object.freeze({ async enumerate(): Promise<readonly OccupiedCurrentSlot[]> { throw new Error("offline"); } }),
      manifests: Object.freeze({ async loadProjection() { throw new Error("not reached"); } }),
      bindings: Object.freeze({ enumerateBindings: () => [] }),
      runtime: Object.freeze({ enumerateRuntime: () => [] }),
      invalidations,
      now: () => 1,
    });
    await expect(projection.snapshot()).rejects.toMatchObject({ code: "DELIVERY_PROJECTION_UNAVAILABLE" });
    await expect(projection.subscribe(() => undefined, () => undefined)).rejects.toMatchObject({ code: "DELIVERY_PROJECTION_UNAVAILABLE" });
  });

  it.each([
    ["stale Manifest binding", manifest({ deliveryBindingIdentity: sha("f") }), binding(), runtime()],
    ["stale Session binding", manifest(), binding({ deliveryBindingIdentity: sha("f") }), runtime()],
    ["stale runtime fact", manifest(), binding(), runtime({ deliveryBindingIdentity: sha("f") })],
  ])("fails closed on %s", async (_name, candidateManifest, candidateBinding, candidateRuntime) => {
    const h = harness({ manifests: { "/state/manifests/zeta.json": candidateManifest }, bindings: [candidateBinding], runtimes: [candidateRuntime] });
    await expect(h.projection.snapshot()).rejects.toBeInstanceOf(DeliveryProjectionError);
    await expect(h.projection.snapshot()).rejects.toMatchObject({ code: "DELIVERY_PROJECTION_STALE_BINDING" });
  });

  it("fails closed on corrupt reload, duplicate correlation, and contradictory recovery state", async () => {
    const duplicate = binding({ sessionCorrelation: "conversation-9" });
    const duplicateSlot = slot({ deliveryId: "delivery-duplicate", worktree: "/workspace/duplicate", manifestPath: "/state/manifests/duplicate.json", deliveryBindingIdentity: sha("e") });
    const h = harness({
      slots: [slot(), duplicateSlot],
      manifests: {
        "/state/manifests/zeta.json": manifest(),
        "/state/manifests/duplicate.json": manifest({ deliveryId: "delivery-duplicate", canonicalWorktree: "/workspace/duplicate", deliveryBindingIdentity: sha("e") }),
      },
      bindings: [binding(), { ...duplicate, deliveryId: "delivery-duplicate", deliveryBindingIdentity: sha("e") }],
      runtimes: [runtime(), runtime({ deliveryId: "delivery-duplicate", deliveryBindingIdentity: sha("e") })],
    });
    await expect(h.projection.snapshot()).rejects.toMatchObject({ code: "DELIVERY_PROJECTION_CORRUPT" });

    const contradictory = harness({ slots: [slot({ state: "BOUND" })], runtimes: [runtime({ terminal: Object.freeze({ outcome: "SUCCEEDED", finishedAt: 149 }), current: null })] });
    await expect(contradictory.projection.snapshot()).rejects.toMatchObject({ code: "DELIVERY_PROJECTION_RECOVERY_MISMATCH" });
  });

  it("contains no command or mutation surface", () => {
    const methods = Object.getOwnPropertyNames(DeliveryControlPlaneProjection.prototype).sort();
    expect(methods).toEqual(["constructor", "session", "snapshot", "subscribe"]);
  });

  it("replays a terminal Session view after reload from the lifecycle-completed fact", async () => {
    const completed = Object.freeze({
      schemaVersion: "execution.delivery-completed@1.0.0" as const,
      manifest: manifest(),
      updatedAt: 180,
      terminal: Object.freeze({ outcome: "SUCCEEDED" as const, finishedAt: 180 }),
      error: null,
      sessionCorrelation: "conversation-9",
    });
    const h = harness({ slots: [], completed: [completed], bindings: [], runtimes: [] });
    await expect(h.projection.session("conversation-9")).resolves.toMatchObject({
      kind: "BOUND",
      delivery: {
        deliveryId: "delivery-zeta",
        lifecycle: "TERMINAL",
        recoverable: false,
        current: null,
        terminal: { outcome: "SUCCEEDED", finishedAt: 180 },
        timing: { startedAt: 100, updatedAt: 180, elapsedMs: 80 },
      },
    });
  });
});
