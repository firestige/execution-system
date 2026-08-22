export type ActivationDraft = Record<string, any>;

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function baseActivation(): ActivationDraft {
  return {
    manifest: {
      revision: "manifest-revision-7",
      bindingIdentity: "manifest-binding-7",
      deliveryIdentity: "delivery-7",
      taskIdentity: "task-7",
      workflowIdentity: "workflow-7",
      workflowImplementationIdentity: "workflow-implementation-7",
      runtimeIdentity: "runner-runtime",
      runtimeProfileIdentity: "runner-profile-v1",
      packageIdentity: "package-7",
      snapshotIdentity: "snapshot-7",
      packageDigest: `sha256:${"a".repeat(64)}`,
      contractIdentity: "workflow-contract",
      contractVersion: "1.0.0",
      contractFamilyBinding: "workflow-contract@1",
      packageLocalReadOnlyPath: "/admitted/packages/package-7",
      workspaceIdentity: "workspace-7",
      canonicalWorktreePath: "/deliveries/delivery-7/worktree",
      actionIdentity: "action-7",
      roleIdentity: "role-7",
      routeIdentity: "route-7",
      driverResourceIdentity: "driver-resource-7",
      driverProjectionIdentity: "driver-projection-7",
      providerIdentity: "dsh-headless",
      resourceBindingIdentities: ["resource-binding-7"],
      requiredCapabilities: ["agent.invoke"],
      artifactIdentities: ["artifact-7"],
      interventionIdentity: { kind: "ABSENT" },
      controlIdentity: { kind: "ABSENT" },
    },
    delivery: { identity: "delivery-7" },
    task: { identity: "task-7", intent: "Apply the admitted local change" },
    workflow: {
      identity: "workflow-7",
      implementationIdentity: "workflow-implementation-7",
    },
    runtime: { identity: "runner-runtime", profileIdentity: "runner-profile-v1" },
    package: {
      identity: "package-7",
      snapshotIdentity: "snapshot-7",
      digest: `sha256:${"a".repeat(64)}`,
      contract: {
        identity: "workflow-contract",
        version: "1.0.0",
        familyBinding: "workflow-contract@1",
      },
      localReadOnlyPath: "/admitted/packages/package-7",
    },
    workspace: {
      identity: "workspace-7",
      canonicalWorktreePath: "/deliveries/delivery-7/worktree",
    },
    action: {
      identity: "action-7",
      roleIdentity: "role-7",
      routeIdentity: "route-7",
      driver: {
        resourceIdentity: "driver-resource-7",
        projectionIdentity: "driver-projection-7",
        providerIdentity: "dsh-headless",
        resourceBindingIdentities: ["resource-binding-7"],
        requiredCapabilities: ["agent.invoke"],
      },
    },
    artifacts: [{ identity: "artifact-7" }],
    lifecycle: {
      interventionIdentity: { kind: "ABSENT" },
      controlIdentity: { kind: "ABSENT" },
    },
  };
}

export function activationFixture(
  mutate?: (draft: ActivationDraft) => void,
  options: { readonly freeze?: boolean } = {},
): unknown {
  const draft = baseActivation();
  mutate?.(draft);
  return options.freeze === false ? draft : deepFreeze(draft);
}
