import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  activationBindingDigest,
  canonicalDigest,
  validateRunnerActivation,
  type ExecutionSiteRef,
  type FrozenJsonValue,
  type RunnerActivationContext,
} from "../contracts/index.js";
import type { DeliveryActivationProjector } from "./lifecycle.js";
import type { DeliveryManifest } from "./manifest.js";
import type { DeliveryManifestV2 } from "./manifest-v2.js";
import type { ResolvedRoleModelBinding } from "./resolved-role-model-bindings.js";
import { captureManagedWorkspaceTree } from "../custody/managed-workspace-snapshot.js";

type Document = Record<string, any>;
type ProjectedTaskPrompt = Readonly<{
  text: string;
  attachments: readonly Readonly<{
    identity: string;
    filename: string;
    mediaType: string;
    byteLength: number;
    digest: string;
    content: Readonly<{ encoding: "base64"; data: string }>;
  }>[];
}>;

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

async function json(filename: string): Promise<Document> {
  return JSON.parse(await readFile(filename, "utf8")) as Document;
}

async function definitionDirectory(localPath: string): Promise<string> {
  const material = await realpath(localPath);
  try {
    if ((await stat(path.join(material, "package.json"))).isFile()) return material;
  } catch { /* inspect the packaged layout below */ }
  if ((await stat(path.join(material, "definition", "package.json"))).isFile()) return path.join(material, "definition");
  throw new TypeError("resolved Workflow Package definition is unavailable");
}

function rawDigest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function target(value: string): string {
  return value.startsWith("terminal:") ? value.slice("terminal:".length) : value;
}

function siteForNode(node: Document): ExecutionSiteRef | undefined {
  return node.kind === "action" || node.kind === "recovery" || node.kind === "cleanup"
    ? ({ kind: "node", nodeIdentity: node.id } as ExecutionSiteRef)
    : undefined;
}

function admittedNode(node: Document): Document {
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
  throw new TypeError(`unsupported admitted node '${String(node.id)}'`);
}

function initialValue(field: Document, taskPrompt: ProjectedTaskPrompt): FrozenJsonValue {
  const name = String(field.name).toLowerCase();
  if (["task", "taskprompt", "intent", "request", "goal"].some((token) => name.includes(token))) return taskPrompt.text;
  if (field.name === "currentGoal") return "goal.delivery";
  if (field.name === "currentRung") return "rung.delivery";
  if (field.name === "status") return "pending";
  if (field.type === "integer" || field.type === "number") return 0;
  if (field.type === "boolean") return false;
  if (field.type === "array") return [];
  if (field.type === "string") return `delivery.${String(field.name)}`;
  return {};
}

function initialActionInput(action: Document, taskPrompt: ProjectedTaskPrompt, workspace: string): FrozenJsonValue {
  const schema = action.inputSchema as Document;
  const properties = schema?.properties as Document | undefined;
  const required = Array.isArray(schema?.required) ? schema.required as string[] : [];
  const entries = required.map((name): readonly [string, FrozenJsonValue] => {
    if (name === "request" || name === "intake" || name === "intent") return [name, taskPrompt.text];
    if (name === "prompt" || name === "taskPrompt") return [name, taskPrompt as FrozenJsonValue];
    if (name === "repository" || name === "worktree") return [name, workspace];
    const type = properties?.[name]?.type;
    if (type === "string") return [name, ""];
    if (type === "boolean") return [name, false];
    if (type === "integer" || type === "number") return [name, 0];
    if (type === "array") return [name, []];
    return [name, {}];
  });
  return Object.fromEntries(entries) as FrozenJsonValue;
}

