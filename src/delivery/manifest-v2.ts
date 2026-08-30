import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  canonicalJsonBytes,
  coordinateIdentity,
  deepFreeze,
  type DeliveryConfigProjectionV2,
} from "../configuration/index.js";
import { DeliveryBindingError, type ImmutableTaskPromptSnapshot } from "./manifest.js";
import type { RepositoryModelBindingsSnapshot } from "./repository-model-bindings.js";
import type {
  AgentActionRoleSnapshot,
  ResolvedRoleModelBinding,
  ResolvedRoleModelBindings,
} from "./resolved-role-model-bindings.js";

export type { DeliveryConfigProjectionV2 } from "../configuration/index.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,1023}$/u;
const IDENTITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const PROVIDER_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MAX_ROLES = 128;
const MAX_PROJECTION_BYTES = 64 * 1024;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface DeliveryManifestV2 {
  readonly schemaVersion: "execution.delivery-manifest@2.0.0";
  readonly deliveryId: string;
  readonly taskId: string;
  readonly taskDisplayName?: string;
  readonly createdAt: number;
  readonly canonicalWorktree: string;
  readonly workflowPackage: Readonly<{
    name: string;
    exactVersion: string;
    packageDigest: string;
    localMaterializationPath: string;
  }>;
  readonly workflowSnapshot: Readonly<{
    workflowId: string;
    workflowVersion: string;
    snapshotId: string;
    snapshotDigest: string;
  }>;
  readonly repositoryModelBindings:
    | Readonly<{ documentState: "ABSENT"; resolvedMapDigest: string }>
    | Readonly<{ documentState: "PRESENT"; documentDigest: string; resolvedMapDigest: string }>;
  readonly resolvedRoles: readonly ResolvedRoleModelBinding[];
  readonly prompt: Readonly<{
    taskPromptIdentity: string;
    snapshotIdentity: string;
    snapshotDigest: string;
    snapshotPath: string;
  }>;
  readonly deliveryConfigProjection: DeliveryConfigProjectionV2;
  readonly deliveryBindingIdentity: string;
}

export interface CreateDeliveryManifestV2Input {
  readonly deliveryId: string;
  readonly taskId: string;
  readonly taskDisplayName?: string;
  readonly createdAt: number;
  readonly canonicalWorktree: string;
  readonly workflowPackage: DeliveryManifestV2["workflowPackage"];
  readonly workflowSnapshot: DeliveryManifestV2["workflowSnapshot"];
  readonly agentActionRoles: readonly AgentActionRoleSnapshot[];
  readonly repositoryModelBindings: RepositoryModelBindingsSnapshot;
  readonly resolvedRoleBindings: ResolvedRoleModelBindings;
  readonly promptSnapshot: ImmutableTaskPromptSnapshot;
  readonly deliveryConfigProjection: DeliveryConfigProjectionV2;
}

export interface DeliveryManifestPortableProjection {
  readonly schema_version: "execution.delivery-manifest-projection@1.0.0";
  readonly delivery_id: string;
  readonly task_id: string;
  readonly manifest_digest: string;
  readonly workflow: Readonly<{
    package_name: string;
    exact_package_version: string;
    package_digest: string;
    workflow_id: string;
    workflow_version: string;
    snapshot_id: string;
    snapshot_digest: string;
  }>;
  readonly repository_model_bindings:
    | Readonly<{ document_state: "ABSENT"; resolved_map_digest: string }>
    | Readonly<{ document_state: "PRESENT"; document_digest: string; resolved_map_digest: string }>;
  readonly roles: readonly Readonly<{
    role_id: string;
    role_prompt_identity: string;
    role_prompt_digest: string;
    agent_provider_id: string;
    agent_provider_version: string;
    agent_provider_adapter_key: string;
    agent_provider_descriptor_digest: string;
    required_capabilities: readonly string[];
    model_provider_id: string;
    model_id: string;
    resolution_source: "REPOSITORY";
  }>[];
}

export interface CreatedDeliveryManifestProjection {
  readonly projection: DeliveryManifestPortableProjection;
  readonly canonicalJson: string;
  readonly projectionDigest: string;
}

export interface PersistedDeliveryManifestV2 {
  readonly manifest: DeliveryManifestV2;
  readonly path: string;
}

function digest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")}`;
}

