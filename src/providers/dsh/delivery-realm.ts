import type { DeliveryManifestV2 } from "../../delivery/index.js";
import type { ProviderAdapter } from "../provider.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export type DeliveryAgentProviderRealmErrorCode =
  | "DELIVERY_REALM_MANIFEST_MISMATCH"
  | "DELIVERY_REALM_PROVIDER_MISMATCH"
  | "DELIVERY_REALM_ACQUIRE_FAILED"
  | "DELIVERY_REALM_LEASE_INVALID";

export class DeliveryAgentProviderRealmError extends Error {
  constructor(readonly code: DeliveryAgentProviderRealmErrorCode) {
    super(code);
    this.name = "DeliveryAgentProviderRealmError";
  }
}

export interface DeliveryAgentProviderRealmRequest {
  readonly schemaVersion: "execution.agent-provider-delivery-realm-request@1.0.0";
  readonly deliveryId: string;
  readonly manifestBindingIdentity: string;
  readonly canonicalWorktree: string;
  readonly agentProviderIdentity: string;
  readonly maxParallelToolCalls: number;
}

export interface DeliveryAgentProviderRealmLease {
  readonly schemaVersion: "execution.agent-provider-delivery-realm-lease@1.0.0";
  readonly agentProviderIdentity: string;
  readonly deliveryId: string;
  readonly manifestBindingIdentity: string;
  readonly provider: ProviderAdapter<"dsh-headless">;
  dispose(): Promise<void>;
}

export interface DeliveryAgentProviderRealmFactory {
  readonly agentProviderIdentity: string;
  acquire(request: DeliveryAgentProviderRealmRequest): Promise<DeliveryAgentProviderRealmLease>;
}

function exactLease(value: unknown, manifest: DeliveryManifestV2): value is DeliveryAgentProviderRealmLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  if (Object.keys(lease).sort().join(",") !== "agentProviderIdentity,deliveryId,dispose,manifestBindingIdentity,provider,schemaVersion"
    || lease.schemaVersion !== "execution.agent-provider-delivery-realm-lease@1.0.0"
    || lease.agentProviderIdentity !== manifest.deliveryConfigProjection.value.runner.provider.identity
    || lease.deliveryId !== manifest.deliveryId || lease.manifestBindingIdentity !== manifest.deliveryBindingIdentity
    || typeof lease.dispose !== "function" || lease.provider === null || typeof lease.provider !== "object") return false;
  const provider = lease.provider as Record<string, unknown>;
  const sessions = provider.sessions as Record<string, unknown> | undefined;
  const credentials = provider.credentials as Record<string, unknown> | undefined;
  return provider.key === "dsh-headless" && typeof provider.dispose === "function"
    && sessions !== undefined && typeof sessions.open === "function" && typeof sessions.restore === "function"
    && credentials !== undefined && typeof credentials.acquire === "function";
}

async function disposeMalformed(value: unknown): Promise<void> {
  if (value !== null && typeof value === "object" && typeof (value as { dispose?: unknown }).dispose === "function") {
    await ((value as { dispose(): Promise<void> }).dispose()).catch(() => undefined);
  }
}

export class DeliveryAgentProviderRealmBroker {
  readonly #published = new WeakSet<object>();

  constructor(readonly factory: DeliveryAgentProviderRealmFactory) {}

  async acquire(manifest: DeliveryManifestV2, persistedManifestBindingIdentity: string): Promise<DeliveryAgentProviderRealmLease> {
    if (manifest.schemaVersion !== "execution.delivery-manifest@2.0.0"
      || !SHA256.test(manifest.deliveryBindingIdentity)
      || persistedManifestBindingIdentity !== manifest.deliveryBindingIdentity) {
      throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_MANIFEST_MISMATCH");
    }
    const providerIdentity = manifest.deliveryConfigProjection.value.runner.provider.identity;
    if (!IDENTITY.test(this.factory.agentProviderIdentity) || this.factory.agentProviderIdentity !== providerIdentity
      || manifest.resolvedRoles.some((role) => role.agentProviderId !== providerIdentity)) {
      throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_PROVIDER_MISMATCH");
    }
    const request: DeliveryAgentProviderRealmRequest = Object.freeze({
      schemaVersion: "execution.agent-provider-delivery-realm-request@1.0.0",
      deliveryId: manifest.deliveryId,
      manifestBindingIdentity: manifest.deliveryBindingIdentity,
      canonicalWorktree: manifest.canonicalWorktree,
      agentProviderIdentity: providerIdentity,
      maxParallelToolCalls: manifest.deliveryConfigProjection.value.runner.provider.maxParallelToolCalls,
    });
    let candidate: unknown;
    try { candidate = await this.factory.acquire(request); }
    catch { throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_ACQUIRE_FAILED"); }
    if (!exactLease(candidate, manifest) || this.#published.has(candidate as object)) {
      await disposeMalformed(candidate);
      throw new DeliveryAgentProviderRealmError("DELIVERY_REALM_LEASE_INVALID");
    }
    this.#published.add(candidate);
    let disposed = false;
    return Object.freeze({
      schemaVersion: candidate.schemaVersion,
      agentProviderIdentity: candidate.agentProviderIdentity,
      deliveryId: candidate.deliveryId,
      manifestBindingIdentity: candidate.manifestBindingIdentity,
      provider: candidate.provider,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await candidate.dispose();
      },
    });
  }
}
