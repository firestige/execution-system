import type { ExecutionApplicationState } from "../application/execution-application.js";
import type { IntakePresentation } from "../intake/presentation.js";
import type { ExecutionBootstrapDependencies, FilesystemInspection, HostOperationFactory, OwnerFact } from "./contracts.js";

export class BootstrapContractError extends TypeError {
  constructor(readonly code: "BOOTSTRAP_DEPENDENCIES_INVALID" | "BOOTSTRAP_STATE_INVALID", message = code) {
    super(message);
    this.name = "BootstrapContractError";
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || !Object.isFrozen(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new BootstrapContractError("BOOTSTRAP_DEPENDENCIES_INVALID");
  }
  const actual = Reflect.ownKeys(value);
  if (!actual.every((key): key is string => typeof key === "string")
    || actual.slice().sort().join("\0") !== keys.slice().sort().join("\0")) {
    throw new BootstrapContractError("BOOTSTRAP_DEPENDENCIES_INVALID");
  }
  return value as Record<string, unknown>;
}

function exactMethods(value: unknown, keys: readonly string[]): Record<string, (...args: never[]) => unknown> {
  const object = exactObject(value, keys);
  for (const key of keys) if (typeof object[key] !== "function") throw new BootstrapContractError("BOOTSTRAP_DEPENDENCIES_INVALID");
  return object as Record<string, (...args: never[]) => unknown>;
}

export function admitExecutionBootstrapDependencies(candidate: ExecutionBootstrapDependencies): ExecutionBootstrapDependencies {
  const root = exactObject(candidate, ["clock", "ids", "filesystem", "network", "intake", "attachments"]);
  const clock = exactMethods(root.clock, ["now"]);
  const ids = exactMethods(root.ids, ["create"]);
  const filesystem = exactMethods(root.filesystem, ["read", "writeImmutable", "list", "inspect"]);
  const network = exactMethods(root.network, ["request"]);
  const intake = exactMethods(root.intake, ["publish"]);
  const attachments = exactMethods(root.attachments, ["read"]);
  return Object.freeze({
    clock: Object.freeze({ now: clock.now!.bind(root.clock) as () => number }),
    ids: Object.freeze({ create: ids.create!.bind(root.ids) as () => string }),
    filesystem: Object.freeze({
      read: filesystem.read!.bind(root.filesystem) as (path: string, maxBytes?: number) => Promise<Uint8Array>,
      writeImmutable: filesystem.writeImmutable!.bind(root.filesystem) as (path: string, bytes: Uint8Array) => Promise<void>,
      list: filesystem.list!.bind(root.filesystem) as (path: string) => Promise<readonly string[]>,
      inspect: filesystem.inspect!.bind(root.filesystem) as (path: string) => Promise<FilesystemInspection>,
    }),
    network: Object.freeze({ request: network.request!.bind(root.network) as (url: string) => Promise<{ readonly status: number; readonly body: Uint8Array }> }),
    intake: Object.freeze({ publish: intake.publish!.bind(root.intake) as (event: IntakePresentation) => Promise<void> }),
    attachments: Object.freeze({ read: attachments.read!.bind(root.attachments) as (contentRef: string, maxBytes: number) => Promise<Uint8Array> }),
  });
}

const TRANSITIONS: Readonly<Record<ExecutionApplicationState, readonly ExecutionApplicationState[]>> = Object.freeze({
  CREATED: ["STARTING", "CLOSING"],
  STARTING: ["RECOVERING", "CLOSING"],
  RECOVERING: ["READY", "CLOSING"],
  READY: ["CLOSING"],
  CLOSING: ["CLOSED"],
  CLOSED: [],
});

export class BootstrapLifecycle {
  #state: ExecutionApplicationState = "CREATED";
  status(): Readonly<{ state: ExecutionApplicationState }> { return Object.freeze({ state: this.#state }); }
  beginStart(): void {
    if (this.#state === "STARTING" || this.#state === "RECOVERING" || this.#state === "READY") return;
    this.#move("STARTING");
  }
  beginRecovery(): void { this.#move("RECOVERING"); }
  publishReady(): void { this.#move("READY"); }
  beginClose(): void { if (this.#state !== "CLOSING" && this.#state !== "CLOSED") this.#move("CLOSING"); }
  publishClosed(): void { if (this.#state !== "CLOSED") this.#move("CLOSED"); }
  #move(next: ExecutionApplicationState): void {
    if (!TRANSITIONS[this.#state].includes(next)) throw new BootstrapContractError("BOOTSTRAP_STATE_INVALID");
    this.#state = next;
  }
}

interface OwnedResource { readonly name: string; readonly close: () => Promise<void> }
export class LifecycleResourceStack {
  readonly #resources: OwnedResource[] = [];
  #closed = false;
  own(name: string, close: () => Promise<void>): void {
    if (this.#closed) throw new BootstrapContractError("BOOTSTRAP_STATE_INVALID");
    this.#resources.push(Object.freeze({ name, close }));
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let first: unknown;
    for (const resource of this.#resources.reverse()) {
      try { await resource.close(); } catch (cause) { first ??= cause; }
    }
    if (first !== undefined) throw first;
  }
  async rollback(firstFailure: unknown): Promise<never> {
    try { await this.close(); } catch { /* the triggering failure remains authoritative */ }
    throw firstFailure;
  }
}

export interface WorkflowPackageSourceRequest {
  readonly name: string;
  readonly version: Readonly<{ kind: "LATEST" }> | Readonly<{ kind: "EXACT"; value: string }>;
}
export interface WorkflowPackageCandidate {
  readonly name: string;
  readonly exactVersion: string;
  readonly archiveDigest: string;
  readonly archive: Uint8Array;
}
export type WorkflowPackageSourceResult =
  | Readonly<{ kind: "FOUND"; candidate: WorkflowPackageCandidate }>
  | Readonly<{ kind: "NOT_FOUND" }>
  | Readonly<{ kind: "UNAVAILABLE" }>
  | Readonly<{ kind: "INVALID" }>;
export interface WorkflowPackageSource { fetch(request: WorkflowPackageSourceRequest): Promise<WorkflowPackageSourceResult> }
export interface WorkflowPackageSourceFactory { create(): Promise<WorkflowPackageSource> }
export type SourceFactory = WorkflowPackageSourceFactory;
export class SourceFactorySelectionError extends Error {
  readonly code = "SOURCE_FACTORY_NOT_FOUND";
  constructor(readonly key: string) { super(`No exact Workflow Package Source factory is registered for '${key}'`); }
}
export class SourceFactoryRegistry {
  readonly #factories: Readonly<Record<string, SourceFactory>>;
  constructor(factories: Readonly<Record<string, SourceFactory>>) {
    if (!Object.isFrozen(factories) || Object.keys(factories).length === 0
      || Object.values(factories).some((factory) => {
        try { exactMethods(factory, ["create"]); return false; } catch { return true; }
      })) throw new BootstrapContractError("BOOTSTRAP_DEPENDENCIES_INVALID");
    this.#factories = factories;
  }
  select(key: string): SourceFactory {
    const selected = this.#factories[key];
    if (selected === undefined) throw new SourceFactorySelectionError(key);
    return selected;
  }
}

export class HostOperationFactoryRegistry {
  readonly #factories: Readonly<Record<string, HostOperationFactory>>;
  constructor(factories: Readonly<Record<string, HostOperationFactory>>) {
    if (!Object.isFrozen(factories) || Object.keys(factories).length === 0
      || Object.values(factories).some((factory) => {
        try { exactMethods(factory, ["admitConfiguration", "create"]); return false; } catch { return true; }
      })) throw new BootstrapContractError("BOOTSTRAP_DEPENDENCIES_INVALID");
    this.#factories = factories;
  }
  select(key: string): HostOperationFactory {
    const selected = this.#factories[key];
    if (selected === undefined) throw new SourceFactorySelectionError(key);
    return selected;
  }
  createDeclared(declarations: readonly Readonly<{ key: string; configuration: unknown }>[]): Readonly<Record<string, ReturnType<HostOperationFactory["create"]>>> {
    const keys = declarations.map((declaration) => declaration.key);
    if (new Set(keys).size !== keys.length) throw new HostOperationSelectionError("HOST_OPERATION_DECLARATION_DUPLICATE");
    const admitted = declarations.map((declaration) => {
      const factory = this.select(declaration.key);
      return Object.freeze({ key: declaration.key, factory, configuration: factory.admitConfiguration(declaration.configuration) });
    });
    return Object.freeze(Object.fromEntries(admitted.map((entry) => [entry.key, entry.factory.create(entry.configuration)])));
  }
}

export class HostOperationSelectionError extends Error {
  constructor(readonly code: "HOST_OPERATION_DECLARATION_DUPLICATE") {
    super(code);
    this.name = "HostOperationSelectionError";
  }
}

export class DisabledOwnerFactSink {
  readonly kind = "disabled" as const;
  emit(_fact: OwnerFact): void {}
}

type DeliveryCompositionState = "ADMITTED" | "BOUND" | "OBSERVATION_CREATED" | "RUNNER_CREATED" | "OWNER_FACTS_WIRED" | "RUNNING";

/** Executable Wave 1 oracle; production composition is intentionally deferred. */
export class DeliveryCompositionGate {
  #state: DeliveryCompositionState = "ADMITTED";
  status(): Readonly<{ state: DeliveryCompositionState }> { return Object.freeze({ state: this.#state }); }
  persistBinding(): void { this.#expect("ADMITTED", "BOUND"); }
  createObservation(): void { this.#expect("BOUND", "OBSERVATION_CREATED"); }
  createRunner(): void { this.#expect("OBSERVATION_CREATED", "RUNNER_CREATED"); }
  wireOwnerFacts(): void { this.#expect("RUNNER_CREATED", "OWNER_FACTS_WIRED"); }
  startRunnerEffect(): void { this.#expect("OWNER_FACTS_WIRED", "RUNNING"); }
  #expect(current: DeliveryCompositionState, next: DeliveryCompositionState): void {
    if (this.#state !== current) throw new BootstrapContractError("BOOTSTRAP_STATE_INVALID");
    this.#state = next;
  }
}

type InstallationCompositionState = "INPUTS_VALIDATED" | "STATE_CREATED" | "SOURCE_STORE_CREATED" | "OBSERVATION_CREATED" | "DEFINITIONS_CREATED" | "APPLICATION_CREATED";

/** Executable order oracle for the later sole production composition root. */
export class InstallationCompositionGate {
  #state: InstallationCompositionState = "INPUTS_VALIDATED";
  status(): Readonly<{ state: InstallationCompositionState }> { return Object.freeze({ state: this.#state }); }
  createState(): void { this.#expect("INPUTS_VALIDATED", "STATE_CREATED"); }
  createSourceAndStore(): void { this.#expect("STATE_CREATED", "SOURCE_STORE_CREATED"); }
  createObservation(): void { this.#expect("SOURCE_STORE_CREATED", "OBSERVATION_CREATED"); }
  createDefinitions(): void { this.#expect("OBSERVATION_CREATED", "DEFINITIONS_CREATED"); }
  createApplication(): void { this.#expect("DEFINITIONS_CREATED", "APPLICATION_CREATED"); }
  #expect(current: InstallationCompositionState, next: InstallationCompositionState): void {
    if (this.#state !== current) throw new BootstrapContractError("BOOTSTRAP_STATE_INVALID");
    this.#state = next;
  }
}

export interface BootstrapDiagnostic { readonly code: string; readonly fieldPaths: readonly string[]; readonly truncated: boolean }

export function createBoundedBootstrapDiagnostic(
  code: string,
  fieldPaths: readonly string[],
  maxBytes: number,
): BootstrapDiagnostic {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) throw new BootstrapContractError("BOOTSTRAP_DEPENDENCIES_INVALID");
  const accepted: string[] = [];
  let truncated = false;
  for (const fieldPath of fieldPaths) {
    const candidate = Object.freeze({ code, fieldPaths: [...accepted, fieldPath], truncated: false });
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) { truncated = true; break; }
    accepted.push(fieldPath);
  }
  return Object.freeze({ code, fieldPaths: Object.freeze(accepted), truncated });
}

export type ConcurrencyAdmission =
  | Readonly<{ kind: "ACQUIRED"; release(): void }>
  | Readonly<{ kind: "BUSY" }>;

const BUSY: ConcurrencyAdmission = Object.freeze({ kind: "BUSY" });

/** Installation-wide immediate admission; deliberately has no queue or waiter surface. */
export class ImmediateConcurrencyController {
  #active = 0;
  constructor(readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new BootstrapContractError("BOOTSTRAP_DEPENDENCIES_INVALID");
    }
  }
  tryAcquire(): ConcurrencyAdmission {
    if (this.#active >= this.maximum) return BUSY;
    this.#active += 1;
    let released = false;
    return Object.freeze({
      kind: "ACQUIRED" as const,
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
      },
    });
  }
}
