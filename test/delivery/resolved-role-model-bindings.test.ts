import { describe, expect, it } from "vitest";

import {
  resolveRoleModelBindings,
  ResolvedRoleModelBindingsError,
  type RepositoryModelBindingsSnapshot,
} from "../../src/delivery/index.js";

const sha = (character: string): string => `sha256:${character.repeat(64)}`;

const absent: RepositoryModelBindingsSnapshot = Object.freeze({
  schemaVersion: "execution.repository-model-bindings-snapshot@1.0.0",
  documentState: "ABSENT",
});

function resolve(overrides: Partial<Parameters<typeof resolveRoleModelBindings>[0]> = {}) {
  return resolveRoleModelBindings({
    agentProviderId: "provider.dsh",
    defaultModel: { provider: "deepseek-official", model: "deepseek-chat" },
    repository: absent,
    agentActionRoles: [
      { roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("b") },
      { roleId: "role.facilitator", rolePromptIdentity: "role.prompt.facilitator", rolePromptDigest: sha("a") },
    ],
    ...overrides,
  });
}

describe("resolved Role-to-model bindings", () => {
  it("resolves every distinct Agent-action Role, records fallback source, and bytewise sorts by roleId", () => {
    expect(resolve()).toMatchObject({
      schemaVersion: "execution.resolved-role-model-bindings@1.0.0",
      resolvedRoles: [
        {
          roleId: "role.facilitator",
          rolePromptIdentity: "role.prompt.facilitator",
          rolePromptDigest: sha("a"),
          agentProviderId: "provider.dsh",
          modelProviderId: "deepseek-official",
          modelId: "deepseek-chat",
          resolutionSource: "EXECUTION_DEFAULT",
        },
        { roleId: "role.reviewer" },
      ],
      resolvedMapDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(Object.isFrozen(resolve())).toBe(true);
    expect(Object.isFrozen(resolve().resolvedRoles)).toBe(true);
  });

  it("uses only exact matching repository entries and retains no unrelated repository Role", () => {
    const repository: RepositoryModelBindingsSnapshot = Object.freeze({
      schemaVersion: "execution.repository-model-bindings-snapshot@1.0.0",
      documentState: "PRESENT",
      documentDigest: sha("c"),
      bindings: Object.freeze({
        "role.reviewer": Object.freeze({ provider: "anthropic-official", model: "claude-sonnet" }),
        "role.unused": Object.freeze({ provider: "unused-route", model: "unused-model" }),
      }),
    });

    const result = resolve({ repository });

    expect(result.resolvedRoles).toHaveLength(2);
    expect(result.resolvedRoles[1]).toMatchObject({
      roleId: "role.reviewer",
      modelProviderId: "anthropic-official",
      modelId: "claude-sonnet",
      resolutionSource: "REPOSITORY",
    });
    expect(JSON.stringify(result)).not.toContain("role.unused");
  });

  it("makes each of the seven resolved fields identity-significant", () => {
    const baseline = resolve();
    const repository: RepositoryModelBindingsSnapshot = Object.freeze({
      schemaVersion: "execution.repository-model-bindings-snapshot@1.0.0",
      documentState: "PRESENT",
      documentDigest: sha("d"),
      bindings: Object.freeze({ "role.facilitator": Object.freeze({ provider: "deepseek-official", model: "deepseek-chat" }) }),
    });
    const mutations = [
      resolve({ agentActionRoles: [{ roleId: "role.changed", rolePromptIdentity: "role.prompt.facilitator", rolePromptDigest: sha("a") }, { roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("b") }] }),
      resolve({ agentActionRoles: [{ roleId: "role.facilitator", rolePromptIdentity: "role.prompt.changed", rolePromptDigest: sha("a") }, { roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("b") }] }),
      resolve({ agentActionRoles: [{ roleId: "role.facilitator", rolePromptIdentity: "role.prompt.facilitator", rolePromptDigest: sha("c") }, { roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("b") }] }),
      resolve({ agentProviderId: "provider.changed" }),
      resolve({ defaultModel: { provider: "route.changed", model: "deepseek-chat" } }),
      resolve({ defaultModel: { provider: "deepseek-official", model: "model.changed" } }),
      resolve({ repository }),
    ];

    for (const mutation of mutations) expect(mutation.resolvedMapDigest).not.toBe(baseline.resolvedMapDigest);
  });

  it("allows a deterministic-only Workflow with no Agent-action Role", () => {
    expect(resolve({ agentActionRoles: [] })).toMatchObject({
      resolvedRoles: [],
      resolvedMapDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it("fails closed for duplicate, malformed, or over-bound Snapshot Role sets", () => {
    const duplicate = [
      { roleId: "role.same", rolePromptIdentity: "role.prompt.a", rolePromptDigest: sha("a") },
      { roleId: "role.same", rolePromptIdentity: "role.prompt.b", rolePromptDigest: sha("b") },
    ];
    const cases: ReadonlyArray<readonly [Partial<Parameters<typeof resolveRoleModelBindings>[0]>, string]> = [
      [{ agentActionRoles: duplicate }, "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"],
      [{ agentActionRoles: [{ roleId: "bad role", rolePromptIdentity: "role.prompt", rolePromptDigest: sha("a") }] }, "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"],
      [{ agentActionRoles: [{ roleId: "role", rolePromptIdentity: "role.prompt", rolePromptDigest: "sha256:ABC" }] }, "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"],
      [{ agentActionRoles: Array.from({ length: 129 }, (_, index) => ({ roleId: `role${index}`, rolePromptIdentity: `prompt${index}`, rolePromptDigest: sha("a") })) }, "RESOLVED_ROLE_BINDINGS_TOO_MANY"],
      [{ agentProviderId: "bad provider" }, "RESOLVED_ROLE_BINDINGS_SELECTION_INVALID"],
      [{ defaultModel: { provider: "route", model: "" } }, "RESOLVED_ROLE_BINDINGS_SELECTION_INVALID"],
    ];

    for (const [overrides, code] of cases) expect(() => resolve(overrides)).toThrowError(expect.objectContaining({ code }));
  });

  it("uses typed diagnostics", () => {
    expect(new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"))
      .toMatchObject({ code: "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID", message: "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID" });
  });
});
