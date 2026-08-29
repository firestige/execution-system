import { createHash } from "node:crypto";

import type {
  FrozenJsonSchema,
  FrozenJsonValue,
  InvocationDispatch,
  ManagedInvocationFailure,
} from "../contracts/index.js";
import { canonicalJsonBytes, deepFreeze } from "../configuration/canonical.js";
import type { DeliveryManifestV2, ResolvedRoleModelBinding } from "../delivery/index.js";

export type NativeTurnEvent =
  | Readonly<{ kind: "output"; content: FrozenJsonValue }>
  | Readonly<{
      kind: "input-request";
      requestIdentity: string;
      prompt: FrozenJsonValue;
      responseSchema: FrozenJsonSchema;
    }>
  | Readonly<{ kind: "structured-completion"; result: FrozenJsonValue }>
  | Readonly<{
      kind: "provider-failed";
      code: ManagedInvocationFailure["code"];
      detail: unknown;
    }>
  | Readonly<{
      kind: "provider-uncertain";
      phase: "startup" | "result";
      detail: unknown;
    }>
  | Readonly<{ kind: "turn-ended" | "process-exited" | "session-disposed" }>;

export interface CredentialMaterial {
  readonly [name: string]: string;
}

export interface NativeSessionOpenRequest {
  readonly dispatch: InvocationDispatch;
  readonly credentials: CredentialMaterial;
  readonly signal: AbortSignal;
}

export interface NativeSessionRestoreRequest extends NativeSessionOpenRequest {
  readonly opaqueIdentity: string;
}