function validRole(role: ResolvedRoleModelBinding): boolean {
  return IDENTITY.test(role.roleId) && IDENTITY.test(role.rolePromptIdentity) && SHA256.test(role.rolePromptDigest)
    && IDENTITY.test(role.agentProviderId) && PROVIDER_VERSION.test(role.agentProviderVersion)
    && IDENTITY.test(role.agentProviderAdapterKey) && SHA256.test(role.agentProviderDescriptorDigest)
    && Array.isArray(role.requiredCapabilities) && role.requiredCapabilities.length > 0
    && role.requiredCapabilities.every((capability, index) => IDENTITY.test(capability)
      && (index === 0 || role.requiredCapabilities[index - 1]! < capability))
    && IDENTITY.test(role.modelProviderId) && IDENTITY.test(role.modelId)
    && role.resolutionSource === "REPOSITORY";
}

function expectedResolvedMapDigest(roles: readonly ResolvedRoleModelBinding[]): string {
  return digest(roles as unknown as JsonValue);
}

function exactRoleClosure(snapshotRoles: readonly AgentActionRoleSnapshot[], resolvedRoles: readonly ResolvedRoleModelBinding[]): boolean {
  if (snapshotRoles.length !== resolvedRoles.length || snapshotRoles.length > MAX_ROLES) return false;
  const expected = [...snapshotRoles].sort((left, right) => left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1 : 0);
  return expected.every((role, index) => {
    const resolved = resolvedRoles[index];
    return resolved !== undefined && role.roleId === resolved.roleId
      && role.rolePromptIdentity === resolved.rolePromptIdentity
      && role.rolePromptDigest === resolved.rolePromptDigest
      && role.requiredCapabilities.length === resolved.requiredCapabilities.length
      && [...role.requiredCapabilities].sort().every((capability, capabilityIndex) => capability === resolved.requiredCapabilities[capabilityIndex]);
  });
}

function validDeliveryProjection(projection: DeliveryConfigProjectionV2): boolean {
  const value = projection.value;
  return value.schemaVersion === "execution.delivery-config@2.0.0"
    && projection.identity === coordinateIdentity("execution.delivery-config@2.0.0", value as unknown as JsonValue)
    && value.runner.implementationKey === "runner.v2"
    && value.runner.host.engine === "langgraph"
    && Number.isSafeInteger(value.runner.maxParallelToolCalls)
    && value.runner.maxParallelToolCalls >= 1 && value.runner.maxParallelToolCalls <= 32;
}

export function createDeliveryManifestV2(input: CreateDeliveryManifestV2Input): DeliveryManifestV2 {
  const resolvedRoles = input.resolvedRoleBindings.resolvedRoles;
  const repo = input.repositoryModelBindings;
  const repositoryValid = repo.documentState === "ABSENT"
    || (repo.documentState === "PRESENT" && SHA256.test(repo.documentDigest));
  const idsValid = PORTABLE_ID.test(input.deliveryId) && PORTABLE_ID.test(input.taskId)
    && PACKAGE_NAME.test(input.workflowPackage.name) && VERSION.test(input.workflowPackage.exactVersion)
    && IDENTITY.test(input.workflowSnapshot.workflowId) && VERSION.test(input.workflowSnapshot.workflowVersion)
    && IDENTITY.test(input.workflowSnapshot.snapshotId);
  const pathsValid = isAbsolute(input.canonicalWorktree) && isAbsolute(input.workflowPackage.localMaterializationPath)
    && isAbsolute(input.promptSnapshot.path);
  const digestsValid = SHA256.test(input.workflowPackage.packageDigest) && SHA256.test(input.workflowSnapshot.snapshotDigest)
    && SHA256.test(input.promptSnapshot.identity) && SHA256.test(input.promptSnapshot.digest)
    && SHA256.test(input.resolvedRoleBindings.resolvedMapDigest)
    && input.resolvedRoleBindings.resolvedMapDigest === expectedResolvedMapDigest(resolvedRoles);
  const orderAndShapeValid = resolvedRoles.length <= MAX_ROLES
    && resolvedRoles.every((role, index) => validRole(role) && (index === 0 || resolvedRoles[index - 1]!.roleId < role.roleId));
  if (!idsValid || !pathsValid || !digestsValid || !repositoryValid || !orderAndShapeValid
    || !exactRoleClosure(input.agentActionRoles, resolvedRoles)
    || !validDeliveryProjection(input.deliveryConfigProjection)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || (input.taskDisplayName !== undefined && (input.taskDisplayName.length === 0 || input.taskDisplayName.length > 160
      || input.taskDisplayName.trim() !== input.taskDisplayName))) {
    throw new DeliveryBindingError("DELIVERY_BINDING_INVALID");
  }

  const repositoryModelBindings = repo.documentState === "ABSENT"
    ? { documentState: "ABSENT" as const, resolvedMapDigest: input.resolvedRoleBindings.resolvedMapDigest }
    : { documentState: "PRESENT" as const, documentDigest: repo.documentDigest, resolvedMapDigest: input.resolvedRoleBindings.resolvedMapDigest };
  const content = {
    deliveryId: input.deliveryId,
    taskId: input.taskId,
    ...(input.taskDisplayName === undefined ? {} : { taskDisplayName: input.taskDisplayName }),
    createdAt: input.createdAt,
    canonicalWorktree: resolve(input.canonicalWorktree),
    workflowPackage: {
      ...input.workflowPackage,
      localMaterializationPath: resolve(input.workflowPackage.localMaterializationPath),
    },
    workflowSnapshot: input.workflowSnapshot,
    repositoryModelBindings,
    resolvedRoles,
    prompt: {
      taskPromptIdentity: input.promptSnapshot.identity,
      snapshotIdentity: input.promptSnapshot.identity,
      snapshotDigest: input.promptSnapshot.digest,
      snapshotPath: resolve(input.promptSnapshot.path),
    },
    deliveryConfigProjection: input.deliveryConfigProjection,
  };
  return deepFreeze({
    schemaVersion: "execution.delivery-manifest@2.0.0",
    ...content,
    deliveryBindingIdentity: digest(content as unknown as JsonValue),
  });
}