async function verifyPromptSnapshot(manifest: DeliveryManifest | DeliveryManifestV2): Promise<ProjectedTaskPrompt> {
  const snapshotPath = manifest.prompt.snapshotPath;
  if (!(await stat(snapshotPath)).isDirectory()) throw new TypeError("TaskPrompt snapshot is unavailable");
  const record = await json(path.join(snapshotPath, "snapshot.json"));
  if (record.schemaVersion !== "execution.task-prompt-snapshot@1.0.0"
    || record.identity !== manifest.prompt.snapshotIdentity
    || record.identity !== manifest.prompt.taskPromptIdentity
    || record.digest !== manifest.prompt.snapshotDigest
    || JSON.stringify(record).includes("contentRef")) throw new TypeError("TaskPrompt snapshot binding is invalid");
  const text = await readFile(path.join(snapshotPath, String(record.textFile)), "utf8");
  const textDigest = rawDigest(Buffer.from(text, "utf8"));
  const attachmentBindings: Document[] = [];
  const projectedAttachments: ProjectedTaskPrompt["attachments"][number][] = [];
  for (const attachment of record.attachments as Document[]) {
    const bytes = await readFile(path.join(snapshotPath, String(attachment.file)));
    if (bytes.byteLength !== attachment.byteLength || rawDigest(bytes) !== attachment.digest) throw new TypeError("TaskPrompt attachment is invalid");
    attachmentBindings.push({ identity: attachment.identity, filename: attachment.filename, mediaType: attachment.mediaType, byteLength: attachment.byteLength, digest: attachment.digest });
    projectedAttachments.push(Object.freeze({
      identity: attachment.identity,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      byteLength: attachment.byteLength,
      digest: attachment.digest,
      content: Object.freeze({ encoding: "base64", data: bytes.toString("base64") }),
    }));
  }
  if (canonicalDigest({ textDigest, attachments: attachmentBindings }) !== record.identity
    || canonicalDigest({ taskPromptIdentity: record.identity, textDigest, attachments: attachmentBindings }) !== record.digest) {
    throw new TypeError("TaskPrompt snapshot content identity is invalid");
  }
  return Object.freeze({ text, attachments: Object.freeze(projectedAttachments) });
}

