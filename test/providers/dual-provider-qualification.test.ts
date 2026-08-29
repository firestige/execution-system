import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { qualifyDualProviderDelivery, qualifyTemporaryDualProviderDelivery } from "../../scripts/qualify-dual-agent-providers.js";
import type {
  AgentProviderDeliveryRealmRequest,
  AgentProviderRealmFactory,
  AgentProviderSessionOpenRequest,
  NativeProviderSession,
  ProviderAdapterKey,
} from "../../src/providers/provider.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

type Scenario = "success" | "acquire-failed" | "open-failed" | "provider-failed" | "startup-uncertain" | "completion-missing" | "completion-multiple" | "result-not-object" | "result-keys-inexact" | "result-roleId-inexact" | "persist-failed" | "session-teardown-failed" | "realm-teardown-failed";
function provider(identity: "provider.copilot" | "provider.codex", version: "1.0.78" | "0.144.5", key: ProviderAdapterKey, scenario: Scenario = "success") {
  const acquired: AgentProviderDeliveryRealmRequest[] = [];
  const openedRoles: string[] = [];
  const sessionDispose = vi.fn(async () => undefined);
  const realmDispose = vi.fn(async () => undefined);
  const factory: AgentProviderRealmFactory = Object.freeze({
    descriptor: Object.freeze({
      schemaVersion: "execution.agent-provider-factory@1.0.0" as const,
      identity,
      version,
      adapterKey: key,
      capabilities: Object.freeze(["structured-completion"]),
    }),
    async acquire(request: AgentProviderDeliveryRealmRequest) {
      if (scenario === "acquire-failed") throw new Error("fixture acquire failure");
      acquired.push(request);
      return Object.freeze({
        schemaVersion: "execution.agent-provider-delivery-realm-lease@2.0.0" as const,
        providerIdentity: identity,
        providerVersion: version,
        descriptorDigest: request.providerDescriptorDigest,
        deliveryId: request.deliveryId,
        manifestBindingIdentity: request.manifestBindingIdentity,
        adapter: Object.freeze({
          key,
          sessions: Object.freeze({
            async open({ dispatch }: AgentProviderSessionOpenRequest) {
              if (scenario === "open-failed") throw new Error("fixture open failure");
              openedRoles.push(dispatch.executor.session.roleIdentity);
              const session: NativeProviderSession = Object.freeze({
                opaqueIdentity: `${identity}:${dispatch.executor.session.roleIdentity}`,
                async run() {
                  if (scenario === "provider-failed") return Object.freeze([{ kind: "provider-failed" as const, code: "PROVIDER_EXITED" as const, detail: {} }]);
                  if (scenario === "startup-uncertain") return Object.freeze([{ kind: "provider-uncertain" as const, phase: "startup" as const, detail: {} }]);
                  if (scenario === "completion-missing") return Object.freeze([{ kind: "turn-ended" as const }]);
                  const result = identity === "provider.codex"
                    ? Object.freeze({ providerIdentity: identity, roleId: dispatch.executor.session.roleIdentity, deliveryId: dispatch.episode.thread.delivery.deliveryIdentity, typed: true })
                    : Object.freeze({ typed: true, deliveryId: dispatch.episode.thread.delivery.deliveryIdentity, roleId: dispatch.executor.session.roleIdentity, providerIdentity: identity });
                  if (scenario === "completion-multiple") return Object.freeze([{ kind: "structured-completion" as const, result }, { kind: "structured-completion" as const, result }]);
                  if (scenario === "result-not-object") return Object.freeze([{ kind: "structured-completion" as const, result: "invalid" }]);
                  if (scenario === "result-keys-inexact") return Object.freeze([{ kind: "structured-completion" as const, result: Object.freeze({ ...result, extra: true }) }]);
                  if (scenario === "result-roleId-inexact") return Object.freeze([{ kind: "structured-completion" as const, result: Object.freeze({ ...result, roleId: "role.other" }) }]);
                  return Object.freeze([{ kind: "structured-completion" as const, result }]);
                },
                async persist() { if (scenario === "persist-failed") throw new Error("fixture persist failure"); }, async cancel() {},
                async dispose() { await sessionDispose(); if (scenario === "session-teardown-failed") throw new Error("fixture session teardown failure"); },
              });
              return session;
            },
            async restore() { throw new Error("not used"); },
          }),
          async dispose() {},
        }),
        async dispose() { await realmDispose(); if (scenario === "realm-teardown-failed") throw new Error("fixture realm teardown failure"); },
      });
    },
  });
  return { factory, acquired, openedRoles, sessionDispose, realmDispose };
}

