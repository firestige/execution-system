import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  activationBindingDigest,
  canonicalDigest,
  validateRunnerActivation,
  type ExecutionSiteRef,
  type FrozenJsonValue,
  type RunnerActivationContext,
} from "../../../src/contracts/index.js";

interface FirstPartyCompileOptions {
  readonly definitionDirectory: string;
  readonly workspaceDirectory: string;
}

async function json(filename: string): Promise<any> {
  return JSON.parse(await readFile(filename, "utf8"));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function rawDigest(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function target(value: string): string {
  return value.startsWith("terminal:") ? value.slice("terminal:".length) : value;
}

function siteForNode(node: any): ExecutionSiteRef | undefined {
  if (node.kind === "action" || node.kind === "recovery" || node.kind === "cleanup") {
    return { kind: "node", nodeIdentity: node.id } as ExecutionSiteRef;
  }
  return undefined;
}

function admittedNode(node: any): any {
  if (node.kind === "action") return { id: node.id, kind: "action", action: node.action };
  if (node.kind === "parallel") return {
    id: node.id,
    kind: "parallel",
    branches: node.branches,
    maxConcurrency: node.maxConcurrency,
    ...(node.selection === undefined ? {} : { selection: node.selection }),
    join: { action: node.join.action },
  };
  if (node.kind === "wait") return { id: node.id, kind: "wait", wait: node.wait, continuationSource: true };
  if (node.kind === "wait-renewal") return { id: node.id, kind: "wait-renewal", wait: node.wait, maxRenewals: node.maxRenewals };
  if (node.kind === "recovery") return { id: node.id, kind: "recovery", recovery: node.recovery, ...(node.action === undefined ? {} : { action: node.action }), continuationSource: true };
  if (node.kind === "cleanup") return { id: node.id, kind: "cleanup", disposition: node.disposition, action: node.action };
  throw new TypeError(`unsupported first-party node '${node.id}'`);
}

function initialValue(field: any): FrozenJsonValue {
  if (field.name === "currentGoal") return "goal.qualification";
  if (field.name === "currentRung") return "rung.qualification";
  if (field.name === "status") return "pending";
  if (field.type === "integer" || field.type === "number") return 0;
  if (field.type === "boolean") return false;
  if (field.type === "array") return [];
  if (field.type === "string") return `qualification.${field.name}`;
  return {};
}

export async function buildFirstPartyCompileActivation(options: FirstPartyCompileOptions): Promise<RunnerActivationContext> {
  const definition = await realpath(options.definitionDirectory);
  const workspace = await realpath(options.workspaceDirectory);
  const [pkg, snapshot, workflow, actionsDocument, routesDocument, artifactsDocument] = await Promise.all([
    json(path.join(definition, "package.json")),
    json(path.join(definition, "snapshot.json")),
    json(path.join(definition, "workflow.json")),
    json(path.join(definition, "actions.json")),
    json(path.join(definition, "routes.json")),
    json(path.join(definition, "artifacts.json")),
  ]);
  if (pkg.schemaVersion !== "agentops.workflow-dsl@2.0.0"
    || snapshot.schemaVersion !== pkg.schemaVersion
    || workflow.schemaVersion !== pkg.schemaVersion
    || snapshot.snapshot.package.digest !== pkg.package.digest
    || snapshot.snapshot.definition.contentIdentity !== pkg.package.definition.contentIdentity) {
    throw new TypeError("first-party Package is not qualified for Runner projection");
  }

  const actionById = new Map(actionsDocument.actions.map((action: any) => [action.id, action]));
  const routeById = new Map(routesDocument.routes.map((route: any) => [route.id, route]));
  const resources = new Map([...pkg.resources.owned, ...pkg.resources.referenced].map((resource: any) => [resource.id, resource]));
  const workflowPath = path.join(definition, pkg.documents.workflow);
  const agents: Record<string, any> = {};
  const sites: any[] = [];
  const hostOperations: Record<string, any> = Object.fromEntries((workflow.hostOperations ?? []).map((operation: any) => [operation.id, {
    identity: operation.id,
    contractIdentity: operation.contractIdentity,
    configuration: operation.configuration,
    requiredCapabilities: operation.requiredCapabilities,
  }]));

  const operationFor = (action: any): string => {
    const validator = action.gate.deterministic?.[0];
    const operation = Object.values(hostOperations).find((candidate: any) => candidate.configuration.validator === validator) as any;
    if (operation === undefined) throw new TypeError(`deterministic Action '${action.id}' has no admitted Host operation`);
    return operation.identity;
  };

  const addSite = async (site: ExecutionSiteRef, actionIdentity: string) => {
    const action = actionById.get(actionIdentity) as any;
    if (action === undefined) throw new TypeError(`site references unknown Action '${actionIdentity}'`);
    const routeIdentity = Array.isArray(action.allowedRoutes) ? action.allowedRoutes[0] : undefined;
    if (routeIdentity === undefined) {
      sites.push({ site, actionIdentity, executor: { kind: "host-operation", identity: operationFor(action) } });
      return;
    }
    const route = routeById.get(routeIdentity) as any;
    if (route === undefined) throw new TypeError(`Action '${actionIdentity}' has no admitted Route`);
    const executorIdentity = `executor.${actionIdentity.slice("action.".length)}`;
    if (agents[executorIdentity] === undefined) {
      const promptRef = route.resources.actionPrompts.find((binding: any) => binding.action === actionIdentity)?.prompt?.id;
      const promptResource = resources.get(promptRef) as any;
      const promptPath = promptResource?.owner === "owned" ? await realpath(path.join(definition, promptResource.path)) : workflowPath;
      const promptBytes = await readFile(promptPath);
      const session = {
        roleIdentity: route.role,
        routeIdentity: route.id,
        agent: {
          resourceIdentity: route.resources.rolePrompt.id,
          contentIdentity: resources.get(route.resources.rolePrompt.id).contentIdentity,
          projectionIdentity: canonicalDigest({ package: pkg.package.digest, route: route.id, projection: "agent" }),
          localReadOnlyPath: promptPath,
        },
        model: {
          resourceIdentity: `model.${route.role}`,
          contentIdentity: canonicalDigest({ package: pkg.package.digest, role: route.role, model: "qualification-model" }),
          projectionIdentity: canonicalDigest({ package: pkg.package.digest, route: route.id, projection: "model" }),
          providerModelIdentity: "deepseek-chat",
          configuration: {},
        },
        driver: {
          resourceIdentity: route.resources.driver.id,
          projectionIdentity: canonicalDigest({ package: pkg.package.digest, route: route.id, projection: "driver" }),
          providerIdentity: "dsh-headless",
          configuration: { providerRoute: "deepseek", credentialRef: "QUALIFICATION_KEY", baseURL: "http://127.0.0.1:1" },
        },
        instructions: {
          resourceIdentity: promptRef ?? `instruction.${actionIdentity}`,
          contentIdentity: rawDigest(promptBytes),
          localReadOnlyPath: promptPath,
        },
        skills: [],
        tools: (route.resources.tools ?? []).map((tool: any) => ({
          resourceIdentity: tool.id,
          contentIdentity: canonicalDigest({ package: pkg.package.digest, tool: tool.id }),
          localReadOnlyPath: { kind: "ABSENT" },
          configuration: { toolName: `workspace_${tool.id.replaceAll(".", "_")}`, workspaceAccess: true },
        })),
        providedCapabilities: route.resources.capabilities,
        policy: { identity: `session.${route.id}`, scope: route.resources.sessionPolicy.scope, isolation: route.resources.sessionPolicy.isolation },
      };
      const turn = { access: [{ mode: "read", path: "README.md" }] };
      agents[executorIdentity] = {
        identity: executorIdentity,
        sessionCompatibilityIdentity: canonicalDigest(session),
        bindingIdentity: canonicalDigest({ session, turn }),
        session,
        turn,
      };
    }
    sites.push({ site, actionIdentity, executor: { kind: "agent", identity: executorIdentity, requiredCapabilities: route.resources.capabilities } });
  };

  for (const node of workflow.graph.nodes) {
    const nodeSite = siteForNode(node);
    if (nodeSite !== undefined && node.action !== undefined) await addSite(nodeSite, node.action);
    if (node.kind === "parallel") {
      for (const branch of node.branches) await addSite({ kind: "parallel-branch", nodeIdentity: node.id, branchIdentity: branch.id } as ExecutionSiteRef, branch.action);
      await addSite({ kind: "parallel-join", nodeIdentity: node.id } as ExecutionSiteRef, node.join.action);
    }
  }

  const decisions: any[] = [];
  const ordinarySuccessor = workflow.graph.edges.map((edge: any) => ({ ...edge, to: target(edge.to) }));
  for (const node of workflow.graph.nodes) {
    if (node.routing !== undefined) {
      const identity = `decision.${node.id}`;
      const sourceSite = node.kind === "parallel"
        ? { kind: "parallel-join", nodeIdentity: node.id }
        : { kind: "node", nodeIdentity: node.id };
      decisions.push({
        identity,
        source: { kind: "site-result", site: sourceSite, slot: { kind: "property", name: node.routing.output } },
        selector: { kind: "case-map", cases: node.routing.cases.map((entry: any) => ({ value: entry.value, target: target(entry.target) })) },
      });
      ordinarySuccessor.push({ id: `edge.${node.id}.decision`, from: node.id, to: identity });
    }
    if (node.kind === "parallel" && node.selection !== undefined) {
      decisions.push({ identity: `decision.${node.id}.selection`, source: node.selection.source });
    }
  }

  const controls: any[] = [];
  for (const wait of workflow.waits ?? []) {
    const waitNode = workflow.graph.nodes.find((node: any) => node.kind === "wait" && node.wait === wait.id);
    const predecessor = workflow.graph.nodes.find((node: any) => node.routing?.cases?.some((entry: any) => entry.target === waitNode?.id));
    if (waitNode === undefined || predecessor === undefined) throw new TypeError(`Wait '${wait.id}' has no admitted resume predecessor`);
    const controlIdentity = `control.${wait.id}`;
    const decisionIdentity = `decision.resume.${wait.id}`;
    const operationIdentity = `operation.resume.${wait.id}`;
    hostOperations[operationIdentity] = {
      identity: operationIdentity,
      contractIdentity: "host-operation.deterministic-selection.v1",
      configuration: { waitIdentity: wait.id },
      requiredCapabilities: ["deterministic-selection"],
    };
    decisions.push({
      identity: decisionIdentity,
      source: { kind: "control-result", controlIdentity, slot: { kind: "whole" } },
      selector: { kind: "host-operation", operationIdentity, allowedTargets: [predecessor.id] },
    });
    const renewal = workflow.graph.nodes.find((node: any) => node.kind === "wait-renewal" && node.wait === wait.id);
    controls.push({
      identity: controlIdentity,
      nodeIdentity: waitNode.id,
      kind: wait.kind === "user" ? "user" : "external-workflow",
      resultSchema: wait.resumeSchema,
      correlation: wait.correlation,
      expiry: renewal === undefined ? { mode: "incomplete", maxRenewals: 0 } : { mode: "renew", maxRenewals: renewal.maxRenewals },
      resumeDecision: decisionIdentity,
    });
  }

  const values = Object.fromEntries(workflow.state.fields.map((field: any) => [field.name, initialValue(field)]));
  const artifactVersions = Object.fromEntries(artifactsDocument.artifacts.map((artifact: any) => [artifact.id, { kind: "ABSENT" }]));
  const actionTemplates = Object.fromEntries(actionsDocument.actions.map((action: any) => [action.id, {
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
      deliveryIdentity: `delivery.qualification.${workflow.workflow.id}`,
      taskIdentity: `task.qualification.${workflow.workflow.id}`,
      manifestBindingIdentity: canonicalDigest({ package: pkg.package.digest, snapshot: snapshot.snapshot.digest }),
      packageIdentity: `${pkg.package.name}@${pkg.package.version}`,
      packageDigest: pkg.package.digest,
      snapshotIdentity: snapshot.snapshot.id,
      snapshotDigest: snapshot.snapshot.digest,
      workflowIdentity: `${workflow.workflow.id}@${workflow.workflow.version}`,
      runtimeProfileIdentity: "runtime-profile.runner.langgraph-dsh",
    },
    program: {
      control: {
        entryNode: workflow.graph.start,
        nodes: workflow.graph.nodes.map(admittedNode),
        ordinarySuccessor,
        eventSuccessor: workflow.graph.eventEdges.map((edge: any) => ({ ...edge, to: target(edge.to) })),
        decisions,
        controls,
        terminals: workflow.graph.terminals,
      },
      execution: { actions: actionTemplates, sites, agents, hostOperations },
      dataflow: { edges: workflow.dataflow.edges.map(({ source, target: edgeTarget }: any) => ({ source, target: edgeTarget })) },
    },
    initial: {
      state: { identity: canonicalDigest({ package: pkg.package.digest, state: values }), values },
      artifacts: { identity: canonicalDigest({ package: pkg.package.digest, artifacts: artifactVersions }), versions: artifactVersions },
      workspace: {
        identity: `workspace.qualification.${workflow.workflow.id}`,
        canonicalWorktreePath: workspace,
        admittedGitTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: workspace, encoding: "utf8" }).trim(),
      },
    },
    admission: {
      contractRevision: "agentops.workflow-dsl@2.0.0",
      authorityMergeIdentity: canonicalDigest({ authority: pkg.authority, proof: snapshot.snapshot.authority.mergeProof }),
      deliveryAdmissionContractIdentity: "agentops.delivery-admission@2.0.0",
    },
  };
  draft.bindingIdentity = activationBindingDigest(draft);
  return validateRunnerActivation(deepFreeze(draft));
}
