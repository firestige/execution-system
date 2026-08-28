import type { ExecutionApplication } from "../application/execution-application.js";
import type { DeliveryConfigProjection, ExecutionInstallationConfig } from "../configuration/index.js";
import type { IntakePresentation } from "../intake/presentation.js";

export type FactoryScope = "INSTALLATION" | "DELIVERY" | "INTAKE_PRESENTATION";

export interface ClockPort { now(): number }
export interface IdPort { create(): string }
export interface FilesystemInspection { readonly kind: "missing" | "file" | "directory" }
export interface FilesystemPort {
  read(path: string, maxBytes?: number): Promise<Uint8Array>;
  writeImmutable(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<readonly string[]>;
  inspect(path: string): Promise<FilesystemInspection>;
}
export interface NetworkResponse { readonly status: number; readonly body: Uint8Array }
export interface NetworkPort { request(url: string): Promise<NetworkResponse> }
export interface IntakePresentationPort { publish(event: IntakePresentation): Promise<void> }

/** Opaque Intake references are dereferenced only by M01 after NEW admission. */
export interface AttachmentContentPort { read(contentRef: string, maxBytes: number): Promise<Uint8Array> }

export interface ExecutionBootstrapDependencies {
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly filesystem: FilesystemPort;
  readonly network: NetworkPort;
  readonly intake: IntakePresentationPort;
  readonly attachments: AttachmentContentPort;
}

export type InstallationSupportDependencies = Readonly<Pick<
  ExecutionBootstrapDependencies,
  "clock" | "ids" | "filesystem" | "network"
>>;

export interface ExecutionApplicationFactory {
  create(configFile: string, dependencies: ExecutionBootstrapDependencies): Promise<ExecutionApplication>;
}

/** Wave 1 contract only; the production implementation is introduced after Module seams exist. */
export interface ExecutionBootstrap extends ExecutionApplicationFactory {}

export interface PersistedDeliveryBinding {
  readonly identity: string;
  readonly deliveryId: string;
  readonly manifestPath: string;
  readonly projection: DeliveryConfigProjection;
}

export interface LifecycleOwnerFact {
  readonly owner: "M01" | "M02";
  readonly name: string;
  readonly occurredAt: number;
  readonly outcome?: "COMPLETED" | "FAILED" | "INCOMPLETE" | "CANCELLED" | "START_FAILED";
}
export interface DeliveryBoundOwnerFact {
  readonly owner: "M01";
  readonly name: "delivery-bound";
  readonly occurredAt: number;
  readonly deliveryId: string;
  readonly taskId: string;
  readonly taskDisplayName?: string;
  readonly deliveryBindingIdentity: string;
  readonly workflowIdentity: string;
  readonly manifestProjection?: string;
  readonly manifestProjectionDigest?: string;
}
export type OwnerFact = LifecycleOwnerFact | DeliveryBoundOwnerFact;
export interface OwnerFactIngress { emit(fact: OwnerFact): void }

export interface InstallationFactoryContext {
  readonly scope: "INSTALLATION";
  readonly config: ExecutionInstallationConfig;
  readonly dependencies: InstallationSupportDependencies;
}

export interface IntakePresentationFactoryContext {
  readonly scope: "INTAKE_PRESENTATION";
  readonly presentation: IntakePresentationPort;
}

/** This value cannot be formed until M01 has durably persisted the binding. */
export interface DeliveryFactoryContext {
  readonly scope: "DELIVERY";
  readonly binding: PersistedDeliveryBinding;
  readonly ownerFacts: OwnerFactIngress;
}

export interface DeliveryObservationContext { readonly ownerFacts: OwnerFactIngress; close(): Promise<void> }
export interface DeliveryRunner { start(): Promise<void>; close(): Promise<void> }
export interface DeliveryObservationFactory { create(context: DeliveryFactoryContext): Promise<DeliveryObservationContext> }
export interface DeliveryRunnerFactory { create(context: DeliveryFactoryContext): Promise<DeliveryRunner> }
export interface DisabledObservationSink extends OwnerFactIngress { readonly kind: "disabled" }

export interface DeliveryServiceFactory {
  create(
    context: InstallationFactoryContext,
    attachmentContent: AttachmentContentPort,
  ): Promise<Readonly<{ close(): Promise<void> }>>;
}
export interface RunnerDependenciesFactory {
  create(context: DeliveryFactoryContext): Promise<Readonly<{ runner: DeliveryRunner; observation: DeliveryObservationContext }>>;
}
export interface HostOperation { execute(input: unknown): Promise<unknown> }
export interface HostOperationFactory {
  admitConfiguration(candidate: unknown): unknown;
  create(configuration: unknown): HostOperation;
}