describe("dual real-Provider Delivery qualification", () => {
  it("registers both exact Providers in one Delivery, routes frozen Roles without fallback or crosstalk, and tears down", async () => {
    const root = await mkdtemp(join(tmpdir(), "wsr-dual-provider-test-")); temporaryDirectories.push(root);
    const worktreeCandidate = join(root, "worktree"); const instructionsDirectory = join(root, "instructions");
    await mkdir(worktreeCandidate); await mkdir(instructionsDirectory);
    const canonicalWorktree = await realpath(worktreeCandidate);
    await writeFile(join(instructionsDirectory, "copilot.md"), "Return the exact typed Copilot qualification result.");
    await writeFile(join(instructionsDirectory, "codex.md"), "Return the exact typed Codex qualification result.");
    const copilot = provider("provider.copilot", "1.0.78", "copilot-sdk");
    const codex = provider("provider.codex", "0.144.5", "codex-cli");

    const evidence = await qualifyDualProviderDelivery({
      deliveryId: "delivery.dual-provider-test",
      canonicalWorktree,
      instructionsDirectory,
      copilotFactory: copilot.factory,
      copilotModel: "gpt-5.3-codex",
      codexFactory: codex.factory,
      codexModel: "gpt-5.6-sol",
    });

    expect(evidence).toMatchObject({
      schemaVersion: "execution.dual-provider-qualification@1.0.0",
      deliveryId: "delivery.dual-provider-test",
      credentialMaterialRead: false,
      teardown: { sessionsDisposed: true, realmsDisposed: true },
      providers: [
        { roleId: "role.copilot", providerIdentity: "provider.copilot", providerVersion: "1.0.78", adapterKey: "copilot-sdk", result: { typed: true, roleId: "role.copilot", providerIdentity: "provider.copilot" } },
        { roleId: "role.codex", providerIdentity: "provider.codex", providerVersion: "0.144.5", adapterKey: "codex-cli", result: { typed: true, roleId: "role.codex", providerIdentity: "provider.codex" } },
      ],
    });
    expect(copilot.acquired[0]?.deliveryId).toBe("delivery.dual-provider-test");
    expect(codex.acquired[0]?.deliveryId).toBe("delivery.dual-provider-test");
    expect(copilot.acquired[0]?.roleBindings.map((role) => role.roleId)).toEqual(["role.copilot"]);
    expect(codex.acquired[0]?.roleBindings.map((role) => role.roleId)).toEqual(["role.codex"]);
    expect(copilot.openedRoles).toEqual(["role.copilot"]);
    expect(codex.openedRoles).toEqual(["role.codex"]);
    expect(copilot.sessionDispose).toHaveBeenCalledOnce(); expect(codex.sessionDispose).toHaveBeenCalledOnce();
    expect(copilot.realmDispose).toHaveBeenCalledOnce(); expect(codex.realmDispose).toHaveBeenCalledOnce();
  });

  it("creates and removes the canonical temporary Git worktree used by the explicit real qualification command", async () => {
    const copilot = provider("provider.copilot", "1.0.78", "copilot-sdk");
    const codex = provider("provider.codex", "0.144.5", "codex-cli");

    const evidence = await qualifyTemporaryDualProviderDelivery({
      copilotFactory: copilot.factory, copilotModel: "gpt-5.3-codex",
      codexFactory: () => codex.factory, codexModel: "gpt-5.6-sol",
    });

    expect(evidence.deliveryId).toBe("delivery.dual-provider-real-qualification");
    await expect(access(evidence.canonicalWorktree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["acquire-failed", "realm-acquire", "stage-failed"],
    ["open-failed", "role.copilot:open", "stage-failed"],
    ["provider-failed", "role.copilot:run", "provider-failed-PROVIDER_EXITED"],
    ["startup-uncertain", "role.copilot:run", "startup-uncertain"],
    ["completion-missing", "role.copilot:run", "completion-missing"],
    ["completion-multiple", "role.copilot:run", "completion-multiple"],
    ["result-not-object", "role.copilot:run", "result-not-object"],
    ["result-keys-inexact", "role.copilot:run", "result-keys-inexact"],
    ["result-roleId-inexact", "role.copilot:run", "result-roleId-inexact"],
    ["persist-failed", "role.copilot:persist", "stage-failed"],
    ["session-teardown-failed", "session-teardown", "stage-failed"],
    ["realm-teardown-failed", "realm-teardown", "stage-failed"],
  ] as const)("fails closed at the bounded %s qualification stage and still enters teardown", async (scenario, stage, reason) => {
    const root = await mkdtemp(join(tmpdir(), "wsr-dual-provider-failure-")); temporaryDirectories.push(root);
    const worktreeCandidate = join(root, "worktree"); const instructionsDirectory = join(root, "instructions");
    await mkdir(worktreeCandidate); await mkdir(instructionsDirectory);
    const canonicalWorktree = await realpath(worktreeCandidate);
    await writeFile(join(instructionsDirectory, "copilot.md"), "Return the exact typed Copilot qualification result.");
    await writeFile(join(instructionsDirectory, "codex.md"), "Return the exact typed Codex qualification result.");
    const copilot = provider("provider.copilot", "1.0.78", "copilot-sdk", scenario);
    const codex = provider("provider.codex", "0.144.5", "codex-cli");

    await expect(qualifyDualProviderDelivery({
      deliveryId: "delivery.dual-provider-failure", canonicalWorktree, instructionsDirectory,
      copilotFactory: copilot.factory, copilotModel: "gpt-5.3-codex",
      codexFactory: codex.factory, codexModel: "gpt-5.6-sol",
    })).rejects.toMatchObject({ stage, reason });
  });

  it("rejects a non-canonical worktree before Provider registration or effects", async () => {
    const copilot = provider("provider.copilot", "1.0.78", "copilot-sdk");
    const codex = provider("provider.codex", "0.144.5", "codex-cli");
    await expect(qualifyDualProviderDelivery({
      deliveryId: "delivery.invalid", canonicalWorktree: "/path/that/does/not/exist", instructionsDirectory: "/unused",
      copilotFactory: copilot.factory, copilotModel: "gpt-5.3-codex", codexFactory: codex.factory, codexModel: "gpt-5.6-sol",
    })).rejects.toThrow("not canonical");
    expect(copilot.acquired).toEqual([]); expect(codex.acquired).toEqual([]);
  });

  it("rejects a registered Provider whose adapter key cannot serve the frozen Role route", async () => {
    const root = await mkdtemp(join(tmpdir(), "wsr-dual-provider-route-")); temporaryDirectories.push(root);
    const worktreeCandidate = join(root, "worktree"); const instructionsDirectory = join(root, "instructions");
    await mkdir(worktreeCandidate); await mkdir(instructionsDirectory);
    const canonicalWorktree = await realpath(worktreeCandidate);
    await writeFile(join(instructionsDirectory, "copilot.md"), "Return a typed result.");
    await writeFile(join(instructionsDirectory, "codex.md"), "Return a typed result.");
    const wrongCopilot = provider("provider.copilot", "1.0.78", "codex-cli");
    const codex = provider("provider.codex", "0.144.5", "codex-cli");
    await expect(qualifyDualProviderDelivery({
      deliveryId: "delivery.inexact-route", canonicalWorktree, instructionsDirectory,
      copilotFactory: wrongCopilot.factory, copilotModel: "gpt-5.3-codex", codexFactory: codex.factory, codexModel: "gpt-5.6-sol",
    })).rejects.toThrow("inexact Provider adapter");
  });
});
