import { createHash } from "node:crypto";

import { canonicalJsonBytes, deepFreeze } from "../configuration/index.js";
import type { RepositoryModelBindingsSnapshot } from "./repository-model-bindings.js";

const IDENTITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_ROLES = 128;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type ProviderAdapterKey = "dsh-headless" | "copilot-sdk" | "codex-cli";

export interface AgentProviderAdmissionRegistry {
  admit(reference: Readonly<{ identity: string; version: string }>, requiredCapabilities: readonly string[]): Readonly<{
    identity: string;
    version: string;
    adapterKey: ProviderAdapterKey;
    descriptorDigest: string;
  }>;
}

export type ResolvedRoleModelBindingsErrorCode =
  | "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"
  | "RESOLVED_ROLE_BINDINGS_TOO_MANY"
  | "RESOLVED_ROLE_BINDINGS_SELECTION_INVALID"
  | "RESOLVED_ROLE_BINDINGS_REPOSITORY_INVALID"
  | "RESOLVED_ROLE_BINDINGS_PROVIDER_INVALID";

export class ResolvedRoleModelBindingsError extends Error {
  constructor(readonly code: ResolvedRoleModelBindingsErrorCode) {
    super(code);
    this.name = "ResolvedRoleModelBindingsError";
  }
}

export interface AgentActionRoleSnapshot {
  readonly roleId: string;
  readonly rolePromptIdentity: string;
  readonly rolePromptDigest: string;
  readonly requiredCapabilities: readonly string[];
}

export interface ResolvedRoleModelBinding {
  readonly roleId: string;
  readonly rolePromptIdentity: string;
  readonly rolePromptDigest: string;
  readonly agentProviderId: string;
  readonly agentProviderVersion: string;
  readonly agentProviderAdapterKey: ProviderAdapterKey;
  readonly agentProviderDescriptorDigest: string;
  readonly requiredCapabilities: readonly string[];
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly resolutionSource: "REPOSITORY";
}

export interface ResolvedRoleModelBindings {
  readonly schemaVersion: "execution.resolved-role-provider-bindings@2.0.0";
  readonly resolvedRoles: readonly ResolvedRoleModelBinding[];
  readonly resolvedMapDigest: string;
}

export interface ResolveRoleModelBindingsInput {
  readonly registry: AgentProviderAdmissionRegistry;
  readonly repository: RepositoryModelBindingsSnapshot;
  readonly agentActionRoles: readonly AgentActionRoleSnapshot[];
}

function repositoryBindings(snapshot: RepositoryModelBindingsSnapshot): Readonly<Record<string, import("./repository-model-bindings.js").ExactRoleProviderModelSelection>> {
  if (snapshot.documentState === "ABSENT") return {};
  if (!SHA256.test(snapshot.documentDigest) || snapshot.bindings === null || typeof snapshot.bindings !== "object" || Array.isArray(snapshot.bindings)) {
    throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_REPOSITORY_INVALID");
  }
  for (const [roleId, selection] of Object.entries(snapshot.bindings)) {
    if (!IDENTITY.test(roleId) || !IDENTITY.test(selection.agentProvider.identity)
      || !IDENTITY.test(selection.model.provider) || !IDENTITY.test(selection.model.model)) {
      throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_REPOSITORY_INVALID");
    }
  }
  return snapshot.bindings;
}

function digest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")}`;
}

export function resolveRoleModelBindings(input: ResolveRoleModelBindingsInput): ResolvedRoleModelBindings {
  if (input.agentActionRoles.length > MAX_ROLES) {
    throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_TOO_MANY");
  }
  const bindings = repositoryBindings(input.repository);
  const seen = new Set<string>();
  for (const role of input.agentActionRoles) {
    if (!IDENTITY.test(role.roleId) || !IDENTITY.test(role.rolePromptIdentity) || !SHA256.test(role.rolePromptDigest)
      || !Array.isArray(role.requiredCapabilities) || role.requiredCapabilities.length === 0
      || role.requiredCapabilities.some((capability) => !IDENTITY.test(capability))
      || new Set(role.requiredCapabilities).size !== role.requiredCapabilities.length || seen.has(role.roleId)) {
      throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID");
    }
    seen.add(role.roleId);
  }
  const roles: ResolvedRoleModelBinding[] = [];
  for (const role of input.agentActionRoles) {
    const repositorySelection = bindings[role.roleId];
    if (repositorySelection === undefined) {
      throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_PROVIDER_INVALID");
    }
    let descriptor;
    try {
      descriptor = input.registry.admit(repositorySelection.agentProvider, role.requiredCapabilities);
    } catch {
      throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_PROVIDER_INVALID");
    }
    roles.push({
      roleId: role.roleId,
      rolePromptIdentity: role.rolePromptIdentity,
      rolePromptDigest: role.rolePromptDigest,
      agentProviderId: descriptor.identity,
      agentProviderVersion: descriptor.version,
      agentProviderAdapterKey: descriptor.adapterKey,
      agentProviderDescriptorDigest: descriptor.descriptorDigest,
      requiredCapabilities: [...role.requiredCapabilities].sort(),
      modelProviderId: repositorySelection.model.provider,
      modelId: repositorySelection.model.model,
      resolutionSource: "REPOSITORY",
    });
  }
  roles.sort((left, right) => left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1 : 0);
  const resolvedRoles = deepFreeze(roles);
  return deepFreeze({
    schemaVersion: "execution.resolved-role-provider-bindings@2.0.0",
    resolvedRoles,
    resolvedMapDigest: digest(resolvedRoles as unknown as JsonValue),
  });
}