export interface NativeProviderSession {
  readonly opaqueIdentity: string;
  run(input: unknown): Promise<readonly NativeTurnEvent[]>;
  persist(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface NativeProviderSessionFactory {
  open(request: NativeSessionOpenRequest): Promise<NativeProviderSession>;
  restore(request: NativeSessionRestoreRequest): Promise<NativeProviderSession>;
}

export interface CredentialLease {
  readonly material: CredentialMaterial;
  release(): Promise<void>;
}

export interface CredentialLeaseBroker {
  acquire(dispatch: InvocationDispatch): Promise<CredentialLease>;
}

export type ProviderAdapterKey = "dsh-headless" | "copilot-sdk" | "codex-cli";

export interface ProviderAdapter<Key extends ProviderAdapterKey = ProviderAdapterKey> {
  readonly key: Key;
  readonly sessions: NativeProviderSessionFactory;
  readonly credentials: CredentialLeaseBroker;
  dispose(): Promise<void>;
}

export interface ProviderAdapterFactory<Key extends ProviderAdapterKey = ProviderAdapterKey, Configuration = unknown> {
  readonly key: Key;
  create(configuration: Configuration): Promise<ProviderAdapter<Key>>;
}

export class ProviderFactorySelectionError extends Error {
  readonly code = "PROVIDER_FACTORY_SELECTION_MISMATCH";

  constructor(readonly provider: string) {
    super(`configured Provider factory does not own '${provider}'`);
    this.name = "ProviderFactorySelectionError";
  }
}

export class ProviderAdapterStartupError extends Error {
  readonly code = "PROVIDER_ADAPTER_STARTUP_FAILED";

  constructor(readonly provider: string, cause: unknown) {
    super(`Provider adapter '${provider}' failed during startup`, { cause });
    this.name = "ProviderAdapterStartupError";
  }
}

export interface ProviderNotImplementedError {
  readonly code: "PROVIDER_NOT_IMPLEMENTED";
}

export function providerNotImplemented(): ProviderNotImplementedError {
  return Object.freeze({ code: "PROVIDER_NOT_IMPLEMENTED" });
}

const IDENTITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ADAPTER_KEYS = new Set<ProviderAdapterKey>(["dsh-headless", "copilot-sdk", "codex-cli"]);

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface AgentProviderFactoryDescriptorDeclaration {
  readonly schemaVersion: "execution.agent-provider-factory@1.0.0";
  readonly identity: string;
  readonly version: string;
  readonly adapterKey: ProviderAdapterKey;
  readonly capabilities: readonly string[];
}

export interface AgentProviderFactoryDescriptor extends AgentProviderFactoryDescriptorDeclaration {
  readonly descriptorDigest: string;
}

export interface AgentProviderReference {
  readonly identity: string;
  readonly version: string;
}

export interface PersistedAgentProviderReference extends AgentProviderReference {
  readonly descriptorDigest: string;
}

export interface AgentProviderDeliveryRealmRequest {
  readonly schemaVersion: "execution.agent-provider-delivery-realm-request@2.0.0";
  readonly deliveryId: string;
  readonly manifestBindingIdentity: string;
  readonly canonicalWorktree: string;
  readonly providerIdentity: string;
  readonly providerVersion: string;
  readonly providerDescriptorDigest: string;
  readonly maxParallelToolCalls: number;
  readonly roleBindings: readonly Readonly<{
    roleId: string;
    modelProviderId: string;
    modelId: string;
  }>[];
}

export interface AgentProviderDeliveryRealmLease {
  readonly schemaVersion: "execution.agent-provider-delivery-realm-lease@2.0.0";
  readonly providerIdentity: string;
  readonly providerVersion: string;
  readonly descriptorDigest: string;
  readonly deliveryId: string;
  readonly manifestBindingIdentity: string;
  readonly adapter: AgentProviderAdapter;
  dispose(): Promise<void>;
}

/**
 * Provider-owned 2.0 session surface. Authentication is intentionally absent:
 * the Provider realm uses its own existing local login state internally.
 */
export interface AgentProviderSessionOpenRequest {
  readonly dispatch: InvocationDispatch;
  readonly signal: AbortSignal;
}

export interface AgentProviderSessionRestoreRequest extends AgentProviderSessionOpenRequest {
  readonly opaqueIdentity: string;
}

export interface AgentProviderSessionFactory {
  open(request: AgentProviderSessionOpenRequest): Promise<NativeProviderSession>;
  restore(request: AgentProviderSessionRestoreRequest): Promise<NativeProviderSession>;
}

export interface AgentProviderAdapter {
  readonly key: ProviderAdapterKey;
  readonly sessions: AgentProviderSessionFactory;
  dispose(): Promise<void>;
}

export interface AgentProviderRealmFactory {
  readonly descriptor: AgentProviderFactoryDescriptorDeclaration;
  acquire(request: AgentProviderDeliveryRealmRequest): Promise<AgentProviderDeliveryRealmLease>;
}

export type AgentProviderRegistryErrorCode =
  | "PROVIDER_FACTORY_REGISTRATION_INVALID"
  | "PROVIDER_FACTORY_DUPLICATE"
  | "PROVIDER_FACTORY_UNKNOWN"
  | "PROVIDER_FACTORY_VERSION_MISMATCH"
  | "PROVIDER_FACTORY_CAPABILITY_MISMATCH"
  | "PROVIDER_FACTORY_DESCRIPTOR_MISMATCH";

export class AgentProviderRegistryError extends Error {
  constructor(readonly code: AgentProviderRegistryErrorCode, readonly providerIdentity?: string) {
    super(code);
    this.name = "AgentProviderRegistryError";
  }
}

function ownData(value: unknown, keys: readonly string[], frozen = true): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (frozen && !Object.isFrozen(value)) return undefined;
  const actual = Reflect.ownKeys(value);
  if (!actual.every((key): key is string => typeof key === "string")
    || [...actual].sort().join(",") !== [...keys].sort().join(",")) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function canonicalDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")}`;
}

function captureFactory(candidate: AgentProviderRealmFactory): Readonly<{
  descriptor: AgentProviderFactoryDescriptor;
  acquire: AgentProviderRealmFactory["acquire"];
}> {
  const root = ownData(candidate, ["descriptor", "acquire"]);
  const descriptor = ownData(root?.descriptor, ["schemaVersion", "identity", "version", "adapterKey", "capabilities"]);
  if (root === undefined || descriptor === undefined || typeof root.acquire !== "function"
    || descriptor.schemaVersion !== "execution.agent-provider-factory@1.0.0"
    || typeof descriptor.identity !== "string" || !IDENTITY.test(descriptor.identity)
    || typeof descriptor.version !== "string" || !VERSION.test(descriptor.version)
    || typeof descriptor.adapterKey !== "string" || !ADAPTER_KEYS.has(descriptor.adapterKey as ProviderAdapterKey)
    || !Array.isArray(descriptor.capabilities) || !Object.isFrozen(descriptor.capabilities)
    || descriptor.capabilities.some((capability) => typeof capability !== "string" || !IDENTITY.test(capability))
    || new Set(descriptor.capabilities).size !== descriptor.capabilities.length) {
    throw new AgentProviderRegistryError("PROVIDER_FACTORY_REGISTRATION_INVALID");
  }
  const declaration = deepFreeze({
    schemaVersion: "execution.agent-provider-factory@1.0.0" as const,
    identity: descriptor.identity,
    version: descriptor.version,
    adapterKey: descriptor.adapterKey as ProviderAdapterKey,
    capabilities: [...descriptor.capabilities].sort() as string[],
  });
  return Object.freeze({
    descriptor: deepFreeze({ ...declaration, descriptorDigest: canonicalDigest(declaration as unknown as JsonValue) }),
    acquire: (root.acquire as AgentProviderRealmFactory["acquire"]).bind(candidate),
  });
}

export class AgentProviderFactoryRegistry {
  readonly #factories: ReadonlyMap<string, ReturnType<typeof captureFactory>>;
  readonly #descriptors: readonly AgentProviderFactoryDescriptor[];

