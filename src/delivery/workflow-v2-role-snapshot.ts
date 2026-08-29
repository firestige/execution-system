import { deepFreeze } from "../configuration/index.js";
import type { AgentActionRoleSnapshot } from "./resolved-role-model-bindings.js";
import { WorkflowPackageStoreError } from "./workflow-package-store.js";

const VERSION = "agentops.workflow-dsl@2.0.0";
const IDENTITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_ROLES = 128;

type Document = Record<string, any>;

export interface WorkflowV2RoleSnapshotInput {
  readonly packageDocument: unknown;
  readonly snapshotDocument: unknown;
  readonly actionsDocument: unknown;
  readonly rolesDocument: unknown;
  readonly routesDocument: unknown;
}

export interface ExtractedWorkflowV2RoleSnapshot {
  readonly workflowSnapshot: Readonly<{
    workflowId: string;
    workflowVersion: string;
    snapshotId: string;
    snapshotDigest: string;
  }>;
  readonly agentActionRoles: readonly AgentActionRoleSnapshot[];
}

function document(value: unknown): Document {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
  return value as Document;
}

function array(value: unknown): Document[] {
  if (!Array.isArray(value) || value.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) {
    throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
  }
  return value as Document[];
}

function index(values: readonly Document[]): Map<string, Document> {
  const result = new Map<string, Document>();
  for (const value of values) {
    if (typeof value.id !== "string" || !IDENTITY.test(value.id) || result.has(value.id)) {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    result.set(value.id, value);
  }
  return result;
}

function schema(documentValue: Document): void {
  if (documentValue.schemaVersion !== VERSION) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
}

export function extractWorkflowV2RoleSnapshot(input: WorkflowV2RoleSnapshotInput): ExtractedWorkflowV2RoleSnapshot {
  const pkg = document(input.packageDocument);
  const snapshotDocument = document(input.snapshotDocument);
  const actionsDocument = document(input.actionsDocument);
  const rolesDocument = document(input.rolesDocument);
  const routesDocument = document(input.routesDocument);
  for (const value of [pkg, snapshotDocument, actionsDocument, rolesDocument, routesDocument]) schema(value);

  const snapshot = document(snapshotDocument.snapshot);
  const packageCoordinate = document(pkg.package);
  const snapshotPackage = document(snapshot.package);
  const definition = document(snapshot.definition);
  if (snapshotPackage.name !== packageCoordinate.name || snapshotPackage.version !== packageCoordinate.version
    || snapshotPackage.digest !== packageCoordinate.digest || !SHA256.test(packageCoordinate.digest)
    || !IDENTITY.test(snapshot.id) || !SHA256.test(snapshot.digest)
    || !IDENTITY.test(definition.id) || typeof definition.version !== "string") {
    throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
  }

  const declaredRoles = array(rolesDocument.roles);
  if (declaredRoles.length > MAX_ROLES) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
  const roleById = index(declaredRoles);
  const actionById = index(array(actionsDocument.actions));
  const routeById = index(array(routesDocument.routes));

  const packageResources = [...array(document(pkg.resources).owned), ...array(document(pkg.resources).referenced)];
  const packageResourceById = index(packageResources);
  if (packageResources.some((resource) => resource.kind === "agent-definition" || resource.kind === "model")) {
    throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
  }
  const snapshotResourceById = index(array(snapshot.resources));

  for (const route of routeById.values()) {
    const resources = document(route.resources);
    if (Object.hasOwn(route, "agent") || Object.hasOwn(resources, "model")) {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
  }

  const expectedBindings = new Map<string, Readonly<{ action: Document; roleId: string; routeId: string }>>();
  for (const action of actionById.values()) {
    const authority = document(action.responsibleAuthority);
    if (authority.kind !== "role") continue;
    if (typeof authority.role !== "string" || !roleById.has(authority.role)
      || !Array.isArray(action.allowedRoutes) || action.allowedRoutes.length === 0) {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    for (const routeId of action.allowedRoutes) {
      if (typeof routeId !== "string" || !routeById.has(routeId)) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
      const key = `${action.id}\0${routeId}`;
      if (expectedBindings.has(key)) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
      expectedBindings.set(key, { action, roleId: authority.role, routeId });
    }
  }

  const promptByRole = new Map<string, AgentActionRoleSnapshot>();
  const observedBindings = new Set<string>();
  for (const binding of array(snapshot.routeBindings)) {
    if (typeof binding.action !== "string" || typeof binding.role !== "string" || typeof binding.route !== "string") {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    const key = `${binding.action}\0${binding.route}`;
    const expected = expectedBindings.get(key);
    const route = routeById.get(binding.route);
    if (expected === undefined || route === undefined || observedBindings.has(key)
      || binding.role !== expected.roleId || route.role !== expected.roleId) {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    observedBindings.add(key);
    const promptIdentity = document(document(route.resources).rolePrompt).id;
    const capabilities = document(route.resources).capabilities;
    if (!Array.isArray(capabilities) || capabilities.length === 0
      || capabilities.some((capability) => typeof capability !== "string" || !IDENTITY.test(capability))
      || new Set(capabilities).size !== capabilities.length) {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    const packagePrompt = typeof promptIdentity === "string" ? packageResourceById.get(promptIdentity) : undefined;
    const snapshotPrompt = typeof promptIdentity === "string" ? snapshotResourceById.get(promptIdentity) : undefined;
    if (packagePrompt?.kind !== "role-prompt" || snapshotPrompt === undefined
      || packagePrompt.contentIdentity !== snapshotPrompt.contentIdentity || !SHA256.test(snapshotPrompt.contentIdentity)) {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    const roleSnapshot = {
      roleId: expected.roleId,
      rolePromptIdentity: promptIdentity,
      rolePromptDigest: snapshotPrompt.contentIdentity,
      requiredCapabilities: [...capabilities].sort(),
    };
    const prior = promptByRole.get(expected.roleId);
    if (prior !== undefined && (prior.rolePromptIdentity !== roleSnapshot.rolePromptIdentity
      || prior.rolePromptDigest !== roleSnapshot.rolePromptDigest)) {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    promptByRole.set(expected.roleId, prior === undefined ? roleSnapshot : {
      ...prior,
      requiredCapabilities: [...new Set([...prior.requiredCapabilities, ...roleSnapshot.requiredCapabilities])].sort(),
    });
  }
  if (observedBindings.size !== expectedBindings.size) throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");

  const agentActionRoles = [...promptByRole.values()]
    .sort((left, right) => left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1 : 0);
  return deepFreeze({
    workflowSnapshot: {
      workflowId: definition.id,
      workflowVersion: definition.version,
      snapshotId: snapshot.id,
      snapshotDigest: snapshot.digest,
    },
    agentActionRoles,
  });
}
