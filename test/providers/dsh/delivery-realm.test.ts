import { describe, expect, it, vi } from "vitest";

import {
  DeliveryAgentProviderRealmBroker,
  DeliveryAgentProviderRealmError,
  type DeliveryAgentProviderRealmFactory,
} from "../../../src/providers/dsh/index.js";
import type { DeliveryManifestV2 } from "../../../src/delivery/index.js";

const sha = (character: string): string => `sha256:${character.repeat(64)}`;

function manifest(deliveryId = "delivery-1"): DeliveryManifestV2 {
  return Object.freeze({
    schemaVersion: "execution.delivery-manifest@2.0.0",
    deliveryId,
    taskId: "task-1",
    createdAt: 1,
    canonicalWorktree: "/workspace/repository",
    workflowPackage: Object.freeze({ name: "system-design", exactVersion: "2.0.0", packageDigest: sha("1"), localMaterializationPath: "/state/packages/system-design/2.0.0" }),
    workflowSnapshot: Object.freeze({ workflowId: "workflow.system-design", workflowVersion: "2.0.0", snapshotId: "snapshot.system-design.2", snapshotDigest: sha("2") }),
    repositoryModelBindings: Object.freeze({ documentState: "ABSENT", resolvedMapDigest: sha("3") }),
    resolvedRoles: Object.freeze([
      Object.freeze({ roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("4"), agentProviderId: "provider.dsh", modelProviderId: "deepseek-official", modelId: "deepseek-chat", resolutionSource: "EXECUTION_DEFAULT" as const }),
    ]),
    prompt: Object.freeze({ taskPromptIdentity: sha("5"), snapshotIdentity: sha("5"), snapshotDigest: sha("6"), snapshotPath: "/state/prompts/delivery-1" }),
    deliveryConfigProjection: Object.freeze({
      value: Object.freeze({
        schemaVersion: "execution.delivery-config@2.0.0",
        paths: Object.freeze({ repositoryRoot: "/repository", workspaceRoot: "/workspace", allowedWorktreeRoots: Object.freeze(["/workspace"]), runnerResources: Object.freeze({ journal: "runner/journal", checkpoints: "runner/checkpoints", sessions: "runner/sessions", custody: "runner/custody" }) }),
        runner: Object.freeze({ implementationKey: "runner.v2", host: Object.freeze({ engine: "langgraph" }), provider: Object.freeze({ identity: "provider.dsh", maxParallelToolCalls: 4 }) }),
        controls: Object.freeze({ executionTimeoutMs: 1000, maxConcurrentDeliveries: 2, allowExplicitRefresh: false }),
      }),
      identity: sha("7"),
    }),
    deliveryBindingIdentity: sha("8"),
  });
}

function factory(overrides: Partial<DeliveryAgentProviderRealmFactory> = {}) {
  const dispose = vi.fn(async () => undefined);
  const acquire = vi.fn(async (request) => Object.freeze({
    schemaVersion: "execution.agent-provider-delivery-realm-lease@1.0.0" as const,
    agentProviderIdentity: "provider.dsh",
    deliveryId: request.deliveryId,
    manifestBindingIdentity: request.manifestBindingIdentity,
    provider: Object.freeze({
      key: "dsh-headless" as const,
      sessions: Object.freeze({ open: vi.fn(), restore: vi.fn() }),
      credentials: Object.freeze({ acquire: vi.fn() }),
      dispose: vi.fn(async () => undefined),
    }) as never,
    dispose,
  }));
  return { factory: Object.freeze({ agentProviderIdentity: "provider.dsh", acquire, ...overrides }) as DeliveryAgentProviderRealmFactory, acquire, dispose };
}

describe("DSH-owned Delivery realm lease boundary", () => {
  it("requests one isolated realm only from a matching supplied factory after exact Manifest persistence", async () => {
    const dsh = factory();
    const exactManifest = manifest();
    const broker = new DeliveryAgentProviderRealmBroker(dsh.factory);

    const lease = await broker.acquire(exactManifest, exactManifest.deliveryBindingIdentity);

    expect(dsh.acquire).toHaveBeenCalledOnce();
    expect(dsh.acquire).toHaveBeenCalledWith({
      schemaVersion: "execution.agent-provider-delivery-realm-request@1.0.0",
      deliveryId: "delivery-1",
      manifestBindingIdentity: exactManifest.deliveryBindingIdentity,
      canonicalWorktree: exactManifest.canonicalWorktree,
      agentProviderIdentity: "provider.dsh",
      maxParallelToolCalls: 4,
    });
    const request = JSON.stringify(dsh.acquire.mock.calls[0]![0]);
    for (const forbidden of ["credential", "baseUrl", "endpoint", "profile", "apiKey", "token", "defaultModel"]) expect(request).not.toContain(forbidden);
    await lease.dispose();
    await lease.dispose();
    expect(dsh.dispose).toHaveBeenCalledOnce();
  });

  it("creates distinct leases for distinct Deliveries and never shares a prior realm", async () => {
    const dsh = factory();
    const broker = new DeliveryAgentProviderRealmBroker(dsh.factory);
    const left = manifest("delivery-left");
    const right = manifest("delivery-right");

    const [leftLease, rightLease] = await Promise.all([
      broker.acquire(left, left.deliveryBindingIdentity),
      broker.acquire(right, right.deliveryBindingIdentity),
    ]);

    expect(dsh.acquire).toHaveBeenCalledTimes(2);
    expect(leftLease).not.toBe(rightLease);
  });

  it("fails before factory effect for an unpersisted/mismatched Manifest identity or factory identity", async () => {
    const dsh = factory();
    const exactManifest = manifest();
    await expect(new DeliveryAgentProviderRealmBroker(dsh.factory).acquire(exactManifest, sha("9")))
      .rejects.toMatchObject({ code: "DELIVERY_REALM_MANIFEST_MISMATCH" });
    expect(dsh.acquire).not.toHaveBeenCalled();

    const wrongFactory = factory({ agentProviderIdentity: "provider.other" });
    await expect(new DeliveryAgentProviderRealmBroker(wrongFactory.factory).acquire(exactManifest, exactManifest.deliveryBindingIdentity))
      .rejects.toMatchObject({ code: "DELIVERY_REALM_PROVIDER_MISMATCH" });
    expect(wrongFactory.acquire).not.toHaveBeenCalled();
  });

  it("rejects a malformed or cross-Delivery lease and disposes it without publishing", async () => {
    const dispose = vi.fn(async () => undefined);
    const dsh = factory({
      acquire: vi.fn(async () => Object.freeze({
        schemaVersion: "execution.agent-provider-delivery-realm-lease@1.0.0",
        agentProviderIdentity: "provider.dsh",
        deliveryId: "delivery-other",
        manifestBindingIdentity: sha("8"),
        provider: Object.freeze({}),
        dispose,
      })) as never,
    });
    const exactManifest = manifest();

    await expect(new DeliveryAgentProviderRealmBroker(dsh.factory).acquire(exactManifest, exactManifest.deliveryBindingIdentity))
      .rejects.toBeInstanceOf(DeliveryAgentProviderRealmError);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
