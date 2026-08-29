import { describe, expect, it, vi } from "vitest";

import type { DeliveryManifestV2 } from "../../src/delivery/index.js";
import {
  AgentProviderFactoryRegistry,
  DeliveryAgentProviderRealmBroker,
  type AgentProviderRealmFactory,
  type ProviderAdapterKey,
} from "../../src/providers/provider.js";

const sha = (character: string): string => `sha256:${character.repeat(64)}`;

function provider(
  identity: string,
  version: string,
  adapterKey: ProviderAdapterKey,
  capabilities: readonly string[],
) {
  const dispose = vi.fn(async () => undefined);
  const acquire = vi.fn(async (request) => Object.freeze({
    schemaVersion: "execution.agent-provider-delivery-realm-lease@2.0.0" as const,
    providerIdentity: identity,
    providerVersion: version,
    descriptorDigest: request.providerDescriptorDigest,
    deliveryId: request.deliveryId,
    manifestBindingIdentity: request.manifestBindingIdentity,
    adapter: Object.freeze({
      key: adapterKey,
      sessions: Object.freeze({ open: vi.fn(), restore: vi.fn() }),
      dispose: vi.fn(async () => undefined),
    }),
    dispose,
  }));
  const factory: AgentProviderRealmFactory = Object.freeze({
    descriptor: Object.freeze({
      schemaVersion: "execution.agent-provider-factory@1.0.0",
      identity,
      version,
      adapterKey,
      capabilities: Object.freeze([...capabilities]),
    }),
    acquire,
  });
  return { factory, acquire, dispose };
}

function manifest(registry: AgentProviderFactoryRegistry): DeliveryManifestV2 {
  const dsh = registry.admit({ identity: "provider.dsh", version: "0.1.1-rc.2" }, ["structured-completion"]);
  const codex = registry.admit({ identity: "provider.codex", version: "0.144.5" }, ["structured-completion"]);
  return Object.freeze({
    schemaVersion: "execution.delivery-manifest@2.0.0",
    deliveryId: "delivery-1",
    taskId: "task-1",
    createdAt: 1,
    canonicalWorktree: "/workspace/repository",
    workflowPackage: Object.freeze({ name: "system-design", exactVersion: "2.0.0", packageDigest: sha("1"), localMaterializationPath: "/state/packages/system-design/2.0.0" }),
    workflowSnapshot: Object.freeze({ workflowId: "workflow.system-design", workflowVersion: "2.0.0", snapshotId: "snapshot.system-design.2", snapshotDigest: sha("2") }),
    repositoryModelBindings: Object.freeze({ documentState: "PRESENT", documentDigest: sha("3"), resolvedMapDigest: sha("4") }),
    resolvedRoles: Object.freeze([
      Object.freeze({ roleId: "role.facilitator", rolePromptIdentity: "role.prompt.facilitator", rolePromptDigest: sha("5"), agentProviderId: dsh.identity, agentProviderVersion: dsh.version, agentProviderAdapterKey: dsh.adapterKey, agentProviderDescriptorDigest: dsh.descriptorDigest, requiredCapabilities: Object.freeze(["structured-completion"]), modelProviderId: "deepseek-official", modelId: "deepseek-chat", resolutionSource: "REPOSITORY" as const }),
      Object.freeze({ roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("6"), agentProviderId: codex.identity, agentProviderVersion: codex.version, agentProviderAdapterKey: codex.adapterKey, agentProviderDescriptorDigest: codex.descriptorDigest, requiredCapabilities: Object.freeze(["structured-completion"]), modelProviderId: "openai", modelId: "gpt-5.3-codex", resolutionSource: "REPOSITORY" as const }),
    ]),
    prompt: Object.freeze({ taskPromptIdentity: sha("7"), snapshotIdentity: sha("7"), snapshotDigest: sha("8"), snapshotPath: "/state/prompts/delivery-1" }),
    deliveryConfigProjection: Object.freeze({
      value: Object.freeze({
        schemaVersion: "execution.delivery-config@2.0.0",
        paths: Object.freeze({ repositoryRoot: "/repository", workspaceRoot: "/workspace", allowedWorktreeRoots: Object.freeze(["/workspace"]), runnerResources: Object.freeze({ journal: "runner/journal", checkpoints: "runner/checkpoints", sessions: "runner/sessions", custody: "runner/custody" }) }),
        runner: Object.freeze({ implementationKey: "runner.v2", host: Object.freeze({ engine: "langgraph" }), maxParallelToolCalls: 4 }),
        controls: Object.freeze({ executionTimeoutMs: 1000, maxConcurrentDeliveries: 2, allowExplicitRefresh: false }),
      }),
      identity: sha("9"),
    }),
    deliveryBindingIdentity: sha("a"),
  });
}

