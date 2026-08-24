import { createHash } from "node:crypto";
import path from "node:path";

import type { ExecutionApplication, ExecutionFailure, ExecutionRequest, ExecutionResult, TaskPrompt } from "../application/execution-application.js";
import { RunnerFactory, type RunnerFactoryConfig } from "../composition/runner-factory.js";
import { canonicalDigest, type FrozenJsonValue, type RunnerActivationContext } from "../contracts/index.js";
import { createExecutionEnvironment } from "../core/request.js";
import { ExecutionCoreAdmission } from "../core/execution-core.js";
import {
  CurrentSlotRepository,
  DeliveryAdmissionProjector,
  DeliveryAdmissionService,
  DeliveryLifecycleService,
  DeliveryManifestRepository,
  DeliveryRecoveryService,
  FrozenWorkflowPackageValidator,
  WorkflowPackageResolver,
  WorkflowPackageSourceRegistry,
  WorkflowPackageStore,
  createConfiguredWorkflowPackageSource,
  type AlternateWorkflowPackageSourceFactory,
  type DeliveryManifest,
  type DeliveryRuntimeFactory,
  type OccupiedCurrentSlot,
  type WorkflowPackageCompatibilityTarget,
} from "../delivery/index.js";
import { loadExecutionInstallationConfig } from "../configuration/index.js";
import { createDeliveryObservationEmitter, createObservationOwnerFact, createRunnerOwnerFactPort, type DeliveryObservationEmitter, type ObservationFamilySchema, type RunnerSettlementOwnerFact } from "../observation/index.js";
import type { HostOperationHandler } from "../host/workflow-host-adapter-factory.js";
import type { ExecutionRuntimeAdapter } from "../execution/runtime-adapter.js";
import type { IntakeDeliveryInventoryItem, WorkflowIntakeControlPort } from "../intake/index.js";
import { BootstrapLifecycle, ImmediateConcurrencyController, admitExecutionBootstrapDependencies } from "./runtime-contracts.js";
import type { ExecutionApplicationFactory, ExecutionBootstrapDependencies, OwnerFact, OwnerFactIngress } from "./contracts.js";
import { ProductionInteractionBroker } from "./interaction-broker.js";

function failure(code: ExecutionFailure["code"]): ExecutionFailure {
  return Object.freeze({ kind: "ERROR", code, message: code });
}

export class ExecutionBootstrapStartupError extends Error {
  readonly code = "BOOTSTRAP_RECOVERY_FAILED";
  constructor() {
    super("BOOTSTRAP_RECOVERY_FAILED");
    this.name = "ExecutionBootstrapStartupError";
  }
}

const COMPATIBILITY: WorkflowPackageCompatibilityTarget = Object.freeze({
  contractVersion: "1.1.0",
  providerKey: "dsh",
  providerCapabilities: Object.freeze(["structured-completion", "action-interaction"] as const),
  hostCapabilities: Object.freeze(["deterministic-validation", "deterministic-selection", "deterministic-transformation"] as const),
});

export interface DefaultExecutionApplicationFactoryOptions {
  readonly alternateSources?: Readonly<Record<string, AlternateWorkflowPackageSourceFactory>>;
  readonly hostOperationFactories?: Readonly<Record<string, ProductionHostOperationFactory>>;
}

export interface ProductionHostOperationFactory {
  create(binding: Readonly<{ identity: string; contractIdentity: string; configuration: Readonly<Record<string, FrozenJsonValue>> }>): HostOperationHandler;
}

export class ProductionHostOperationRegistryError extends Error {
  readonly code = "HOST_OPERATION_IMPLEMENTATION_INVALID";
  constructor(readonly identity: string) {
    super("HOST_OPERATION_IMPLEMENTATION_INVALID");
    this.name = "ProductionHostOperationRegistryError";
  }
}

