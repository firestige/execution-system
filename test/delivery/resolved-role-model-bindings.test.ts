import { describe, expect, it, vi } from "vitest";

import {
  resolveRoleModelBindings,
  ResolvedRoleModelBindingsError,
  type RepositoryModelBindingsSnapshot,
} from "../../src/delivery/index.js";
import { AgentProviderFactoryRegistry, type AgentProviderRealmFactory } from "../../src/providers/provider.js";

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

const registry = new AgentProviderFactoryRegistry([
  factory("provider.dsh", "0.1.1-rc.2", "dsh-headless", ["action-interaction", "structured-completion"]),
  factory("provider.codex", "0.144.5", "codex-cli", ["structured-completion"]),
]);

const present: RepositoryModelBindingsSnapshot = Object.freeze({
  schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0",
  documentState: "PRESENT",
  documentDigest: sha("c"),
  bindings: Object.freeze({
    "role.facilitator": Object.freeze({
      agentProvider: Object.freeze({ identity: "provider.dsh", version: "0.1.1-rc.2" }),
      model: Object.freeze({ provider: "deepseek-official", model: "deepseek-chat" }),
    }),
    "role.reviewer": Object.freeze({
      agentProvider: Object.freeze({ identity: "provider.codex", version: "0.144.5" }),
      model: Object.freeze({ provider: "openai", model: "gpt-5.3-codex" }),
    }),
    "role.unused": Object.freeze({
      agentProvider: Object.freeze({ identity: "provider.dsh", version: "0.1.1-rc.2" }),
      model: Object.freeze({ provider: "deepseek-official", model: "deepseek-reasoner" }),
    }),
  }),
});

function resolve(overrides: Partial<Parameters<typeof resolveRoleModelBindings>[0]> = {}) {
  return resolveRoleModelBindings({
    registry,
    repository: present,
    agentActionRoles: [
      { roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("b"), requiredCapabilities: ["structured-completion"] },
      { roleId: "role.facilitator", rolePromptIdentity: "role.prompt.facilitator", rolePromptDigest: sha("a"), requiredCapabilities: ["action-interaction", "structured-completion"] },
    ],
    ...overrides,
  });
}

describe("resolved Role-to-Provider/model bindings", () => {
  it("freezes distinct Providers for different Roles and bytewise sorts by roleId", () => {
    expect(resolve()).toMatchObject({
      schemaVersion: "execution.resolved-role-provider-bindings@2.0.0",
      resolvedRoles: [
        {
          roleId: "role.facilitator",
          rolePromptIdentity: "role.prompt.facilitator",
          rolePromptDigest: sha("a"),
          agentProviderId: "provider.dsh",
          agentProviderVersion: "0.1.1-rc.2",
          agentProviderAdapterKey: "dsh-headless",
          agentProviderDescriptorDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          modelProviderId: "deepseek-official",
          modelId: "deepseek-chat",
          resolutionSource: "REPOSITORY",
        },
        {
          roleId: "role.reviewer",
          agentProviderId: "provider.codex",
          agentProviderVersion: "0.144.5",
          agentProviderAdapterKey: "codex-cli",
          modelProviderId: "openai",
          modelId: "gpt-5.3-codex",
        },
      ],
      resolvedMapDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(Object.isFrozen(resolve())).toBe(true);
    expect(Object.isFrozen(resolve().resolvedRoles)).toBe(true);
    expect(JSON.stringify(resolve())).not.toContain("role.unused");
  });

  it("fails before Runner effect for absent, missing, unknown, version-mismatched, or incapable bindings", () => {
    const absent: RepositoryModelBindingsSnapshot = Object.freeze({
      schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0",
      documentState: "ABSENT",
    });
    const missing = Object.freeze({ ...present, bindings: Object.freeze({ "role.facilitator": present.bindings["role.facilitator"]! }) });
    const unknown = Object.freeze({ ...present, bindings: Object.freeze({ ...present.bindings, "role.reviewer": Object.freeze({ agentProvider: Object.freeze({ identity: "provider.unknown", version: "1.0.0" }), model: Object.freeze({ provider: "x", model: "y" }) }) }) });
    const wrongVersion = Object.freeze({ ...present, bindings: Object.freeze({ ...present.bindings, "role.reviewer": Object.freeze({ agentProvider: Object.freeze({ identity: "provider.codex", version: "0.145.0" }), model: Object.freeze({ provider: "openai", model: "gpt" }) }) }) });
    const incapableRoles = [{ roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("b"), requiredCapabilities: ["action-interaction", "structured-completion"] }];

    for (const input of [
      { repository: absent },
      { repository: missing },
      { repository: unknown },
      { repository: wrongVersion },
      { agentActionRoles: incapableRoles },
    ]) expect(() => resolve(input)).toThrowError(expect.objectContaining({ code: "RESOLVED_ROLE_BINDINGS_PROVIDER_INVALID" }));
  });

  it("allows a deterministic-only Workflow without a repository binding document", () => {
    const absent: RepositoryModelBindingsSnapshot = Object.freeze({
      schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0",
      documentState: "ABSENT",
    });
    expect(resolve({ repository: absent, agentActionRoles: [] })).toMatchObject({
      resolvedRoles: [],
      resolvedMapDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it("fails closed for duplicate, malformed, or over-bound Snapshot Role sets", () => {
    const duplicate = [
      { roleId: "role.same", rolePromptIdentity: "role.prompt.a", rolePromptDigest: sha("a"), requiredCapabilities: ["structured-completion"] },
      { roleId: "role.same", rolePromptIdentity: "role.prompt.b", rolePromptDigest: sha("b"), requiredCapabilities: ["structured-completion"] },
    ];
    const cases: ReadonlyArray<readonly [Partial<Parameters<typeof resolveRoleModelBindings>[0]>, string]> = [
      [{ agentActionRoles: duplicate }, "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"],
      [{ agentActionRoles: [{ roleId: "bad role", rolePromptIdentity: "role.prompt", rolePromptDigest: sha("a"), requiredCapabilities: ["structured-completion"] }] }, "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"],
      [{ agentActionRoles: [{ roleId: "role", rolePromptIdentity: "role.prompt", rolePromptDigest: "sha256:ABC", requiredCapabilities: ["structured-completion"] }] }, "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"],
      [{ agentActionRoles: Array.from({ length: 129 }, (_, index) => ({ roleId: `role${index}`, rolePromptIdentity: `prompt${index}`, rolePromptDigest: sha("a"), requiredCapabilities: ["structured-completion"] })) }, "RESOLVED_ROLE_BINDINGS_TOO_MANY"],
    ];

    for (const [overrides, code] of cases) expect(() => resolve(overrides)).toThrowError(expect.objectContaining({ code }));
  });

  it("uses typed diagnostics", () => {
    expect(new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"))
      .toMatchObject({ code: "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID", message: "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID" });
  });
});