describe("multi-Provider Delivery realm broker", () => {
  it("acquires only Providers used by the Manifest and routes each Role exactly", async () => {
    const dsh = provider("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["structured-completion"]);
    const codex = provider("provider.codex", "0.144.5", "codex-cli", ["structured-completion"]);
    const unused = provider("provider.copilot", "1.0.78", "copilot-sdk", ["structured-completion"]);
    const registry = new AgentProviderFactoryRegistry([dsh.factory, codex.factory, unused.factory]);
    const exactManifest = manifest(registry);

    const realms = await new DeliveryAgentProviderRealmBroker(registry).acquire(exactManifest, exactManifest.deliveryBindingIdentity);

    expect(dsh.acquire).toHaveBeenCalledOnce();
    expect(codex.acquire).toHaveBeenCalledOnce();
    expect(unused.acquire).not.toHaveBeenCalled();
    for (const request of [dsh.acquire.mock.calls[0]![0], codex.acquire.mock.calls[0]![0]]) {
      const serialized = JSON.stringify(request).toLowerCase();
      for (const prohibited of ["credential", "token", "apikey", "loginstate", "endpoint"]) expect(serialized).not.toContain(prohibited);
    }
    expect(realms.forRole("role.facilitator").key).toBe("dsh-headless");
    expect(realms.forRole("role.reviewer").key).toBe("codex-cli");
    expect(realms.forRole("role.reviewer")).not.toHaveProperty("credentials");
    expect(() => realms.forRole("role.unknown")).toThrowError(expect.objectContaining({ code: "DELIVERY_REALM_ROLE_UNKNOWN" }));
    await realms.dispose();
    await realms.dispose();
    expect(dsh.dispose).toHaveBeenCalledOnce();
    expect(codex.dispose).toHaveBeenCalledOnce();
  });

  it("recovery requires the persisted factory version, descriptor, adapter, and manifest identity exactly", async () => {
    const dsh = provider("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["structured-completion"]);
    const codex = provider("provider.codex", "0.144.5", "codex-cli", ["structured-completion"]);
    const original = new AgentProviderFactoryRegistry([dsh.factory, codex.factory]);
    const exactManifest = manifest(original);
    const changedCodex = provider("provider.codex", "0.144.5", "codex-cli", ["action-interaction", "structured-completion"]);
    const changedRegistry = new AgentProviderFactoryRegistry([dsh.factory, changedCodex.factory]);

    await expect(new DeliveryAgentProviderRealmBroker(changedRegistry).acquire(exactManifest, exactManifest.deliveryBindingIdentity))
      .rejects.toMatchObject({ code: "DELIVERY_REALM_PROVIDER_MISMATCH" });
    expect(dsh.acquire).not.toHaveBeenCalled();
    expect(changedCodex.acquire).not.toHaveBeenCalled();

    await expect(new DeliveryAgentProviderRealmBroker(original).acquire(exactManifest, sha("f")))
      .rejects.toMatchObject({ code: "DELIVERY_REALM_MANIFEST_MISMATCH" });
  });

  it("rolls back already acquired realms when a later Provider fails", async () => {
    const codex = provider("provider.codex", "0.144.5", "codex-cli", ["structured-completion"]);
    const dsh = provider("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["structured-completion"]);
    dsh.acquire.mockRejectedValueOnce(new Error("provider unavailable"));
    const registry = new AgentProviderFactoryRegistry([codex.factory, dsh.factory]);
    const exactManifest = manifest(registry);

    await expect(new DeliveryAgentProviderRealmBroker(registry).acquire(exactManifest, exactManifest.deliveryBindingIdentity))
      .rejects.toMatchObject({ code: "DELIVERY_REALM_ACQUIRE_FAILED" });
    expect(codex.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a factory that republishes a previously leased realm", async () => {
    const dsh = provider("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["structured-completion"]);
    const codex = provider("provider.codex", "0.144.5", "codex-cli", ["structured-completion"]);
    const registry = new AgentProviderFactoryRegistry([dsh.factory, codex.factory]);
    const exactManifest = manifest(registry);
    const broker = new DeliveryAgentProviderRealmBroker(registry);
    const first = await broker.acquire(exactManifest, exactManifest.deliveryBindingIdentity);
    const priorCodexLease = await codex.acquire.mock.results[0]!.value;
    codex.acquire.mockResolvedValue(priorCodexLease);

    await expect(broker.acquire(exactManifest, exactManifest.deliveryBindingIdentity))
      .rejects.toMatchObject({ code: "DELIVERY_REALM_LEASE_INVALID" });
    await first.dispose();
    expect(codex.dispose).toHaveBeenCalledOnce();
  });
});
