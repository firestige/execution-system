import { describe, expect, it, vi } from "vitest";

import {
  AgentProviderFactoryRegistry,
  AgentProviderRegistryError,
  type AgentProviderRealmFactory,
} from "../../src/providers/provider.js";

const sha = (character: string): string => `sha256:${character.repeat(64)}`;

function factory(
  identity: string,
  version: string,
  adapterKey: "dsh-headless" | "copilot-sdk" | "codex-cli",
  capabilities: readonly string[],
): AgentProviderRealmFactory {
  return Object.freeze({
    descriptor: Object.freeze({
      schemaVersion: "execution.agent-provider-factory@1.0.0" as const,
      identity,
      version,
      adapterKey,
      capabilities: Object.freeze([...capabilities]),
    }),
    acquire: vi.fn(),
  });
}

describe("Agent Provider factory registry", () => {
  it("registers multiple exact factories and exposes stable canonical descriptors", () => {
    const registry = new AgentProviderFactoryRegistry([
      factory("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["action-interaction", "structured-completion"]),
      factory("provider.codex", "0.144.5", "codex-cli", ["structured-completion"]),
    ]);

    expect(registry.descriptors()).toEqual([
      {
        schemaVersion: "execution.agent-provider-factory@1.0.0",
        identity: "provider.codex",
        version: "0.144.5",
        adapterKey: "codex-cli",
        capabilities: ["structured-completion"],
        descriptorDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      {
        schemaVersion: "execution.agent-provider-factory@1.0.0",
        identity: "provider.dsh",
        version: "0.1.1-rc.2",
        adapterKey: "dsh-headless",
        capabilities: ["action-interaction", "structured-completion"],
        descriptorDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    ]);
    expect(Object.isFrozen(registry.descriptors())).toBe(true);
  });

  it("fails closed for duplicate, conflicting, malformed, mutable, or accessor-backed registrations", () => {
    const dsh = factory("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["structured-completion"]);
    const cases: readonly (() => unknown)[] = [
      () => new AgentProviderFactoryRegistry([dsh, dsh]),
      () => new AgentProviderFactoryRegistry([dsh, factory("provider.dsh", "0.1.2", "dsh-headless", ["structured-completion"])]),
      () => new AgentProviderFactoryRegistry([factory("bad provider", "1.0.0", "dsh-headless", ["structured-completion"])]),
      () => new AgentProviderFactoryRegistry([factory("provider.dsh", "latest", "dsh-headless", ["structured-completion"])]),
      () => new AgentProviderFactoryRegistry([factory("provider.dsh", "1.0.0", "dsh-headless", ["structured-completion", "structured-completion"])]),
      () => new AgentProviderFactoryRegistry([{ ...dsh, descriptor: { ...dsh.descriptor } } as AgentProviderRealmFactory]),
      () => new AgentProviderFactoryRegistry([Object.freeze({
        get descriptor() { return dsh.descriptor; },
        acquire: vi.fn(),
      }) as unknown as AgentProviderRealmFactory]),
    ];

    for (const invoke of cases) expect(invoke).toThrow(AgentProviderRegistryError);
  });

  it("admits only an exact version with all required capabilities and never falls back", () => {
    const registry = new AgentProviderFactoryRegistry([
      factory("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["action-interaction", "structured-completion"]),
      factory("provider.codex", "0.144.5", "codex-cli", ["structured-completion"]),
    ]);

    expect(registry.admit({ identity: "provider.dsh", version: "0.1.1-rc.2" }, ["structured-completion"]))
      .toMatchObject({ identity: "provider.dsh", version: "0.1.1-rc.2", adapterKey: "dsh-headless" });

    for (const [provider, capabilities, code] of [
      [{ identity: "provider.missing", version: "1.0.0" }, ["structured-completion"], "PROVIDER_FACTORY_UNKNOWN"],
      [{ identity: "provider.dsh", version: "0.1.2" }, ["structured-completion"], "PROVIDER_FACTORY_VERSION_MISMATCH"],
      [{ identity: "provider.codex", version: "0.144.5" }, ["action-interaction"], "PROVIDER_FACTORY_CAPABILITY_MISMATCH"],
    ] as const) {
      expect(() => registry.admit(provider, capabilities)).toThrowError(expect.objectContaining({ code }));
    }
  });

  it("rejects a persisted descriptor digest mismatch during recovery", () => {
    const registry = new AgentProviderFactoryRegistry([
      factory("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["structured-completion"]),
    ]);

    expect(() => registry.recover({
      identity: "provider.dsh",
      version: "0.1.1-rc.2",
      descriptorDigest: sha("a"),
    })).toThrowError(expect.objectContaining({ code: "PROVIDER_FACTORY_DESCRIPTOR_MISMATCH" }));
  });
});