export function createDeliveryManifestProjection(manifest: DeliveryManifestV2): CreatedDeliveryManifestProjection {
  const projection: DeliveryManifestPortableProjection = deepFreeze({
    schema_version: "execution.delivery-manifest-projection@1.0.0",
    delivery_id: manifest.deliveryId,
    task_id: manifest.taskId,
    manifest_digest: manifest.deliveryBindingIdentity.slice("sha256:".length),
    workflow: {
      package_name: manifest.workflowPackage.name,
      exact_package_version: manifest.workflowPackage.exactVersion,
      package_digest: manifest.workflowPackage.packageDigest,
      workflow_id: manifest.workflowSnapshot.workflowId,
      workflow_version: manifest.workflowSnapshot.workflowVersion,
      snapshot_id: manifest.workflowSnapshot.snapshotId,
      snapshot_digest: manifest.workflowSnapshot.snapshotDigest,
    },
    repository_model_bindings: manifest.repositoryModelBindings.documentState === "ABSENT"
      ? { document_state: "ABSENT", resolved_map_digest: manifest.repositoryModelBindings.resolvedMapDigest }
      : {
        document_state: "PRESENT",
        document_digest: manifest.repositoryModelBindings.documentDigest,
        resolved_map_digest: manifest.repositoryModelBindings.resolvedMapDigest,
      },
    roles: manifest.resolvedRoles.map((role) => ({
      role_id: role.roleId,
      role_prompt_identity: role.rolePromptIdentity,
      role_prompt_digest: role.rolePromptDigest,
      agent_provider_id: role.agentProviderId,
      agent_provider_version: role.agentProviderVersion,
      agent_provider_adapter_key: role.agentProviderAdapterKey,
      agent_provider_descriptor_digest: role.agentProviderDescriptorDigest,
      required_capabilities: role.requiredCapabilities,
      model_provider_id: role.modelProviderId,
      model_id: role.modelId,
      resolution_source: role.resolutionSource,
    })),
  });
  const bytes = canonicalJsonBytes(projection as unknown as JsonValue);
  if (bytes.byteLength > MAX_PROJECTION_BYTES) throw new DeliveryBindingError("DELIVERY_BINDING_INVALID");
  return deepFreeze({
    projection,
    canonicalJson: Buffer.from(bytes).toString("utf8"),
    projectionDigest: createHash("sha256").update(bytes).digest("hex"),
  });
}

function safeSegment(value: string): string {
  if (!PORTABLE_ID.test(value)) throw new DeliveryBindingError("DELIVERY_BINDING_INVALID");
  return createHash("sha256").update(value).digest("hex");
}

