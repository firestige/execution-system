import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  activationBindingDigest,
  canonicalDigest,
  validateRunnerActivation,
  type RunnerActivationContext,
} from "../../../src/contracts/index.js";

interface MinimalBuilderOptions {
  readonly corpusDirectory: string;
  readonly workspaceDirectory: string;
  readonly baseURL: string;
  readonly deliveryIdentity?: string;
}

interface RawAction {
  readonly id: string;
  readonly purpose: string;
  readonly inputSchema: Record<string, unknown>;
  readonly resultSchema: Record<string, unknown>;
  readonly gate: { readonly deterministic?: readonly string[]; readonly freeTextBypass: "prohibited" };
}

function digestBytes(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

async function json(filename: string): Promise<any> {
  return JSON.parse(await readFile(filename, "utf8"));
}

function normalizedTarget(target: string): string {
  return target.startsWith("terminal:") ? target.slice("terminal:".length) : target;
}

function promptFor(action: string): string {
  return action.replace("action.review.", "review-").replace("action.", "");
}

export async function buildMinimalRunnerActivation(options: MinimalBuilderOptions): Promise<RunnerActivationContext> {
  const corpus = await realpath(options.corpusDirectory);
  const workspace = await realpath(options.workspaceDirectory);
  const [packageDocument, snapshotDocument, workflowDocument, actionsDocument, routesDocument] = await Promise.all([
    json(path.join(corpus, "package.json")), json(path.join(corpus, "snapshot.json")), json(path.join(corpus, "workflow.json")),
    json(path.join(corpus, "actions.json")), json(path.join(corpus, "routes.json")),
  ]);
  if (packageDocument.schemaVersion !== "agentops.workflow-dsl@2.0.0"
    || snapshotDocument.schemaVersion !== packageDocument.schemaVersion
    || workflowDocument.schemaVersion !== packageDocument.schemaVersion
    || actionsDocument.schemaVersion !== packageDocument.schemaVersion
    || routesDocument.schemaVersion !== packageDocument.schemaVersion
    || snapshotDocument.snapshot.package.digest !== packageDocument.package.digest
    || snapshotDocument.snapshot.definition.contentIdentity !== packageDocument.package.definition.contentIdentity) {
    throw new TypeError("minimal corpus identity closure is invalid");
  }
  const actions = actionsDocument.actions as readonly RawAction[];
  const actionById = Object.fromEntries(actions.map((action) => [action.id, action]));
  const routeByAction = new Map<string, any>();
  for (const route of routesDocument.routes) for (const prompt of route.resources.actionPrompts) routeByAction.set(prompt.action, route);
  const syntheticResource = (kind: string, value: unknown) => canonicalDigest({ kind, value, corpus: packageDocument.package.digest });
  const agents: Record<string, any> = {};
  const sites: any[] = [];
  const agentActions = ["action.intake", "action.review.blackbox", "action.review.whitebox", "action.aggregate"];
  for (const actionIdentity of agentActions) {
    const route = routeByAction.get(actionIdentity);
    if (route === undefined) throw new TypeError(`minimal corpus has no route for '${actionIdentity}'`);
    const executorIdentity = `executor.${actionIdentity.slice("action.".length)}`;
    const promptPath = path.join(corpus, "prompts/actions", `${promptFor(actionIdentity)}.prompt.md`);
    const promptBytes = await readFile(promptPath);
    const session = {
      roleIdentity: route.role,
      routeIdentity: route.id,
      agent: {
        resourceIdentity: `instruction.${actionIdentity.slice("action.".length)}`,
        contentIdentity: digestBytes(promptBytes),
        projectionIdentity: syntheticResource("agent-projection", { route: route.id }),
        localReadOnlyPath: promptPath,
      },
      model: {
        resourceIdentity: "model.managed",
        contentIdentity: syntheticResource("model", "deepseek-chat"),
        projectionIdentity: syntheticResource("model-projection", { provider: "deepseek", model: "deepseek-chat" }),
        providerModelIdentity: "deepseek-chat",
        configuration: {},
      },
      driver: {
        resourceIdentity: "driver.managed-cli",
        projectionIdentity: syntheticResource("driver-projection", { providerRoute: "deepseek", baseURL: options.baseURL }),
        providerIdentity: "dsh-headless",
        configuration: { providerRoute: "deepseek", credentialRef: "WALKING_SKELETON_KEY", baseURL: options.baseURL },
      },
      instructions: {
        resourceIdentity: `instruction.${actionIdentity.slice("action.".length)}`,
        contentIdentity: digestBytes(promptBytes),
        localReadOnlyPath: promptPath,
      },
      skills: [],
      tools: route.resources.tools.map((tool: { id: string }) => ({
        resourceIdentity: tool.id,
        contentIdentity: syntheticResource("tool", tool.id),
        localReadOnlyPath: { kind: "ABSENT" },
        configuration: { toolName: `workspace_${tool.id.replaceAll(".", "_")}`, workspaceAccess: true },
      })),
      providedCapabilities: route.resources.capabilities,
      policy: { identity: `session.${route.id}`, scope: { kind: "episode" }, isolation: route.resources.sessionPolicy.isolation },
    };
    const turn = { access: [{ mode: "read", path: "README.md" }, { mode: "write", path: "run" }] };
    agents[executorIdentity] = {
      identity: executorIdentity,
      sessionCompatibilityIdentity: canonicalDigest(session),
      bindingIdentity: canonicalDigest({ session, turn }),
      session,
      turn,
    };
    const site = actionIdentity === "action.review.blackbox"
      ? { kind: "parallel-branch", nodeIdentity: "node.review", branchIdentity: "branch.blackbox" }
      : actionIdentity === "action.review.whitebox"
        ? { kind: "parallel-branch", nodeIdentity: "node.review", branchIdentity: "branch.whitebox" }
        : actionIdentity === "action.aggregate"
          ? { kind: "parallel-join", nodeIdentity: "node.review" }
          : { kind: "node", nodeIdentity: "node.intake" };
    sites.push({ site, actionIdentity, executor: { kind: "agent", identity: executorIdentity, requiredCapabilities: ["structured-completion"] } });
  }
  sites.push({
    site: { kind: "node", nodeIdentity: "node.finalize" },
    actionIdentity: "action.finalize",
    executor: { kind: "host-operation", identity: "operation.finalize" },
  });

  const nodes = workflowDocument.graph.nodes.map((node: any) => {
    if (node.kind === "action") return { id: node.id, kind: node.kind, action: node.action };
    if (node.kind === "parallel") return {
      id: node.id, kind: node.kind, branches: node.branches, maxConcurrency: node.maxConcurrency,
      selection: node.selection, join: { action: node.join.action },
    };
    if (node.kind === "wait") return { id: node.id, kind: node.kind, wait: node.wait, continuationSource: true };
    return { id: node.id, kind: node.kind, wait: node.wait, maxRenewals: node.maxRenewals };
  });
  const decisions = [
    {
      identity: "decision.intake", source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.intake" }, slot: { kind: "property", name: "status" } },
      selector: { kind: "case-map", cases: [{ value: "confirmed", target: "node.review" }, { value: "needs-user", target: "node.wait-confirm" }] },
    },
    {
      identity: "decision.review", source: { kind: "site-result", site: { kind: "parallel-join", nodeIdentity: "node.review" }, slot: { kind: "property", name: "routing" } },
      selector: { kind: "case-map", cases: [{ value: "finalize", target: "node.finalize" }, { value: "re-review", target: "node.review" }, { value: "fail", target: "FAILED" }] },
    },
    {
      identity: "decision.wait-confirm", source: { kind: "control-result", controlIdentity: "control.wait-confirm", slot: { kind: "property", name: "confirmed" } },
      selector: { kind: "case-map", cases: [{ value: true, target: "node.review" }, { value: false, target: "node.wait-confirm-renewal" }] },
    },
    { identity: "decision.review-selection", source: { kind: "state", field: "selectedReviewLenses" } },
  ];
  const eventSuccessor = workflowDocument.graph.eventEdges.map((edge: any) => ({ ...edge, to: normalizedTarget(edge.to) }));
  const actionTemplates = Object.fromEntries(actions.map((action) => [action.id, {
    identity: action.id,
    purpose: action.purpose,
    inputSchema: action.inputSchema,
    resultSchema: action.resultSchema,
    gate: action.gate,
  }]));
  const draft: any = {
    schemaVersion: "runner.activation@1.0.0",
    bindingIdentity: `sha256:${"0".repeat(64)}`,
    correlation: {
      deliveryIdentity: options.deliveryIdentity ?? "delivery.minimal-review",
      taskIdentity: "task.minimal-review",
      manifestBindingIdentity: canonicalDigest({ package: packageDocument.package.digest, snapshot: snapshotDocument.snapshot.digest }),
      packageIdentity: `${packageDocument.package.name}@${packageDocument.package.version}`,
      packageDigest: packageDocument.package.digest,
      snapshotIdentity: snapshotDocument.snapshot.id,
      snapshotDigest: snapshotDocument.snapshot.digest,
      workflowIdentity: `${workflowDocument.workflow.id}@${workflowDocument.workflow.version}`,
      runtimeProfileIdentity: "runtime-profile.runner.langgraph-dsh",
    },
    program: {
      control: {
        entryNode: workflowDocument.graph.start,
        nodes,
        ordinarySuccessor: [
          { id: "edge.intake-routing", from: "node.intake", to: "decision.intake" },
          { id: "edge.review-routing", from: "node.review", to: "decision.review" },
          ...workflowDocument.graph.edges.map((edge: any) => ({ ...edge, to: normalizedTarget(edge.to) })),
        ],
        eventSuccessor,
        decisions,
        controls: [{
          identity: "control.wait-confirm", nodeIdentity: "node.wait-confirm", kind: "user",
          resultSchema: workflowDocument.waits[0].resumeSchema,
          correlation: workflowDocument.waits[0].correlation,
          expiry: { mode: "renew", maxRenewals: 1 },
          resumeDecision: "decision.wait-confirm",
        }],
        terminals: workflowDocument.graph.terminals.map((terminal: any) => ({ id: terminal.id, kind: terminal.kind, meaning: terminal.meaning })),
      },
      execution: {
        actions: actionTemplates,
        sites,
        agents,
        hostOperations: {
          "operation.finalize": {
            identity: "operation.finalize",
            contractIdentity: "host-operation.finalize.v1",
            configuration: {},
            requiredCapabilities: ["deterministic-transformation"],
          },
          "operation.validate-status": {
            identity: "operation.validate-status",
            contractIdentity: "host-operation.strict-schema-validation.v1",
            configuration: { validator: "validator.intake-checks" },
            requiredCapabilities: ["deterministic-validation"],
          },
        },
      },
      dataflow: {
        edges: [
          ...workflowDocument.dataflow.edges.map((edge: any) => edge),
          { source: { kind: "state", field: "request" }, target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.intake" }, slot: { kind: "property", name: "request" } } },
          { source: { kind: "state", field: "candidate" }, target: { kind: "site-input", site: { kind: "parallel-branch", nodeIdentity: "node.review", branchIdentity: "branch.blackbox" }, slot: { kind: "property", name: "candidate" } } },
          { source: { kind: "state", field: "candidate" }, target: { kind: "site-input", site: { kind: "parallel-branch", nodeIdentity: "node.review", branchIdentity: "branch.whitebox" }, slot: { kind: "property", name: "candidate" } } },
          { source: { kind: "state", field: "candidate" }, target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.finalize" }, slot: { kind: "property", name: "candidate" } } },
        ],
      },
    },
    initial: {
      state: { identity: canonicalDigest({ state: "minimal-review-initial" }), values: {
        status: "pending", context: { source: "minimal-corpus" }, request: "review the admitted candidate", candidate: "candidate-v2",
        reviewIterations: 0, selectedReviewLenses: ["branch.blackbox", "branch.whitebox"],
      } },
      artifacts: { identity: canonicalDigest({ artifacts: "minimal-review-initial" }), versions: {
        "artifact.final-report": { kind: "ABSENT" }, "artifact.findings": { kind: "ABSENT" }, "artifact.findings.whitebox": { kind: "ABSENT" },
      } },
      workspace: {
        identity: "workspace.minimal-review",
        canonicalWorktreePath: workspace,
        admittedGitTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: workspace, encoding: "utf8" }).trim(),
      },
    },
    admission: {
      contractRevision: "agentops.workflow-dsl@2.0.0",
      authorityMergeIdentity: canonicalDigest({ authority: packageDocument.authority, snapshot: snapshotDocument.snapshot.authority }),
      deliveryAdmissionContractIdentity: "agentops.delivery-admission@2.0.0",
    },
  };
  draft.bindingIdentity = activationBindingDigest(draft);
  return validateRunnerActivation(deepFreeze(draft));
}