function segment(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function observationFamily(workflowIdentity: string): Readonly<{ schema: ObservationFamilySchema; value: "implementation" | "system-design" }> | undefined {
  if (/^implementation-workflow@/u.test(workflowIdentity)) return Object.freeze({ schema: "implementation@1", value: "implementation" });
  if (/^system-design-workflow@/u.test(workflowIdentity)) return Object.freeze({ schema: "system-design@1", value: "system-design" });
  return undefined;
}

function nanoseconds(milliseconds: number): string {
  return (BigInt(Math.max(0, milliseconds)) * 1_000_000n).toString();
}

function deliveryOwnerFactIngress(
  manifest: DeliveryManifest,
  activation: RunnerActivationContext,
  emitter: DeliveryObservationEmitter,
): OwnerFactIngress {
  const family = observationFamily(activation.correlation.workflowIdentity as string);
  if (family === undefined || emitter.kind === "disabled") return Object.freeze({ emit(): void {} });
  const traceId = segment(`trace:${manifest.deliveryBindingIdentity}`).slice(0, 32);
  const spanId = segment(`span:${manifest.deliveryBindingIdentity}`).slice(0, 16);
  const emitted = new Set<string>();
  return Object.freeze({
    emit(fact: OwnerFact): void {
      if (!((fact.name === "terminal-validated" || fact.name === "start-failed") && fact.outcome !== undefined)
        || emitted.has("terminal")) return;
      const outcome = fact.outcome;
      if (!["COMPLETED", "FAILED", "INCOMPLETE", "CANCELLED", "START_FAILED"].includes(outcome)) return;
      emitted.add("terminal");
      const rootIdentity = `delivery-root-${segment(manifest.deliveryId).slice(0, 24)}`;
      const summaryIdentity = `delivery-summary-${segment(`${manifest.deliveryId}:${outcome}`).slice(0, 24)}`;
      try {
        emitter.emit(createObservationOwnerFact({
          owner: "M01", phase: "DELIVERY_BOUND",
          correlation: Object.freeze({ deliveryId: manifest.deliveryId, traceId, spanId }),
          identity: rootIdentity, signal: "span", familySchema: family.schema,
          span: Object.freeze({
            name: `invoke_workflow ${activation.correlation.workflowIdentity as string}`,
            kind: "INTERNAL", startTimeUnixNano: nanoseconds(manifest.createdAt), endTimeUnixNano: nanoseconds(fact.occurredAt),
            flags: 1, status: outcome === "COMPLETED" ? "OK" : "ERROR",
          }),
          fields: Object.freeze({
            C01: manifest.deliveryId,
            C03: activation.correlation.workflowIdentity as string,
            C04: manifest.resolvedPackage.exactVersion,
            C05: activation.correlation.packageIdentity as string,
            C06: activation.correlation.runtimeProfileIdentity as string,
            C07: manifest.deliveryBindingIdentity.replace(/^sha256:/u, ""),
            C08: family.value,
          }),
          standard: Object.freeze({}),
        }));
        emitter.emit(createObservationOwnerFact({
          owner: "M02", phase: "DELIVERY_TERMINAL", correlation: Object.freeze({ deliveryId: manifest.deliveryId }),
          identity: summaryIdentity, signal: "event", eventName: "delivery.summary", familySchema: family.schema,
          fields: Object.freeze({
            C08: family.value, C09: summaryIdentity, C10: outcome, C11: "FINAL", C49: family.schema,
            C55: Math.max(0, fact.occurredAt - manifest.createdAt),
          }),
        }));
      } catch { /* M03 remains non-controlling for malformed or unavailable facts. */ }
    },
  });
}

const FORMAT_OPERATION_FACTORY: ProductionHostOperationFactory = Object.freeze({
  create() {
    return Object.freeze({ async execute(input: FrozenJsonValue) { return Object.freeze({ accepted: true, value: input }); } });
  },
});

const STANDARD_HOST_OPERATION_FACTORIES: Readonly<Record<string, ProductionHostOperationFactory>> = Object.freeze({
  "host-operation.deterministic-validation.v1": FORMAT_OPERATION_FACTORY,
  "host-operation.deterministic-selection.v1": FORMAT_OPERATION_FACTORY,
  "host-operation.deterministic-transformation.v1": FORMAT_OPERATION_FACTORY,
});

export function createProductionHostOperationHandlers(
  activation: RunnerActivationContext,
  factories: Readonly<Record<string, ProductionHostOperationFactory>>,
): Readonly<Record<string, HostOperationHandler>> {
  const bindings = new Map<string, Readonly<{ identity: string; contractIdentity: string; configuration: Readonly<Record<string, FrozenJsonValue>> }>>();
  const add = (identity: string, contractIdentity: string, configuration: Readonly<Record<string, FrozenJsonValue>>) => {
    const candidate = Object.freeze({ identity, contractIdentity, configuration });
    const existing = bindings.get(identity);
    if (existing !== undefined && canonicalDigest(existing as unknown as FrozenJsonValue) !== canonicalDigest(candidate as unknown as FrozenJsonValue)) {
      throw new ProductionHostOperationRegistryError(identity);
    }
    bindings.set(identity, candidate);
  };
  for (const operation of Object.values(activation.program.execution.hostOperations)) {
    add(operation.contractIdentity, operation.contractIdentity, Object.freeze({}));
  }
  for (const action of Object.values(activation.program.execution.actions)) {
    for (const validator of action.gate.deterministic ?? []) {
      add(validator, "host-operation.deterministic-validation.v1", Object.freeze({ validator }));
    }
  }
  const handlers: Array<readonly [string, HostOperationHandler]> = [];
  for (const binding of [...bindings.values()].sort((left, right) => left.identity.localeCompare(right.identity))) {
    const factory = factories[binding.contractIdentity];
    if (factory === undefined) throw new ProductionHostOperationRegistryError(binding.contractIdentity);
    const handler = factory.create(binding);
    if (handler === null || typeof handler !== "object" || typeof handler.execute !== "function") {
      throw new ProductionHostOperationRegistryError(binding.identity);
    }
    handlers.push([binding.identity, Object.freeze({ execute: handler.execute.bind(handler) })]);
  }
  return Object.freeze(Object.fromEntries(handlers));
}

class ProductionRuntimeManager implements DeliveryRuntimeFactory {
  readonly #runner = new RunnerFactory();
  readonly #live = new Set<ExecutionRuntimeAdapter>();
  readonly #composed = new Set<string>();
  readonly #compositionWaiters = new Map<string, Array<(ready: boolean) => void>>();
  constructor(
    readonly config: Awaited<ReturnType<typeof loadExecutionInstallationConfig>>["config"],
    readonly dependencies: ExecutionBootstrapDependencies,
    readonly observation: DeliveryObservationEmitter,
    readonly interactions: ProductionInteractionBroker,
    readonly hostOperationFactories: Readonly<Record<string, ProductionHostOperationFactory>>,
  ) {}

  ownerFacts(manifest: DeliveryManifest, activation: RunnerActivationContext): OwnerFactIngress {
    return deliveryOwnerFactIngress(manifest, activation, this.observation);
  }

  async create({ manifest, activation }: Parameters<DeliveryRuntimeFactory["create"]>[0]): Promise<ExecutionRuntimeAdapter> {
    const deliveryRoot = segment(manifest.deliveryId);
    const runnerRoot = path.join(this.config.paths.runner.root, deliveryRoot);
    const config: RunnerFactoryConfig = Object.freeze({
      schemaVersion: "runner.factory@1.0.0",
      stateDirectory: path.join(runnerRoot, "coordinator"),
      custody: Object.freeze({
        recordsDirectory: path.join(runnerRoot, "custody"),
        publication: Object.freeze({
          targetIdentity: `publication.${deliveryRoot}`,
          repositoryPath: manifest.canonicalWorktree,
          ref: `refs/heads/wsr-${deliveryRoot.slice(0, 24)}`,
        }),
      }),
      provider: Object.freeze({
        key: "dsh-headless",
        configuration: Object.freeze({
          providerIdentity: "dsh-headless",
          workspaceDirectory: manifest.canonicalWorktree,
          sessionStorageDirectory: path.join(runnerRoot, "sessions"),
          credentialStore: Object.freeze({ path: this.config.paths.credentialStorePath, watch: false }),
          maxParallelToolCalls: manifest.deliveryConfigProjection.value.runner.provider.maxParallelToolCalls,
        }),
      }),
      invocation: Object.freeze({ journalDirectory: path.join(runnerRoot, "journal") }),
      host: Object.freeze({ engine: "langgraph", checkpointDirectory: path.join(runnerRoot, "checkpoints") }),
      implementationIdentity: manifest.deliveryConfigProjection.value.runner.implementationKey,
    });
    this.interactions.register(manifest.deliveryId, manifest.canonicalWorktree, `${manifest.resolvedPackage.name}@${manifest.resolvedPackage.exactVersion}`);
    const interaction = this.interactions.bridge(manifest.deliveryId);
    const workflow = this.interactions.workflowBridge(manifest.deliveryId);
    const observation = createRunnerOwnerFactPort(Object.freeze({ emit: (fact: RunnerSettlementOwnerFact) => this.observation.emit(fact) }));
    const adapter = await this.#runner.create(config, Object.freeze({
      interaction,
      workflow,
      observation,
      hostOperations: createProductionHostOperationHandlers(activation, this.hostOperationFactories),
    }));
    this.#live.add(adapter);
    this.#composed.add(manifest.deliveryId);
    for (const resolve of this.#compositionWaiters.get(manifest.deliveryId) ?? []) resolve(true);
    this.#compositionWaiters.delete(manifest.deliveryId);
    return adapter;
  }

  async waitForComposition(deliveryId: string, timeoutMs: number): Promise<boolean> {
    if (this.#composed.has(deliveryId)) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => accept(false), timeoutMs);
      const accept = (ready: boolean) => { clearTimeout(timer); resolve(ready); };
      const waiting = this.#compositionWaiters.get(deliveryId) ?? [];
      waiting.push(accept);
      this.#compositionWaiters.set(deliveryId, waiting);
    });
  }

  async close(): Promise<void> {
    for (const waiting of this.#compositionWaiters.values()) for (const resolve of waiting) resolve(false);
    this.#compositionWaiters.clear();
    const adapters = [...this.#live];
    this.#live.clear();
    await Promise.all(adapters.map((adapter) => this.#runner.dispose(adapter).catch(() => undefined)));
  }
}

export interface ExecutionApplicationControl extends WorkflowIntakeControlPort {
  attach(deliveryId: string, correlation: string): void;
  waitForDelivery(correlation: string, timeoutMs: number): Promise<Readonly<{ deliveryId: string; worktree: string }> | undefined>;
  answerAction(request: Readonly<{ correlation: string; prompt: TaskPrompt }>): Promise<ExecutionResult>;
}

const CONTROLS = new WeakMap<ExecutionApplication, ExecutionApplicationControl>();
export function getExecutionApplicationControl(application: ExecutionApplication): ExecutionApplicationControl {
  const control = CONTROLS.get(application);
  if (control === undefined) throw new TypeError("EXECUTION_APPLICATION_CONTROL_UNKNOWN");
  return control;
}

/** The sole production assembly owner. Delivery runtime composition is completed behind this factory. */
export class DefaultExecutionApplicationFactory implements ExecutionApplicationFactory {
  readonly #alternateSources: Readonly<Record<string, AlternateWorkflowPackageSourceFactory>>;
  readonly #hostOperationFactories: Readonly<Record<string, ProductionHostOperationFactory>>;

  constructor(options: DefaultExecutionApplicationFactoryOptions = {}) {
    this.#alternateSources = Object.freeze({ ...(options.alternateSources ?? {}) });
    const contributed = options.hostOperationFactories ?? {};
    for (const key of Object.keys(contributed)) {
      if (STANDARD_HOST_OPERATION_FACTORIES[key] !== undefined) throw new ProductionHostOperationRegistryError(key);
    }
    this.#hostOperationFactories = Object.freeze({ ...STANDARD_HOST_OPERATION_FACTORIES, ...contributed });
  }

  async create(configFile: string, candidateDependencies: ExecutionBootstrapDependencies): Promise<ExecutionApplication> {
    const dependencies = admitExecutionBootstrapDependencies(candidateDependencies);
    const loaded = await loadExecutionInstallationConfig(configFile);
    const config = loaded.config;
    const slots = new CurrentSlotRepository(config.paths.currentSlotRoot);
    const manifests = new DeliveryManifestRepository(config.paths.manifestRoot);
    const recovery = new DeliveryRecoveryService(slots, Object.freeze({
      verify: async (slot: OccupiedCurrentSlot) => {
        const manifest = await manifests.load(slot.manifestPath);
        return manifest.deliveryId === slot.deliveryId
          && manifest.canonicalWorktree === slot.worktree
          && manifest.deliveryBindingIdentity === slot.deliveryBindingIdentity;
      },
    }));
    const admission = new DeliveryAdmissionService(
      slots,
      recovery,
      new ImmediateConcurrencyController(config.controls.maxConcurrentDeliveries),
    );
    const source = createConfiguredWorkflowPackageSource(
      config.workflowSource,
      dependencies.network,
      new WorkflowPackageSourceRegistry(this.#alternateSources),
    );
    const resolver = new WorkflowPackageResolver(
      new WorkflowPackageStore({ readyRoot: config.paths.packageStoreRoot, stagingRoot: config.paths.stagingRoot }),
      source,
      new FrozenWorkflowPackageValidator(COMPATIBILITY),
    );
    const observation = createDeliveryObservationEmitter({
      config: config.observation,
      serviceVersion: "0.1.0",
      diagnostic() {},
    });
    const ownerFacts: OwnerFactIngress = Object.freeze({
      emit() { /* Generic M01 facts are joined to complete per-Delivery facts by the runtime factory. */ },
    });
    const interactions = new ProductionInteractionBroker(dependencies.intake);
    const runtime = new ProductionRuntimeManager(config, dependencies, observation, interactions, this.#hostOperationFactories);
    const delivery = new DeliveryLifecycleService({
      resolver,
      manifests,
      snapshotRoot: `${config.paths.stateRoot}/prompt-snapshots`,
      attachments: dependencies.attachments,
      projector: new DeliveryAdmissionProjector(),
      runtime,
      ownerFacts,
      slots,
      clock: dependencies.clock,
      ids: dependencies.ids,
    });
    const core = new ExecutionCoreAdmission(createExecutionEnvironment(config), admission);
    const lifecycle = new BootstrapLifecycle();
    let startPromise: Promise<void> | undefined;
    let closePromise: Promise<void> | undefined;
    let diagnostic: Readonly<{ code: string; phase: "RECOVERING"; installationIdentity: string }> | undefined;

    const application: ExecutionApplication = Object.freeze({
      start(): Promise<void> {
        if (startPromise !== undefined) return startPromise;
        if (lifecycle.status().state !== "CREATED") return Promise.resolve();
        lifecycle.beginStart();
        startPromise = (async () => {
          try {
            lifecycle.beginRecovery();
            const dispositions = await admission.start();
            for (const disposition of dispositions) {
              const recovery = delivery.recover(disposition.slot);
              const establishment = await Promise.race([
                recovery.then((result) => Object.freeze({ kind: "settled" as const, result })),
                runtime.waitForComposition(disposition.deliveryId, config.controls.startupTimeoutMs)
                  .then((ready) => Object.freeze({ kind: "composition" as const, ready })),
              ]);
              if (establishment.kind === "composition") {
                if (!establishment.ready) throw new Error("DELIVERY_RECOVERY_ESTABLISHMENT_FAILED");
                void recovery.catch(() => undefined);
              } else if (establishment.result.kind === "ERROR" && establishment.result.code !== "RUNNER_START_FAILED") {
                throw new Error("DELIVERY_RECOVERY_ESTABLISHMENT_FAILED");
              }
            }
            if (lifecycle.status().state === "RECOVERING") lifecycle.publishReady();
          } catch {
            diagnostic ??= Object.freeze({
              code: "BOOTSTRAP_RECOVERY_FAILED",
              phase: "RECOVERING" as const,
              installationIdentity: loaded.installationConfigIdentity,
            });
            lifecycle.beginClose();
            await runtime.close();
            await observation.close();
            lifecycle.publishClosed();
            throw new ExecutionBootstrapStartupError();
          }
        })();
        return startPromise;
      },
      async execute(request: ExecutionRequest): Promise<ExecutionResult> {
        const state = lifecycle.status().state;
        if (state !== "READY") return failure(state === "CLOSING" || state === "CLOSED" ? "APPLICATION_CLOSING" : "APPLICATION_NOT_READY");
        const admitted = await core.begin(request);
        if (admitted.kind === "NEW") interactions.expect(admitted.command.canonicalWorktree, admitted.command.intakeCorrelation);
        return admitted.kind === "NEW" ? delivery.activate(admitted) : admitted;
      },
      async inspect(worktree: string): Promise<ExecutionResult> {
        const state = lifecycle.status().state;
        if (state !== "RECOVERING" && state !== "READY") return failure(state === "CLOSING" || state === "CLOSED" ? "APPLICATION_CLOSING" : "APPLICATION_NOT_READY");
        try {
          const slot = await slots.read(worktree);
          return slot.state === "EMPTY"
            ? failure("DELIVERY_UNKNOWN")
            : Object.freeze({ kind: "RECOVERY", worktree: slot.worktree, deliveryId: slot.deliveryId, state: slot.state });
        } catch { return failure("DELIVERY_UNKNOWN"); }
      },
      async cancel(deliveryId: string): Promise<ExecutionResult> {
        const state = lifecycle.status().state;
        if (state !== "READY") return failure(state === "CLOSING" || state === "CLOSED" ? "APPLICATION_CLOSING" : "APPLICATION_NOT_READY");
        try {
          const matches = (await slots.enumerate()).filter((slot) => slot.deliveryId === deliveryId);
          return matches.length === 1 ? delivery.abandon(matches[0]!.worktree, deliveryId) : failure("DELIVERY_UNKNOWN");
        } catch { return failure("DELIVERY_UNKNOWN"); }
      },
      status() {
        const current = lifecycle.status();
        return diagnostic === undefined ? current : Object.freeze({ ...current, diagnostic });
      },
      close(): Promise<void> {
        if (closePromise !== undefined) return closePromise;
        lifecycle.beginClose();
        closePromise = (async () => {
          await startPromise?.catch(() => undefined);
          await runtime.close();
          await observation.close();
          lifecycle.publishClosed();
        })();
        return closePromise;
      },
    });
    const control: ExecutionApplicationControl = Object.freeze({
      async list() {
        const items: IntakeDeliveryInventoryItem[] = [];
        for (const slot of await slots.enumerate()) {
          const manifest = await manifests.load(slot.manifestPath);
          items.push(Object.freeze({
            deliveryId: slot.deliveryId,
            worktree: slot.worktree,
            package: `${manifest.resolvedPackage.name}@${manifest.resolvedPackage.exactVersion}`,
            lifecycle: slot.state,
            intakeBinding: interactions.isBound(slot.deliveryId) ? "BOUND" : "DETACHED",
            action: interactions.pending(slot.deliveryId) ? "AWAITING_INPUT" : "UNKNOWN",
          }));
        }
        return Object.freeze(items);
      },
      async recover(request: Readonly<{ worktree: string; deliveryId?: string; correlation: string }>) {
        const slotsNow = await slots.enumerate();
        const matches = request.deliveryId === undefined
          ? slotsNow.filter((slot) => slot.worktree === request.worktree)
          : slotsNow.filter((slot) => slot.deliveryId === request.deliveryId);
        if (matches.length !== 1) return failure("DELIVERY_UNKNOWN");
        interactions.attach(matches[0]!.deliveryId, request.correlation);
        return Object.freeze({ kind: "RECOVERY", worktree: matches[0]!.worktree, deliveryId: matches[0]!.deliveryId, state: matches[0]!.state });
      },
      async status(request: Readonly<{ worktree?: string; deliveryId?: string; correlation: string }>) {
        const slotsNow = await slots.enumerate();
        const matches = request.deliveryId !== undefined ? slotsNow.filter((slot) => slot.deliveryId === request.deliveryId)
          : request.worktree !== undefined ? slotsNow.filter((slot) => slot.worktree === request.worktree) : [];
        if (matches.length !== 1) return failure("DELIVERY_UNKNOWN");
        return Object.freeze({ kind: "RECOVERY", worktree: matches[0]!.worktree, deliveryId: matches[0]!.deliveryId, state: matches[0]!.state });
      },
      async finishAction(request: Readonly<{ correlation: string; prompt?: TaskPrompt }>) {
        const target = interactions.deliveryForCorrelation(request.correlation);
        if (target === undefined) return failure("DELIVERY_UNKNOWN");
        const accepted = interactions.respond(target.deliveryId, "ACTION_FINISH_REQUESTED", request.prompt ?? Object.freeze({ text: "", attachments: Object.freeze([]) }));
        if (!accepted) return failure("ACTION_NOT_AWAITING_INPUT");
        return application.inspect(target.worktree);
      },
      attach: (deliveryId: string, correlation: string) => interactions.attach(deliveryId, correlation),
      waitForDelivery: (correlation: string, timeoutMs: number) => interactions.waitForDelivery(correlation, timeoutMs),
      async answerAction(request: Readonly<{ correlation: string; prompt: TaskPrompt }>) {
        const target = interactions.deliveryForCorrelation(request.correlation);
        if (target === undefined) return failure("DELIVERY_UNKNOWN");
        const accepted = interactions.respond(target.deliveryId, "ANSWER", request.prompt);
        if (!accepted) return failure("ACTION_NOT_AWAITING_INPUT");
        return application.inspect(target.worktree);
      },
    });
    CONTROLS.set(application, control);
    return application;
  }
}
