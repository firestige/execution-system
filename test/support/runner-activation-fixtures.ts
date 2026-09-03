import { activationBindingDigest } from "../../src/contracts/compiler.js";
import type { RunnerActivationContext } from "../../src/contracts/runner-activation.js";

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validRunnerActivation(overrides: Partial<RunnerActivationContext> = {}): RunnerActivationContext {
  const absent = { kind: "ABSENT" } as const;
  const draft = {
    schemaVersion: "runner.activation@1.0.0",
    bindingIdentity: `sha256:${"0".repeat(64)}`,
    correlation: {
      deliveryIdentity: "delivery.fixture",
      taskIdentity: "task.fixture",
      manifestBindingIdentity: `sha256:${"1".repeat(64)}`,
      packageIdentity: "package.fixture",
      packageDigest: `sha256:${"2".repeat(64)}`,
      snapshotIdentity: "snapshot.fixture",
      snapshotDigest: `sha256:${"3".repeat(64)}`,
      workflowIdentity: "workflow.fixture",
      runtimeProfileIdentity: "runtime-profile.fixture",
    },
    program: {
      control: { entryNode: "node.action", nodes: [{ id: "node.action", kind: "action", action: "action.fixture" }], ordinarySuccessor: [{ id: "edge.done", from: "node.action", to: "terminal.success" }], eventSuccessor: [], decisions: [], controls: [], terminals: [{ id: "terminal.success", kind: "success", meaning: "done" }] },
      execution: {
        actions: { "action.fixture": { identity: "action.fixture", purpose: "fixture", inputSchema: absent, resultSchema: {}, gate: { freeTextBypass: "prohibited" } } },
        sites: [{ site: { kind: "node", nodeIdentity: "node.action" }, actionIdentity: "action.fixture", executor: { kind: "agent", identity: "executor.fixture", requiredCapabilities: ["structured-completion"] } }],
        agents: {
          "executor.fixture": {
            identity: "executor.fixture", bindingIdentity: `sha256:${"4".repeat(64)}`, sessionCompatibilityIdentity: `sha256:${"5".repeat(64)}`,
            session: {
              roleIdentity: "role.fixture", routeIdentity: "route.fixture",
              agent: { resourceIdentity: "agent.fixture", contentIdentity: `sha256:${"6".repeat(64)}`, projectionIdentity: `sha256:${"7".repeat(64)}`, localReadOnlyPath: "/admitted/agent.md" },
              model: { resourceIdentity: "model.fixture", contentIdentity: `sha256:${"8".repeat(64)}`, projectionIdentity: `sha256:${"9".repeat(64)}`, providerModelIdentity: "deepseek-chat", configuration: {} },
              driver: { resourceIdentity: "driver.fixture", projectionIdentity: `sha256:${"a".repeat(64)}`, providerIdentity: "dsh-headless", configuration: {} },
              instructions: { resourceIdentity: "instruction.fixture", contentIdentity: `sha256:${"b".repeat(64)}`, localReadOnlyPath: "/admitted/instruction.md" },
              tools: [], providedCapabilities: ["structured-completion"], policy: { identity: "session.fixture", scope: { kind: "episode" }, isolation: "isolated" },
            },
            turn: { access: [{ mode: "read", path: "." }] },
          },
        },
        hostOperations: {},
      },
      dataflow: { edges: [] },
    },
    initial: {
      state: { identity: `sha256:${"c".repeat(64)}`, values: {} },
      artifacts: { identity: `sha256:${"d".repeat(64)}`, versions: {} },
      workspace: { identity: "workspace.fixture", canonicalWorktreePath: "/admitted/worktree", admittedGitTree: "tree.fixture" },
    },
    admission: { contractRevision: "agentops.workflow-dsl@2.0.0", authorityMergeIdentity: `sha256:${"e".repeat(64)}`, deliveryAdmissionContractIdentity: "agentops.delivery-admission@2.0.0" },
    ...overrides,
  } as unknown as RunnerActivationContext;
  if (overrides.bindingIdentity === undefined) {
    (draft as { bindingIdentity: `sha256:${string}` }).bindingIdentity = activationBindingDigest(draft);
  }
  return deepFreeze(draft);
}

export function mutatedRunnerActivation(mutate: (draft: any) => void): RunnerActivationContext {
  const draft = structuredClone(validRunnerActivation()) as any;
  mutate(draft);
  draft.bindingIdentity = activationBindingDigest(draft as RunnerActivationContext);
  return deepFreeze(draft as RunnerActivationContext);
}
