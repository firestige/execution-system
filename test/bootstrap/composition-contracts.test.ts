import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { ExecutionApplication } from "../../src/application/execution-application.js";
import {
  BootstrapContractError,
  BootstrapLifecycle,
  DisabledOwnerFactSink,
  DeliveryCompositionGate,
  InstallationCompositionGate,
  HostOperationFactoryRegistry,
  LifecycleResourceStack,
  SourceFactoryRegistry,
  admitExecutionBootstrapDependencies,
  createBoundedBootstrapDiagnostic,
  type AttachmentContentPort,
  type ExecutionApplicationFactory,
  type ExecutionBootstrapDependencies,
  type InstallationFactoryContext,
  type DeliveryServiceFactory,
  type PersistedDeliveryBinding,
  type DeliveryFactoryContext,
  type OwnerFactIngress,
} from "../../src/bootstrap/index.js";

function dependencies(): ExecutionBootstrapDependencies {
  return Object.freeze({
    clock: Object.freeze({ now: () => 1 }),
    ids: Object.freeze({ create: () => "fixture-id" }),
    filesystem: Object.freeze({
      read: async () => new Uint8Array(),
      writeImmutable: async () => undefined,
      list: async () => [],
      inspect: async () => Object.freeze({ kind: "missing" as const }),
    }),
    network: Object.freeze({ request: async () => Object.freeze({ status: 200, body: new Uint8Array() }) }),
    intake: Object.freeze({ publish: async () => undefined }),
    attachments: Object.freeze({ read: async () => new Uint8Array() }) satisfies AttachmentContentPort,
  });
}

