import { createHash } from "node:crypto";

import { canonicalJsonBytes, deepFreeze } from "../configuration/index.js";
import type { ExactModelSelection, RepositoryModelBindingsSnapshot } from "./repository-model-bindings.js";

const IDENTITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_ROLES = 128;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ResolvedRoleModelBindingsErrorCode =
  | "RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID"
  | "RESOLVED_ROLE_BINDINGS_TOO_MANY"
  | "RESOLVED_ROLE_BINDINGS_SELECTION_INVALID"
  | "RESOLVED_ROLE_BINDINGS_REPOSITORY_INVALID";

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
}

export interface ResolvedRoleModelBinding {
  readonly roleId: string;
  readonly rolePromptIdentity: string;
  readonly rolePromptDigest: string;
  readonly agentProviderId: string;
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly resolutionSource: "REPOSITORY" | "EXECUTION_DEFAULT";
}

export interface ResolvedRoleModelBindings {
  readonly schemaVersion: "execution.resolved-role-model-bindings@1.0.0";
  readonly resolvedRoles: readonly ResolvedRoleModelBinding[];
  readonly resolvedMapDigest: string;
}

export interface ResolveRoleModelBindingsInput {
  readonly agentProviderId: string;
  readonly defaultModel: ExactModelSelection;
  readonly repository: RepositoryModelBindingsSnapshot;
  readonly agentActionRoles: readonly AgentActionRoleSnapshot[];
}

function validSelection(value: ExactModelSelection): boolean {
  return IDENTITY.test(value.provider) && IDENTITY.test(value.model);
}

function repositoryBindings(snapshot: RepositoryModelBindingsSnapshot): Readonly<Record<string, ExactModelSelection>> {
  if (snapshot.documentState === "ABSENT") return {};
  if (!SHA256.test(snapshot.documentDigest) || snapshot.bindings === null || typeof snapshot.bindings !== "object" || Array.isArray(snapshot.bindings)) {
    throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_REPOSITORY_INVALID");
  }
  for (const [roleId, selection] of Object.entries(snapshot.bindings)) {
    if (!IDENTITY.test(roleId) || !validSelection(selection)) {
      throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_REPOSITORY_INVALID");
    }
  }
  return snapshot.bindings;
}

function digest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")}`;
}

export function resolveRoleModelBindings(input: ResolveRoleModelBindingsInput): ResolvedRoleModelBindings {
  if (!IDENTITY.test(input.agentProviderId) || !validSelection(input.defaultModel)) {
    throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_SELECTION_INVALID");
  }
  if (input.agentActionRoles.length > MAX_ROLES) {
    throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_TOO_MANY");
  }
  const bindings = repositoryBindings(input.repository);
  const seen = new Set<string>();
  const roles: ResolvedRoleModelBinding[] = [];
  for (const role of input.agentActionRoles) {
    if (!IDENTITY.test(role.roleId) || !IDENTITY.test(role.rolePromptIdentity) || !SHA256.test(role.rolePromptDigest)
      || seen.has(role.roleId)) {
      throw new ResolvedRoleModelBindingsError("RESOLVED_ROLE_BINDINGS_ROLE_SET_INVALID");
    }
    seen.add(role.roleId);
    const repositorySelection = bindings[role.roleId];
    const selection = repositorySelection ?? input.defaultModel;
    roles.push({
      roleId: role.roleId,
      rolePromptIdentity: role.rolePromptIdentity,
      rolePromptDigest: role.rolePromptDigest,
      agentProviderId: input.agentProviderId,
      modelProviderId: selection.provider,
      modelId: selection.model,
      resolutionSource: repositorySelection === undefined ? "EXECUTION_DEFAULT" : "REPOSITORY",
    });
  }
  roles.sort((left, right) => left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1 : 0);
  const resolvedRoles = deepFreeze(roles);
  return deepFreeze({
    schemaVersion: "execution.resolved-role-model-bindings@1.0.0",
    resolvedRoles,
    resolvedMapDigest: digest(resolvedRoles as unknown as JsonValue),
  });
}