  constructor(factories: readonly AgentProviderRealmFactory[]) {
    if (!Array.isArray(factories)) throw new AgentProviderRegistryError("PROVIDER_FACTORY_REGISTRATION_INVALID");
    const captured = new Map<string, ReturnType<typeof captureFactory>>();
    for (const candidate of factories) {
      const factory = captureFactory(candidate);
      if (captured.has(factory.descriptor.identity)) {
        throw new AgentProviderRegistryError("PROVIDER_FACTORY_DUPLICATE", factory.descriptor.identity);
      }
      captured.set(factory.descriptor.identity, factory);
    }
    this.#factories = captured;
    this.#descriptors = deepFreeze([...captured.values()].map(({ descriptor }) => descriptor)
      .sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
  }

  descriptors(): readonly AgentProviderFactoryDescriptor[] {
    return this.#descriptors;
  }

  admit(reference: AgentProviderReference, requiredCapabilities: readonly string[]): AgentProviderFactoryDescriptor {
    if (!IDENTITY.test(reference.identity)) throw new AgentProviderRegistryError("PROVIDER_FACTORY_UNKNOWN", reference.identity);
    const factory = this.#factories.get(reference.identity);
    if (factory === undefined) throw new AgentProviderRegistryError("PROVIDER_FACTORY_UNKNOWN", reference.identity);
    if (factory.descriptor.version !== reference.version) {
      throw new AgentProviderRegistryError("PROVIDER_FACTORY_VERSION_MISMATCH", reference.identity);
    }
    if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((capability) => !factory.descriptor.capabilities.includes(capability))) {
      throw new AgentProviderRegistryError("PROVIDER_FACTORY_CAPABILITY_MISMATCH", reference.identity);
    }
    return factory.descriptor;
  }

  recover(reference: PersistedAgentProviderReference): AgentProviderFactoryDescriptor {
    const descriptor = this.admit(reference, []);
    if (!SHA256.test(reference.descriptorDigest) || descriptor.descriptorDigest !== reference.descriptorDigest) {
      throw new AgentProviderRegistryError("PROVIDER_FACTORY_DESCRIPTOR_MISMATCH", reference.identity);
    }
    return descriptor;
  }

  factory(identity: string): Readonly<{ descriptor: AgentProviderFactoryDescriptor; acquire: AgentProviderRealmFactory["acquire"] }> {
    const factory = this.#factories.get(identity);
    if (factory === undefined) throw new AgentProviderRegistryError("PROVIDER_FACTORY_UNKNOWN", identity);
    return factory;
  }
}

export type DeliveryAgentProviderRealmErrorCode =
  | "DELIVERY_REALM_MANIFEST_MISMATCH"
  | "DELIVERY_REALM_PROVIDER_MISMATCH"
  | "DELIVERY_REALM_ACQUIRE_FAILED"
  | "DELIVERY_REALM_LEASE_INVALID"
  | "DELIVERY_REALM_ROLE_UNKNOWN";

export class DeliveryAgentProviderRealmError extends Error {
  constructor(readonly code: DeliveryAgentProviderRealmErrorCode) {
    super(code);
    this.name = "DeliveryAgentProviderRealmError";
  }
}

export interface DeliveryAgentProviderRealmSet {
  forRole(roleId: string): AgentProviderAdapter;
  dispose(): Promise<void>;
}