describe("Wave 1 composition contracts", () => {
  it("admits only exact frozen host-neutral bootstrap capabilities", () => {
    const admitted = admitExecutionBootstrapDependencies(dependencies());
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.keys(admitted).sort()).toEqual(["attachments", "clock", "filesystem", "ids", "intake", "network"]);

    expect(() => admitExecutionBootstrapDependencies(Object.freeze({
      ...dependencies(),
      cordisContext: {},
    }) as unknown as ExecutionBootstrapDependencies)).toThrowError(BootstrapContractError);
    expect(() => admitExecutionBootstrapDependencies(Object.freeze({
      ...dependencies(),
      attachments: Object.freeze({ read: async () => new Uint8Array(), nativeUpload: {} }),
    }) as unknown as ExecutionBootstrapDependencies)).toThrowError(BootstrapContractError);
  });

  it("keeps installation context free of Delivery instances and requires persisted binding for Delivery context", () => {
    expectTypeOf<InstallationFactoryContext>().not.toHaveProperty("runner");
    expectTypeOf<InstallationFactoryContext>().not.toHaveProperty("deliveryObservation");
    expectTypeOf<InstallationFactoryContext["dependencies"]>().not.toHaveProperty("attachments");
    expectTypeOf<InstallationFactoryContext["dependencies"]>().not.toHaveProperty("intake");
    expectTypeOf<DeliveryServiceFactory["create"]>().parameter(1).toEqualTypeOf<AttachmentContentPort>();
    expectTypeOf<DeliveryFactoryContext>().toHaveProperty("binding").toEqualTypeOf<PersistedDeliveryBinding>();
    expectTypeOf<DeliveryFactoryContext>().toHaveProperty("ownerFacts").toEqualTypeOf<OwnerFactIngress>();
  });

  it("selects a Source factory by one exact configured key without fallback", () => {
    const github = Object.freeze({ create: vi.fn(async () => Object.freeze({ fetch: vi.fn() })) });
    const alternate = Object.freeze({ create: vi.fn(async () => Object.freeze({ fetch: vi.fn() })) });
    const registry = new SourceFactoryRegistry(Object.freeze({ github, fixture: alternate }));
    expect(registry.select("github")).toBe(github);
    expect(registry.select("fixture")).toBe(alternate);
    try { registry.select("missing"); expect.fail("selection should fail"); }
    catch (error) { expect(error).toMatchObject({ code: "SOURCE_FACTORY_NOT_FOUND" }); }
    expect(github.create).not.toHaveBeenCalled();
    expect(alternate.create).not.toHaveBeenCalled();
  });

  it("uses exact Host Operation factory keys and a zero-effect disabled observation sink", () => {
    const operation = Object.freeze({
      admitConfiguration: vi.fn((value: unknown) => {
        if (JSON.stringify(value) !== '{"mode":"safe"}') throw new TypeError("invalid operation config");
        return Object.freeze({ mode: "safe" });
      }),
      create: vi.fn(() => Object.freeze({ execute: vi.fn() })),
    });
    const registry = new HostOperationFactoryRegistry(Object.freeze({ shell: operation }));
    expect(registry.select("shell")).toBe(operation);
    expect(() => registry.select("Shell")).toThrow();
    expect(registry.create("shell", { mode: "safe" })).toHaveProperty("execute");
    expect(() => registry.create("shell", { mode: "ambient" })).toThrow();
    const sink = new DisabledOwnerFactSink();
    expect(sink.kind).toBe("disabled");
    expect(() => sink.emit({ owner: "M01", name: "delivery.bound", occurredAt: 1 })).not.toThrow();
  });

  it("publishes READY only after recovery and enforces the lifecycle machine", () => {
    const lifecycle = new BootstrapLifecycle();
    expect(lifecycle.status()).toEqual({ state: "CREATED" });
    lifecycle.beginStart();
    lifecycle.beginStart();
    lifecycle.beginRecovery();
    lifecycle.beginStart();
    lifecycle.publishReady();
    lifecycle.beginStart();
    expect(lifecycle.status()).toEqual({ state: "READY" });
    lifecycle.beginClose();
    lifecycle.publishClosed();
    expect(lifecycle.status()).toEqual({ state: "CLOSED" });
    try { lifecycle.publishReady(); expect.fail("transition should fail"); }
    catch (error) { expect(error).toMatchObject({ code: "BOOTSTRAP_STATE_INVALID" }); }
  });

  it("makes persisted binding and owner-fact wiring prerequisites of Runner effects", () => {
    const gate = new DeliveryCompositionGate();
    expect(() => gate.createObservation()).toThrow();
    gate.persistBinding();
    gate.createObservation();
    gate.createRunner();
    expect(() => gate.startRunnerEffect()).toThrow();
    gate.wireOwnerFacts();
    gate.startRunnerEffect();
    expect(gate.status()).toEqual({ state: "RUNNING" });
  });

  it("freezes the installation factory DAG before production bootstrap exists", () => {
    const gate = new InstallationCompositionGate();
    expect(() => gate.createSourceAndStore()).toThrow();
    gate.createState();
    gate.createSourceAndStore();
    gate.createObservation();
    gate.createDefinitions();
    gate.createApplication();
    expect(gate.status()).toEqual({ state: "APPLICATION_CREATED" });
  });

  it("disposes partial construction and normal ownership in exact reverse order, once", async () => {
    const calls: string[] = [];
    const resources = new LifecycleResourceStack();
    resources.own("state", async () => { calls.push("state"); });
    resources.own("source", async () => { calls.push("source"); });
    resources.own("observation", async () => { calls.push("observation"); });
    await resources.close();
    await resources.close();
    expect(calls).toEqual(["observation", "source", "state"]);
  });

  it("preserves the first construction failure while rollback remains reverse and best effort", async () => {
    const resources = new LifecycleResourceStack();
    const calls: string[] = [];
    resources.own("first", async () => { calls.push("first"); });
    resources.own("second", async () => { calls.push("second"); throw new Error("close failed"); });
    const startup = Object.assign(new Error("startup failed"), { code: "SOURCE_START_FAILED" });
    await expect(resources.rollback(startup)).rejects.toBe(startup);
    expect(calls).toEqual(["second", "first"]);
  });

  it("bounds diagnostics to typed redacted fields", () => {
    const diagnostic = createBoundedBootstrapDiagnostic("CONFIG_PATH_INVALID", ["paths.stateRoot", "x".repeat(1000)], 128);
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(128);
    expect(diagnostic).not.toHaveProperty("cause");
    expect(diagnostic).not.toHaveProperty("value");
  });

  it("defines one public application factory and no premature production assembly", () => {
    expectTypeOf<ExecutionApplicationFactory>().toMatchTypeOf<{
      create(configFile: string, dependencies: ExecutionBootstrapDependencies): Promise<ExecutionApplication>;
    }>();
  });
});
