import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { coordinateIdentity } from "../../src/configuration/index.js";

import {
  createDeliveryManifestProjection,
  createDeliveryManifestV2,
  resolveRoleModelBindings,
  type CreateDeliveryManifestV2Input,
  type DeliveryConfigProjectionV2,
  type ImmutableTaskPromptSnapshot,
  type RepositoryModelBindingsSnapshot,
} from "../../src/delivery/index.js";

const sha = (character: string): string => `sha256:${character.repeat(64)}`;

async function fixture(): Promise<CreateDeliveryManifestV2Input> {
  const root = await mkdtemp(join(tmpdir(), "delivery-manifest-v2-"));
  const repository: RepositoryModelBindingsSnapshot = Object.freeze({
    schemaVersion: "execution.repository-model-bindings-snapshot@1.0.0",
    documentState: "PRESENT",
    documentDigest: sha("c"),
    bindings: Object.freeze({ "role.reviewer": Object.freeze({ provider: "anthropic-official", model: "claude-sonnet" }) }),
  });
  const agentActionRoles = Object.freeze([
    Object.freeze({ roleId: "role.facilitator", rolePromptIdentity: "role.prompt.facilitator", rolePromptDigest: sha("a") }),
    Object.freeze({ roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("b") }),
  ]);
  const resolved = resolveRoleModelBindings({
    agentProviderId: "provider.dsh",
    defaultModel: { provider: "deepseek-official", model: "deepseek-chat" },
    repository,
    agentActionRoles,
  });
  const promptSnapshot: ImmutableTaskPromptSnapshot = Object.freeze({
    schemaVersion: "execution.task-prompt-snapshot@1.0.0",
    identity: sha("d"),
    digest: sha("e"),
    path: join(root, "private", "prompt"),
    textPath: join(root, "private", "prompt", "prompt.txt"),
    attachments: Object.freeze([]),
  });
  const deliveryConfigProjectionValue = Object.freeze({
      schemaVersion: "execution.delivery-config@2.0.0",
      paths: Object.freeze({
        repositoryRoot: join(root, "repository"),
        workspaceRoot: join(root, "workspace"),
        allowedWorktreeRoots: Object.freeze([join(root, "workspace", "worktrees")]),
        runnerResources: Object.freeze({ journal: "runner/journal", checkpoints: "runner/checkpoints", sessions: "runner/sessions", custody: "runner/custody" }),
      }),
      runner: Object.freeze({ implementationKey: "runner.v2", host: Object.freeze({ engine: "langgraph" }), provider: Object.freeze({ identity: "provider.dsh", maxParallelToolCalls: 4 }) }),
      controls: Object.freeze({ executionTimeoutMs: 1000, maxConcurrentDeliveries: 4, allowExplicitRefresh: false }),
    });
  const deliveryConfigProjection: DeliveryConfigProjectionV2 = Object.freeze({
    value: deliveryConfigProjectionValue,
    identity: coordinateIdentity("execution.delivery-config@2.0.0", deliveryConfigProjectionValue as never),
  });
  return {
    deliveryId: "delivery-1",
    taskId: "task-1",
    taskDisplayName: "Review the Agent configuration",
    createdAt: 1_788_000_000_000,
    canonicalWorktree: join(root, "workspace", "worktrees", "delivery-1"),
    workflowPackage: {
      name: "system-design",
      exactVersion: "2.0.0",
      packageDigest: sha("1"),
      localMaterializationPath: join(root, "packages", "system-design", "2.0.0"),
    },
    workflowSnapshot: {
      workflowId: "workflow.system-design",
      workflowVersion: "2.0.0",
      snapshotId: `workflow.system-design@2.0.0:${sha("2")}`,
      snapshotDigest: sha("2"),
    },
    agentActionRoles,
    repositoryModelBindings: repository,
    resolvedRoleBindings: resolved,
    promptSnapshot,
    deliveryConfigProjection,
  };
}