/** Closed v2 Manifest store used by recovery. It re-derives the binding identity on every load. */
export class DeliveryManifestRepositoryV2 {
  readonly #root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError("Delivery Manifest root must be absolute");
    this.#root = resolve(root);
  }

  async persist(manifest: DeliveryManifestV2): Promise<PersistedDeliveryManifestV2> {
    const path = join(this.#root, `${safeSegment(manifest.deliveryId)}.json`);
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
      return deepFreeze({ manifest, path });
    } catch {
      throw new DeliveryBindingError("DELIVERY_MANIFEST_PERSIST_FAILED");
    }
  }

  async load(path: string): Promise<DeliveryManifestV2> {
    try {
      const absolute = resolve(path);
      if (!isAbsolute(path) || resolve(absolute, "..") !== this.#root || !(await stat(absolute)).isFile()) throw new Error("invalid path");
      const candidate = JSON.parse(await readFile(absolute, "utf8")) as DeliveryManifestV2;
      const expectedKeys = ["canonicalWorktree", "createdAt", "deliveryBindingIdentity", "deliveryConfigProjection", "deliveryId", "prompt", "repositoryModelBindings", "resolvedRoles", "schemaVersion", "taskId", "workflowPackage", "workflowSnapshot", ...(candidate.taskDisplayName === undefined ? [] : ["taskDisplayName"])].sort();
      if (candidate.schemaVersion !== "execution.delivery-manifest@2.0.0" || Object.keys(candidate).sort().join(",") !== expectedKeys.join(",")) throw new Error("invalid shape");
      const agentActionRoles = candidate.resolvedRoles.map((role) => ({
        roleId: role.roleId,
        rolePromptIdentity: role.rolePromptIdentity,
        rolePromptDigest: role.rolePromptDigest,
        requiredCapabilities: role.requiredCapabilities,
      }));
      const repositoryModelBindings: RepositoryModelBindingsSnapshot = candidate.repositoryModelBindings.documentState === "ABSENT"
        ? { schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0", documentState: "ABSENT" }
        : {
          schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0",
          documentState: "PRESENT",
          documentDigest: candidate.repositoryModelBindings.documentDigest,
          bindings: Object.fromEntries(candidate.resolvedRoles.map((role) => [role.roleId, {
            agentProvider: { identity: role.agentProviderId, version: role.agentProviderVersion },
            model: { provider: role.modelProviderId, model: role.modelId },
          }])),
        };
      const reconstructed = createDeliveryManifestV2({
        deliveryId: candidate.deliveryId,
        taskId: candidate.taskId,
        ...(candidate.taskDisplayName === undefined ? {} : { taskDisplayName: candidate.taskDisplayName }),
        createdAt: candidate.createdAt,
        canonicalWorktree: candidate.canonicalWorktree,
        workflowPackage: candidate.workflowPackage,
        workflowSnapshot: candidate.workflowSnapshot,
        agentActionRoles,
        repositoryModelBindings,
        resolvedRoleBindings: {
          schemaVersion: "execution.resolved-role-provider-bindings@2.0.0",
          resolvedRoles: candidate.resolvedRoles,
          resolvedMapDigest: candidate.repositoryModelBindings.resolvedMapDigest,
        },
        promptSnapshot: {
          schemaVersion: "execution.task-prompt-snapshot@1.0.0",
          identity: candidate.prompt.snapshotIdentity,
          digest: candidate.prompt.snapshotDigest,
          path: candidate.prompt.snapshotPath,
          textPath: join(candidate.prompt.snapshotPath, "prompt.txt"),
          attachments: [],
        },
        deliveryConfigProjection: candidate.deliveryConfigProjection,
      });
      if (candidate.prompt.taskPromptIdentity !== candidate.prompt.snapshotIdentity
        || reconstructed.deliveryBindingIdentity !== candidate.deliveryBindingIdentity) throw new Error("invalid identity");
      return reconstructed;
    } catch {
      throw new DeliveryBindingError("DELIVERY_MANIFEST_INVALID");
    }
  }

  async discard(path: string): Promise<void> {
    const absolute = resolve(path);
    if (!isAbsolute(path) || resolve(absolute, "..") !== this.#root) throw new DeliveryBindingError("DELIVERY_MANIFEST_INVALID");
    await rm(absolute, { force: true });
  }
}