export class DeliveryAdmissionProjector implements DeliveryActivationProjector {
  async project(manifest: DeliveryManifest | DeliveryManifestV2): Promise<RunnerActivationContext> {
    if (manifest.schemaVersion !== "execution.delivery-manifest@2.0.0") {
      throw new TypeError("Delivery admission requires a v2 manifest");
    }
    const packageBinding = { name: manifest.workflowPackage.name, exactVersion: manifest.workflowPackage.exactVersion, packageDigest: manifest.workflowPackage.packageDigest, localPath: manifest.workflowPackage.localMaterializationPath, workflowId: manifest.workflowSnapshot.workflowId };
    const definition = await definitionDirectory(packageBinding.localPath);
    const workspace = await realpath(manifest.canonicalWorktree);
    const taskPrompt = await verifyPromptSnapshot(manifest);
    const [pkg, snapshot, workflow, actionsDocument, routesDocument, artifactsDocument] = await Promise.all([
      json(path.join(definition, "package.json")),
      json(path.join(definition, "snapshot.json")),
      json(path.join(definition, "workflow.json")),
      json(path.join(definition, "actions.json")),
      json(path.join(definition, "routes.json")),
      json(path.join(definition, "artifacts.json")),
    ]);
    const expectedContract = "agentops.workflow-dsl@2.0.0";
    if (pkg.schemaVersion !== expectedContract
      || snapshot.schemaVersion !== pkg.schemaVersion || workflow.schemaVersion !== pkg.schemaVersion
      || pkg.package.name !== packageBinding.name || pkg.package.version !== packageBinding.exactVersion
      || pkg.package.digest !== packageBinding.packageDigest
      || workflow.workflow.id !== packageBinding.workflowId
      || snapshot.snapshot.package.digest !== pkg.package.digest
      || snapshot.snapshot.definition.contentIdentity !== pkg.package.definition.contentIdentity) {
      throw new TypeError("persisted Delivery Package binding is invalid");
    }

    const actionById = new Map<string, Document>(actionsDocument.actions.map((action: Document) => [action.id, action]));
    const routeById = new Map<string, Document>(routesDocument.routes.map((route: Document) => [route.id, route]));
    const resources = new Map<string, Document>([...pkg.resources.owned, ...pkg.resources.referenced].map((resource: Document) => [resource.id, resource]));
    const workflowPath = path.join(definition, pkg.documents.workflow);
    const agents: Record<string, Document> = {};
    const sites: Document[] = [];
    const hostOperations: Record<string, Document> = Object.fromEntries((workflow.hostOperations ?? []).map((operation: Document) => [operation.id, {
      identity: operation.id,
      contractIdentity: operation.contractIdentity,
      configuration: operation.configuration,
      requiredCapabilities: operation.requiredCapabilities,
    }]));

    const operationFor = (action: Document): string => {
      const validator = action.gate.deterministic?.[0];
      const operation = Object.values(hostOperations).find((candidate) => candidate.configuration.validator === validator);
      if (operation !== undefined) return operation.identity;
      if (typeof validator === "string" && action.responsibleAuthority?.kind === "runtime"
        && action.responsibleAuthority.validator === validator) {
        const identity = `operation.runtime.${String(action.id)}`;
        hostOperations[identity] = {
          identity,
          contractIdentity: "host-operation.deterministic-validation.v1",
          configuration: { validator },
          requiredCapabilities: ["deterministic-validation"],
        };
        return identity;
      }
      throw new TypeError(`deterministic Action '${String(action.id)}' has no admitted Host operation`);
    };

    const addSite = async (site: ExecutionSiteRef, actionIdentity: string) => {
      const action = actionById.get(actionIdentity);
      if (action === undefined) throw new TypeError(`site references unknown Action '${actionIdentity}'`);
      const routeIdentity = Array.isArray(action.allowedRoutes) ? action.allowedRoutes[0] as string | undefined : undefined;
      if (routeIdentity === undefined) {
        sites.push({ site, actionIdentity, executor: { kind: "host-operation", identity: operationFor(action) } });
        return;
      }
      const route = routeById.get(routeIdentity);
      if (route === undefined) throw new TypeError(`Action '${actionIdentity}' has no admitted Route`);
      const executorIdentity = `executor.${actionIdentity.slice("action.".length)}`;
      if (agents[executorIdentity] === undefined) {
        const promptRef = route.resources.actionPrompts?.find((binding: Document) => binding.action === actionIdentity)?.prompt?.id as string | undefined;
        const rolePromptRef = route.resources.rolePrompt?.id as string | undefined;
        const promptIdentity = promptRef ?? rolePromptRef;
        const promptResource = promptIdentity === undefined ? undefined : resources.get(promptIdentity);
        const promptPath = promptResource?.owner === "owned" ? await realpath(path.join(definition, promptResource.path)) : workflowPath;
        const promptBytes = await readFile(promptPath);
        const resolvedRole: ResolvedRoleModelBinding | undefined = manifest.resolvedRoles.find((binding) => binding.roleId === route.role);
        if (resolvedRole === undefined) throw new TypeError(`Role '${String(route.role)}' has no frozen Provider binding`);
        const adapterKey = resolvedRole?.agentProviderAdapterKey ?? "dsh-headless";
        const session = {
          roleIdentity: route.role,
          routeIdentity: route.id,
          agent: {
            resourceIdentity: rolePromptRef,
            contentIdentity: resolvedRole.rolePromptDigest,
            projectionIdentity: canonicalDigest({ package: pkg.package.digest, route: route.id, projection: "agent" }),
            localReadOnlyPath: promptPath,
          },
          model: {
            resourceIdentity: `model.${String(route.role).replace(/^role\./u, "")}`,
            contentIdentity: canonicalDigest({ package: pkg.package.digest, model: resolvedRole.modelId }),
            projectionIdentity: canonicalDigest({ package: pkg.package.digest, route: route.id, provider: resolvedRole.modelProviderId, model: resolvedRole.modelId }),
            providerModelIdentity: resolvedRole.modelId,
            configuration: adapterKey === "codex-cli" ? { reasoningEffort: "medium" } : {},
          },
          driver: {
            resourceIdentity: `driver.${adapterKey}`,
            projectionIdentity: canonicalDigest({ package: pkg.package.digest, route: route.id, provider: resolvedRole.agentProviderId, adapter: adapterKey }),
            providerIdentity: adapterKey,
            configuration: adapterKey === "codex-cli"
              ? { approvalPolicy: "never", sandbox: (route.access ?? []).some((entry: Document) => entry.mode === "write") ? "workspace-write" : "read-only" }
              : {},
          },
          instructions: {
            resourceIdentity: promptRef ?? rolePromptRef ?? `instruction.${actionIdentity}`,
            contentIdentity: rawDigest(promptBytes),
            localReadOnlyPath: promptPath,
          },
          tools: (route.resources.tools ?? []).map((tool: Document) => ({
            resourceIdentity: tool.id,
            contentIdentity: canonicalDigest({ package: pkg.package.digest, tool: tool.id }),
            localReadOnlyPath: { kind: "ABSENT" },
            configuration: { toolName: `workspace_${String(tool.id).replaceAll(".", "_")}`, workspaceAccess: true },
          })),
          providedCapabilities: route.resources.capabilities,
          policy: { identity: `session.${String(route.id)}`, scope: route.resources.sessionPolicy.scope, isolation: route.resources.sessionPolicy.isolation },
        };
        const modes = new Set<string>();
        const access: Document[] = [];
        for (const entry of route.access ?? []) {
          if ((entry.mode === "read" || entry.mode === "write") && !modes.has(entry.mode)) {
            modes.add(entry.mode);
            access.push({ mode: entry.mode, path: "**" });
          }
        }
        const turn = { access };
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

    for (const node of workflow.graph.nodes as Document[]) {
      const nodeSite = siteForNode(node);
      if (nodeSite !== undefined && node.action !== undefined) await addSite(nodeSite, node.action);
      if (node.kind === "parallel") {
        for (const branch of node.branches as Document[]) await addSite({ kind: "parallel-branch", nodeIdentity: node.id, branchIdentity: branch.id } as ExecutionSiteRef, branch.action);
        await addSite({ kind: "parallel-join", nodeIdentity: node.id } as ExecutionSiteRef, node.join.action);
      }
    }

    const decisions: Document[] = [];
    const ordinarySuccessor = workflow.graph.edges.map((edge: Document) => ({ ...edge, to: target(edge.to) }));
    for (const node of workflow.graph.nodes as Document[]) {
      if (node.routing !== undefined) {
        const identity = `decision.${String(node.id)}`;
        const sourceSite = node.kind === "parallel"
          ? { kind: "parallel-join", nodeIdentity: node.id }
          : { kind: "node", nodeIdentity: node.id };
        decisions.push({
          identity,
          source: { kind: "site-result", site: sourceSite, slot: { kind: "property", name: node.routing.output } },
          selector: { kind: "case-map", cases: node.routing.cases.map((entry: Document) => ({ value: entry.value, target: target(entry.target) })) },
        });
        ordinarySuccessor.push({ id: `edge.${String(node.id)}.decision`, from: node.id, to: identity });
      }
      if (node.kind === "parallel" && node.selection !== undefined) {
        decisions.push({ identity: `decision.${String(node.id)}.selection`, source: node.selection.source });
      }
    }

    const controls: Document[] = [];
    for (const wait of workflow.waits ?? []) {
      const waitNode = workflow.graph.nodes.find((node: Document) => node.kind === "wait" && node.wait === wait.id);
      const predecessor = workflow.graph.nodes.find((node: Document) => node.routing?.cases?.some((entry: Document) => entry.target === waitNode?.id));
      if (waitNode === undefined || predecessor === undefined) throw new TypeError(`Wait '${String(wait.id)}' has no admitted resume predecessor`);
      const controlIdentity = `control.${String(wait.id)}`;
      const decisionIdentity = `decision.resume.${String(wait.id)}`;
      const operationIdentity = `operation.resume.${String(wait.id)}`;
      hostOperations[operationIdentity] = { identity: operationIdentity, contractIdentity: "host-operation.deterministic-selection.v1", configuration: { waitIdentity: wait.id }, requiredCapabilities: ["deterministic-selection"] };
      decisions.push({ identity: decisionIdentity, source: { kind: "control-result", controlIdentity, slot: { kind: "whole" } }, selector: { kind: "host-operation", operationIdentity, allowedTargets: [predecessor.id] } });
      const renewal = workflow.graph.nodes.find((node: Document) => node.kind === "wait-renewal" && node.wait === wait.id);
      controls.push({ identity: controlIdentity, nodeIdentity: waitNode.id, kind: wait.kind === "user" ? "user" : "external-workflow", resultSchema: wait.resumeSchema, correlation: wait.correlation, expiry: renewal === undefined ? { mode: "incomplete", maxRenewals: 0 } : { mode: "renew", maxRenewals: renewal.maxRenewals }, resumeDecision: decisionIdentity });
    }

    const entryNode = workflow.graph.nodes.find((node: Document) => node.id === workflow.graph.start);
    const entryAction = entryNode === undefined ? undefined : actionById.get(entryNode.action);
    if (entryNode === undefined || entryAction === undefined) throw new TypeError("Workflow entry Action is not admitted");
    const taskPromptStateField = "__deliveryTaskPrompt";
    const values = Object.fromEntries([
      ...workflow.state.fields.map((field: Document) => [field.name, initialValue(field, taskPrompt)]),
      [taskPromptStateField, initialActionInput(entryAction, taskPrompt, workspace)],
    ]);
    const artifactVersions = Object.fromEntries(artifactsDocument.artifacts.map((artifact: Document) => [artifact.id, { kind: "ABSENT" }]));
    const actionTemplates = Object.fromEntries(actionsDocument.actions.map((action: Document) => [action.id, { identity: action.id, purpose: action.purpose, inputSchema: action.inputSchema, resultSchema: action.resultSchema, gate: action.gate }]));
    const draft: any = {
      schemaVersion: "runner.activation@1.0.0",
      bindingIdentity: `sha256:${"0".repeat(64)}`,
      correlation: {
        deliveryIdentity: manifest.deliveryId,
        taskIdentity: manifest.taskId,
        manifestBindingIdentity: manifest.deliveryBindingIdentity,
        packageIdentity: `${String(pkg.package.name)}@${String(pkg.package.version)}`,
        packageDigest: pkg.package.digest,
        snapshotIdentity: snapshot.snapshot.id,
        snapshotDigest: snapshot.snapshot.digest,
        workflowIdentity: `${String(workflow.workflow.id)}@${String(workflow.workflow.version)}`,
        runtimeProfileIdentity: "runtime-profile.runner.langgraph-agent-providers",
      },
      program: {
        control: {
          entryNode: workflow.graph.start,
          nodes: workflow.graph.nodes.map(admittedNode),
          ordinarySuccessor,
          eventSuccessor: workflow.graph.eventEdges.map((edge: Document) => ({ ...edge, to: target(edge.to) })),
          decisions,
          controls,
          terminals: workflow.graph.terminals,
        },
        execution: { actions: actionTemplates, sites, agents, hostOperations },
        dataflow: { edges: [
          ...workflow.dataflow.edges.map(({ source, target: edgeTarget }: Document) => ({ source, target: edgeTarget })),
          { source: { kind: "state", field: taskPromptStateField }, target: { kind: "site-input", site: { kind: "node", nodeIdentity: entryNode.id }, slot: { kind: "whole" } } },
        ] },
      },
      initial: {
        state: { identity: canonicalDigest({ manifest: manifest.deliveryBindingIdentity, state: values }), values },
        artifacts: { identity: canonicalDigest({ package: pkg.package.digest, artifacts: artifactVersions }), versions: artifactVersions },
        workspace: {
          identity: `workspace.${createHash("sha256").update(workspace).digest("hex").slice(0, 24)}`,
          canonicalWorktreePath: workspace,
          admittedGitTree: captureManagedWorkspaceTree(workspace),
        },
      },
      admission: {
        contractRevision: expectedContract,
        authorityMergeIdentity: canonicalDigest({ authority: pkg.authority, proof: snapshot.snapshot.authority.mergeProof }),
        deliveryAdmissionContractIdentity: "agentops.delivery-admission@2.0.0",
      },
    };
    draft.bindingIdentity = activationBindingDigest(draft);
    return validateRunnerActivation(deepFreeze(draft));
  }
}