describe("Delivery Manifest 2.0", () => {
  it("creates one frozen closed Manifest whose identity covers Workflow, repository, Role, prompt, worktree, and config bindings", async () => {
    const input = await fixture();
    const manifest = createDeliveryManifestV2(input);

    expect(manifest).toMatchObject({
      schemaVersion: "execution.delivery-manifest@2.0.0",
      deliveryId: "delivery-1",
      taskId: "task-1",
      workflowPackage: { name: "system-design", exactVersion: "2.0.0", packageDigest: sha("1") },
      workflowSnapshot: { workflowId: "workflow.system-design", workflowVersion: "2.0.0", snapshotDigest: sha("2") },
      repositoryModelBindings: { documentState: "PRESENT", documentDigest: sha("c"), resolvedMapDigest: input.resolvedRoleBindings.resolvedMapDigest },
      resolvedRoles: input.resolvedRoleBindings.resolvedRoles,
      deliveryBindingIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(Object.isFrozen(manifest)).toBe(true);

    const changedProjectionValue = {
      ...input.deliveryConfigProjection.value,
      controls: { ...input.deliveryConfigProjection.value.controls, executionTimeoutMs: 2000 },
    };
    const mutations: CreateDeliveryManifestV2Input[] = [
      { ...input, workflowPackage: { ...input.workflowPackage, packageDigest: sha("3") } },
      { ...input, workflowSnapshot: { ...input.workflowSnapshot, snapshotDigest: sha("4") } },
      { ...input, promptSnapshot: { ...input.promptSnapshot, digest: sha("5") } },
      { ...input, canonicalWorktree: `${input.canonicalWorktree}-changed` },
      { ...input, deliveryConfigProjection: {
        value: changedProjectionValue,
        identity: coordinateIdentity("execution.delivery-config@2.0.0", changedProjectionValue as never),
      } },
    ];
    for (const mutation of mutations) expect(createDeliveryManifestV2(mutation).deliveryBindingIdentity).not.toBe(manifest.deliveryBindingIdentity);
  });

  it("fails Role closure when a resolved Role or prompt binding does not equal the exact Snapshot Role set", async () => {
    const input = await fixture();
    const cases = [
      { ...input, agentActionRoles: input.agentActionRoles.slice(0, 1) },
      { ...input, agentActionRoles: input.agentActionRoles.map((role) => role.roleId === "role.reviewer" ? { ...role, rolePromptDigest: sha("9") } : role) },
      { ...input, resolvedRoleBindings: { ...input.resolvedRoleBindings, resolvedMapDigest: sha("8") } },
    ];
    for (const candidate of cases) expect(() => createDeliveryManifestV2(candidate)).toThrowError(expect.objectContaining({ code: "DELIVERY_BINDING_INVALID" }));
  });

  it("creates a deterministic evidence-safe projection without local paths, prompt data, Source, endpoint, or credentials", async () => {
    const input = await fixture();
    const manifest = createDeliveryManifestV2(input);

    const first = createDeliveryManifestProjection(manifest);
    const retry = createDeliveryManifestProjection(manifest);

    expect(first).toEqual(retry);
    expect(first.projection).toMatchObject({
      schema_version: "execution.delivery-manifest-projection@1.0.0",
      delivery_id: manifest.deliveryId,
      task_id: manifest.taskId,
      manifest_digest: manifest.deliveryBindingIdentity.slice("sha256:".length),
      workflow: {
        package_name: "system-design",
        exact_package_version: "2.0.0",
        package_digest: sha("1"),
        workflow_id: "workflow.system-design",
        workflow_version: "2.0.0",
        snapshot_digest: sha("2"),
      },
      repository_model_bindings: {
        document_state: "PRESENT",
        document_digest: sha("c"),
        resolved_map_digest: manifest.repositoryModelBindings.resolvedMapDigest,
      },
      roles: [
        {
          role_id: "role.facilitator",
          role_prompt_identity: "role.prompt.facilitator",
          role_prompt_digest: sha("a"),
          agent_provider_id: "provider.dsh",
          model_provider_id: "deepseek-official",
          model_id: "deepseek-chat",
          resolution_source: "EXECUTION_DEFAULT",
        },
        { role_id: "role.reviewer", resolution_source: "REPOSITORY" },
      ],
    });
    expect(first.projectionDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Buffer.byteLength(first.canonicalJson, "utf8")).toBeLessThanOrEqual(65_536);
    for (const prohibited of [input.canonicalWorktree, input.workflowPackage.localMaterializationPath, input.promptSnapshot.path, "taskDisplayName", "workflowSource", "baseUrl", "credentialRef"]) {
      expect(first.canonicalJson).not.toContain(prohibited);
    }
  });

  it("represents absent repository policy without a document digest", async () => {
    const input = await fixture();
    const repositoryModelBindings: RepositoryModelBindingsSnapshot = Object.freeze({
      schemaVersion: "execution.repository-model-bindings-snapshot@1.0.0",
      documentState: "ABSENT",
    });
    const resolvedRoleBindings = resolveRoleModelBindings({
      agentProviderId: "provider.dsh",
      defaultModel: { provider: "deepseek-official", model: "deepseek-chat" },
      repository: repositoryModelBindings,
      agentActionRoles: input.agentActionRoles,
    });
    const manifest = createDeliveryManifestV2({ ...input, repositoryModelBindings, resolvedRoleBindings });

    expect(manifest.repositoryModelBindings).toEqual({ documentState: "ABSENT", resolvedMapDigest: resolvedRoleBindings.resolvedMapDigest });
    expect(createDeliveryManifestProjection(manifest).projection.repository_model_bindings).not.toHaveProperty("document_digest");
  });
});