function exactRealmLease(value: unknown, request: AgentProviderDeliveryRealmRequest, descriptor: AgentProviderFactoryDescriptor): value is AgentProviderDeliveryRealmLease {
  const lease = ownData(value, ["schemaVersion", "providerIdentity", "providerVersion", "descriptorDigest", "deliveryId", "manifestBindingIdentity", "adapter", "dispose"]);
  if (lease === undefined || lease.schemaVersion !== "execution.agent-provider-delivery-realm-lease@2.0.0"
    || lease.providerIdentity !== descriptor.identity || lease.providerVersion !== descriptor.version
    || lease.descriptorDigest !== descriptor.descriptorDigest || lease.deliveryId !== request.deliveryId
    || lease.manifestBindingIdentity !== request.manifestBindingIdentity || typeof lease.dispose !== "function") return false;
  const adapter = lease.adapter as AgentProviderAdapter | undefined;
  return adapter !== undefined && adapter !== null && typeof adapter === "object" && adapter.key === descriptor.adapterKey
    && typeof adapter.dispose === "function" && typeof adapter.sessions?.open === "function"
    && typeof adapter.sessions.restore === "function" && !("credentials" in adapter);
}

async function disposeUnknown(value: unknown): Promise<void> {
  if (value !== null && typeof value === "object" && typeof (value as { dispose?: unknown }).dispose === "function") {
    await (value as { dispose(): Promise<void> }).dispose().catch(() => undefined);
  }
}

export class DeliveryAgentProviderRealmBroker {
  readonly #publishedLeases = new WeakSet<object>();

  constructor(readonly registry: AgentProviderFactoryRegistry) {}

  async acquire(manifest: DeliveryManifestV2, persistedManifestBindingIdentity: string): Promise<DeliveryAgentProviderRealmSet> {
    if (manifest.schemaVersion !== "execution.delivery-manifest@2.0.0" || !SHA256.test(manifest.deliveryBindingIdentity)
      || manifest.deliveryBindingIdentity !== persistedManifestBindingIdentity) {
      throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_MANIFEST_MISMATCH");
    }
    const grouped = new Map<string, ResolvedRoleModelBinding[]>();
    try {
      for (const role of manifest.resolvedRoles) {
        const descriptor = this.registry.recover({
          identity: role.agentProviderId,
          version: role.agentProviderVersion,
          descriptorDigest: role.agentProviderDescriptorDigest,
        });
        if (descriptor.adapterKey !== role.agentProviderAdapterKey) throw new Error("adapter mismatch");
        const roles = grouped.get(role.agentProviderId) ?? [];
        roles.push(role);
        grouped.set(role.agentProviderId, roles);
      }
    } catch {
      throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_PROVIDER_MISMATCH");
    }

    const leases = new Map<string, AgentProviderDeliveryRealmLease>();
    const adaptersByRole = new Map<string, AgentProviderAdapter>();
    try {
      for (const providerIdentity of [...grouped.keys()].sort()) {
        const roles = grouped.get(providerIdentity)!;
        const factory = this.registry.factory(providerIdentity);
        const request = deepFreeze({
          schemaVersion: "execution.agent-provider-delivery-realm-request@2.0.0" as const,
          deliveryId: manifest.deliveryId,
          manifestBindingIdentity: manifest.deliveryBindingIdentity,
          canonicalWorktree: manifest.canonicalWorktree,
          providerIdentity: factory.descriptor.identity,
          providerVersion: factory.descriptor.version,
          providerDescriptorDigest: factory.descriptor.descriptorDigest,
          maxParallelToolCalls: manifest.deliveryConfigProjection.value.runner.maxParallelToolCalls,
          roleBindings: roles.map((role) => ({ roleId: role.roleId, modelProviderId: role.modelProviderId, modelId: role.modelId })),
        });
        let candidate: unknown;
        try { candidate = await factory.acquire(request); }
        catch { throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_ACQUIRE_FAILED"); }
        if (candidate !== null && typeof candidate === "object" && this.#publishedLeases.has(candidate)) {
          throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_LEASE_INVALID");
        }
        if (!exactRealmLease(candidate, request, factory.descriptor)) {
          await disposeUnknown(candidate);
          throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_LEASE_INVALID");
        }
        this.#publishedLeases.add(candidate);
        leases.set(providerIdentity, candidate);
        for (const role of roles) adaptersByRole.set(role.roleId, candidate.adapter);
      }
    } catch (cause) {
      await Promise.all([...leases.values()].map((lease) => lease.dispose().catch(() => undefined)));
      if (cause instanceof DeliveryAgentProviderRealmError) throw cause;
      throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_ACQUIRE_FAILED");
    }

    let disposed = false;
    return Object.freeze({
      forRole(roleId: string): AgentProviderAdapter {
        const adapter = adaptersByRole.get(roleId);
        if (adapter === undefined) throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_ROLE_UNKNOWN");
        return adapter;
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await Promise.all([...leases.values()].map((lease) => lease.dispose()));
      },
    });
  }
}
