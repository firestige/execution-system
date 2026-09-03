import { cp, mkdir, readFile, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { coordinateIdentity, type DeliveryConfigProjectionV2 } from "../../src/configuration/index.js";
import { compileRunnerActivation } from "../../src/interpreter/compile-runner-activation.js";
import {
  captureTaskPromptSnapshot,
  createDeliveryManifestV2,
  DeliveryAdmissionProjector,
  extractWorkflowV2RoleSnapshot,
  resolveRoleModelBindings,
} from "../../src/delivery/index.js";
import { AgentProviderFactoryRegistry, type AgentProviderRealmFactory } from "../../src/providers/provider.js";

const repositoryRoot = path.dirname(fileURLToPath(new URL("../..", import.meta.url)));
const executionRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, "");

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function projectionV2(): DeliveryConfigProjectionV2 {
  const value = Object.freeze({
    schemaVersion: "execution.delivery-config@2.0.0" as const,
    paths: Object.freeze({ repositoryRoot, workspaceRoot: repositoryRoot, allowedWorktreeRoots: Object.freeze([repositoryRoot]), runnerResources: Object.freeze({ journal: "runner/journal" as const, checkpoints: "runner/checkpoints" as const, sessions: "runner/sessions" as const, custody: "runner/custody" as const }) }),
    runner: Object.freeze({ implementationKey: "runner.v2" as const, host: Object.freeze({ engine: "langgraph" as const }), maxParallelToolCalls: 2 }),
    controls: Object.freeze({ executionTimeoutMs: 60_000, maxConcurrentDeliveries: 2, allowExplicitRefresh: false }),
  });
  return Object.freeze({ value, identity: coordinateIdentity("execution.delivery-config@2.0.0", value as never) });
}

async function firstPartyManifest(input: {
  readonly name: string;
  readonly definition: string;
  readonly packageDocument: any;
  readonly snapshotDocument: any;
  readonly promptSnapshot: Awaited<ReturnType<typeof captureTaskPromptSnapshot>>;
}) {
  const [actionsDocument, rolesDocument, routesDocument] = await Promise.all([
    readFile(path.join(input.definition, "actions.json"), "utf8").then(JSON.parse),
    readFile(path.join(input.definition, "roles.json"), "utf8").then(JSON.parse),
    readFile(path.join(input.definition, "routes.json"), "utf8").then(JSON.parse),
  ]);
  const extracted = extractWorkflowV2RoleSnapshot({
    packageDocument: input.packageDocument,
    snapshotDocument: input.snapshotDocument,
    actionsDocument,
    rolesDocument,
    routesDocument,
  });
  const factory: AgentProviderRealmFactory = Object.freeze({
    descriptor: Object.freeze({
      schemaVersion: "execution.agent-provider-factory@1.0.0",
      identity: "provider.dsh",
      version: "1.0.0",
      adapterKey: "dsh-headless",
      capabilities: Object.freeze(["structured-completion", "action-interaction"]),
    }),
    async acquire() { throw new Error("projection does not acquire realms"); },
  });
  const registry = new AgentProviderFactoryRegistry([factory]);
  const repositoryModelBindings = Object.freeze({
    schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0" as const,
    documentState: "PRESENT" as const,
    documentDigest: digest(`repository-bindings.${input.name}`),
    bindings: Object.freeze(Object.fromEntries(extracted.agentActionRoles.map(({ roleId }) => [roleId, Object.freeze({
      agentProvider: Object.freeze({ identity: "provider.dsh", version: "1.0.0" }),
      model: Object.freeze({ provider: "deepseek", model: "deepseek-chat" }),
    })]))),
  });
  const resolvedRoleBindings = resolveRoleModelBindings({ registry, repository: repositoryModelBindings, agentActionRoles: extracted.agentActionRoles });
  return createDeliveryManifestV2({
    deliveryId: `delivery-${input.name}`,
    taskId: `task-${input.name}`,
    createdAt: 1,
    canonicalWorktree: repositoryRoot,
    workflowPackage: {
      name: input.packageDocument.package.name,
      exactVersion: input.packageDocument.package.version,
      packageDigest: input.packageDocument.package.digest,
      localMaterializationPath: input.definition,
    },
    workflowSnapshot: extracted.workflowSnapshot,
    agentActionRoles: extracted.agentActionRoles,
    repositoryModelBindings,
    resolvedRoleBindings,
    promptSnapshot: input.promptSnapshot,
    deliveryConfigProjection: projectionV2(),
  });
}

describe("frozen Delivery Admission production projection", () => {
  it.each([
    ["implementation", path.join(repositoryRoot, "workflow-package", "implementation", "definition")],
    ["system-design", path.join(repositoryRoot, "workflow-package", "system-design", "definition")],
    ["contract-minimal", path.join(repositoryRoot, "system-contracts", "workflow-dsl-2-candidate", "generated", "examples", "minimal")],
  ])("projects the exact %s Package and persisted Manifest without raw admission inputs", async (name, definition) => {
    const packageDocument = JSON.parse(await readFile(path.join(definition, "package.json"), "utf8"));
    const snapshotDocument = JSON.parse(await readFile(path.join(definition, "snapshot.json"), "utf8"));
    const routesDocument = JSON.parse(await readFile(path.join(definition, "routes.json"), "utf8"));
    const root = await mkdtemp(path.join(tmpdir(), "delivery-projector-"));
    const snapshot = await captureTaskPromptSnapshot({
      root: path.join(root, "snapshots"),
      deliveryId: `delivery-${name}`,
      prompt: Object.freeze({ text: "execute the admitted task", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }),
    });
    const manifest = await firstPartyManifest({ name, definition, packageDocument, snapshotDocument, promptSnapshot: snapshot });

    const activation = await new DeliveryAdmissionProjector().project(manifest);
    expect(Object.isFrozen(activation)).toBe(true);
    expect(Object.isFrozen(activation.program.execution.agents)).toBe(true);
    expect(activation).toMatchObject({
      schemaVersion: "runner.activation@1.0.0",
      correlation: {
        deliveryIdentity: `delivery-${name}`,
        taskIdentity: `task-${name}`,
        manifestBindingIdentity: manifest.deliveryBindingIdentity,
        packageDigest: packageDocument.package.digest,
        snapshotIdentity: snapshotDocument.snapshot.id,
        snapshotDigest: snapshotDocument.snapshot.digest,
      },
      admission: { deliveryAdmissionContractIdentity: "agentops.delivery-admission@2.0.0" },
    });
    expect(compileRunnerActivation(activation).ok).toBe(true);
    for (const agent of Object.values(activation.program.execution.agents)) {
      const route = routesDocument.routes.find((candidate: any) => candidate.id === agent.session.routeIdentity);
      const modes = [...new Set((route?.access ?? []).map((entry: any) => entry.mode).filter((mode: string) => mode === "read" || mode === "write"))];
      expect(agent.turn.access).toEqual(modes.map((mode) => ({
        mode,
        path: "**",
      })));
    }
    const serialized = JSON.stringify(activation);
    expect(serialized).not.toContain('"path":"README.md"');
    expect(serialized).not.toContain('"path":"run"');
    expect(serialized).not.toMatch(/"contentRef"|"workflowSource"|"packageStore"|"credentialStore"|"nativeSession"|"checkpointIdentity"/);
  });

  it("binds the admitted entry input using only its declared JSON field formats", async () => {
    const source = path.join(repositoryRoot, "system-contracts", "workflow-dsl-2-candidate", "generated", "examples", "minimal");
    const root = await mkdtemp(path.join(tmpdir(), "delivery-projector-formats-"));
    const definition = path.join(root, "definition");
    await cp(source, definition, { recursive: true });
    const actionsPath = path.join(definition, "actions.json");
    const actionsDocument = JSON.parse(await readFile(actionsPath, "utf8"));
    actionsDocument.actions[0].inputSchema = {
      type: "object",
      properties: {
        request: { type: "string" },
        repository: { type: "string" },
        label: { type: "string" },
        accepted: { type: "boolean" },
        count: { type: "integer" },
        items: { type: "array" },
        metadata: { type: "object" },
        prompt: { type: "object" },
      },
      required: ["request", "repository", "label", "accepted", "count", "items", "metadata", "prompt"],
    };
    await writeFile(actionsPath, `${JSON.stringify(actionsDocument, null, 2)}\n`, "utf8");

    const packageDocument = JSON.parse(await readFile(path.join(definition, "package.json"), "utf8"));
    const snapshotDocument = JSON.parse(await readFile(path.join(definition, "snapshot.json"), "utf8"));
    const attachmentBytes = Buffer.from("ordered attachment");
    const attachmentDigest = `sha256:${createHash("sha256").update(attachmentBytes).digest("hex")}`;
    const promptSnapshot = await captureTaskPromptSnapshot({
      root: path.join(root, "snapshots"),
      deliveryId: "delivery-formats",
      prompt: Object.freeze({ text: "format-only prompt", attachments: Object.freeze([Object.freeze({
        identity: "attachment-1", filename: "input.txt", mediaType: "text/plain",
        byteLength: attachmentBytes.byteLength, digest: attachmentDigest, contentRef: "opaque:1",
      })]) }),
      attachments: Object.freeze({ read: async () => attachmentBytes }),
    });
    const manifest = await firstPartyManifest({ name: "formats", definition, packageDocument, snapshotDocument, promptSnapshot });

    const activation = await new DeliveryAdmissionProjector().project(manifest);
    expect(activation.initial.state.values.__deliveryTaskPrompt).toEqual({
      request: "format-only prompt",
      repository: repositoryRoot,
      label: "",
      accepted: false,
      count: 0,
      items: [],
      metadata: {},
      prompt: {
        text: "format-only prompt",
        attachments: [{
          identity: "attachment-1", filename: "input.txt", mediaType: "text/plain",
          byteLength: attachmentBytes.byteLength, digest: attachmentDigest,
          content: { encoding: "base64", data: attachmentBytes.toString("base64") },
        }],
      },
    });
    expect(compileRunnerActivation(activation).ok).toBe(true);
  });

  it("normalizes an omitted Action input schema to the explicit ABSENT sentinel", async () => {
    const source = path.join(repositoryRoot, "system-contracts", "workflow-dsl-2-candidate", "generated", "examples", "minimal");
    const root = await mkdtemp(path.join(tmpdir(), "delivery-projector-absent-input-"));
    const definition = path.join(root, "definition");
    await cp(source, definition, { recursive: true });
    const actionsPath = path.join(definition, "actions.json");
    const actionsDocument = JSON.parse(await readFile(actionsPath, "utf8"));
    delete actionsDocument.actions[0].inputSchema;
    await writeFile(actionsPath, `${JSON.stringify(actionsDocument, null, 2)}\n`, "utf8");

    const packageDocument = JSON.parse(await readFile(path.join(definition, "package.json"), "utf8"));
    const snapshotDocument = JSON.parse(await readFile(path.join(definition, "snapshot.json"), "utf8"));
    const promptSnapshot = await captureTaskPromptSnapshot({
      root: path.join(root, "snapshots"),
      deliveryId: "delivery-absent-input",
      prompt: Object.freeze({ text: "admit an Action without input", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }),
    });
    const manifest = await firstPartyManifest({ name: "absent-input", definition, packageDocument, snapshotDocument, promptSnapshot });

    const activation = await new DeliveryAdmissionProjector().project(manifest);

    expect(activation.program.execution.actions[actionsDocument.actions[0].id]?.inputSchema).toEqual({ kind: "ABSENT" });
    expect(compileRunnerActivation(activation).ok).toBe(true);
  });

  it("admits one immutable dirty managed-workspace snapshot without changing the user index or object database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "delivery-projector-dirty-"));
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "cache"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "admission@example.invalid");
    git("config", "user.name", "Admission Test");
    await writeFile(path.join(workspace, ".gitignore"), "cache/\n");
    await writeFile(path.join(workspace, "tracked.txt"), "committed\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    await writeFile(path.join(workspace, "tracked.txt"), "dirty tracked\n");
    await writeFile(path.join(workspace, "untracked.txt"), "dirty untracked\n");
    await writeFile(path.join(workspace, "cache", "large.bin"), "ignored-v1\n");

    const definition = path.join(repositoryRoot, "system-contracts", "workflow-dsl-2-candidate", "generated", "examples", "minimal");
    const packageDocument = JSON.parse(await readFile(path.join(definition, "package.json"), "utf8"));
    const snapshotDocument = JSON.parse(await readFile(path.join(definition, "snapshot.json"), "utf8"));
    const promptSnapshot = await captureTaskPromptSnapshot({
      root: path.join(root, "snapshots"),
      deliveryId: "delivery-dirty",
      prompt: Object.freeze({ text: "admit dirty workspace", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }),
    });
    const manifest = await firstPartyManifest({ name: "dirty", definition, packageDocument, snapshotDocument, promptSnapshot });
    const workspaceManifest = Object.freeze({ ...manifest, canonicalWorktree: workspace });
    const indexBefore = await readFile(path.join(workspace, ".git", "index"));
    const objectsBefore = git("count-objects", "-v");
    const headTree = git("rev-parse", "HEAD^{tree}");

    const first = await new DeliveryAdmissionProjector().project(workspaceManifest);
    expect(first.initial.workspace.admittedGitTree).not.toBe(headTree);
    expect(await readFile(path.join(workspace, ".git", "index"))).toEqual(indexBefore);
    expect(git("count-objects", "-v")).toBe(objectsBefore);

    await writeFile(path.join(workspace, "cache", "large.bin"), "ignored-v2\n");
    const ignoredOnly = await new DeliveryAdmissionProjector().project(workspaceManifest);
    expect(ignoredOnly.initial.workspace.admittedGitTree).toBe(first.initial.workspace.admittedGitTree);

    await writeFile(path.join(workspace, "untracked.txt"), "dirty untracked changed\n");
    const managedChange = await new DeliveryAdmissionProjector().project(workspaceManifest);
    expect(managedChange.initial.workspace.admittedGitTree).not.toBe(first.initial.workspace.admittedGitTree);
    expect(await readFile(path.join(workspace, ".git", "index"))).toEqual(indexBefore);
    expect(git("count-objects", "-v")).toBe(objectsBefore);
  });
});

describe("frozen Delivery Admission 2.0.0 production projection", () => {
  it("projects two Snapshot Roles to their exact Copilot and Codex driver/model bindings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "delivery-projector-v2-"));
    const definition = path.join(root, "definition");
    await mkdir(path.join(definition, "prompts"), { recursive: true });
    await mkdir(path.join(definition, "skills"), { recursive: true });
    await writeFile(path.join(definition, "prompts", "copilot.md"), "Copilot Role instructions.\n");
    await writeFile(path.join(definition, "prompts", "codex.md"), "Codex Role instructions.\n");
    await writeFile(path.join(definition, "skills", "review.md"), "Review Skill instructions.\n");
    const sha = (character: string) => `sha256:${character.repeat(64)}`;
    const pkg = {
      schemaVersion: "agentops.workflow-dsl@2.0.0",
      package: { name: "dual-role", version: "1.0.0", digest: sha("1"), definition: { contentIdentity: sha("2") } },
      documents: { workflow: "workflow.json", actions: "actions.json", routes: "routes.json" },
      resources: { owned: [
        { id: "role.prompt.copilot", kind: "role-prompt", owner: "owned", path: "prompts/copilot.md", contentIdentity: sha("3") },
        { id: "role.prompt.codex", kind: "role-prompt", owner: "owned", path: "prompts/codex.md", contentIdentity: sha("4") },
        { id: "skill.review", kind: "skill", owner: "owned", path: "skills/review.md", contentIdentity: `sha256:${createHash("sha256").update("Review Skill instructions.\n").digest("hex")}` },
      ], referenced: [] },
      authority: { order: ["workflow_action", "role_prompt", "action_prompt", "skill", "artifact_user"], conflictMode: "fail-closed" },
    };
    const workflow = {
      schemaVersion: "agentops.workflow-dsl@2.0.0",
      workflow: { id: "workflow.dual-role", version: "1.0.0" },
      state: { fields: [{ name: "request", type: "string", required: true }] },
      graph: {
        start: "node.copilot",
        nodes: [
          { id: "node.copilot", kind: "action", action: "action.copilot" },
          { id: "node.codex", kind: "action", action: "action.codex" },
        ],
        edges: [
          { id: "edge.codex", from: "node.copilot", to: "node.codex" },
          { id: "edge.success", from: "node.codex", to: "terminal:SUCCESS" },
        ],
        eventEdges: [], terminals: [{ id: "SUCCESS", kind: "success", meaning: "done" }],
      },
      dataflow: { edges: [{ source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.copilot" }, slot: { kind: "whole" } }, target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.codex" }, slot: { kind: "whole" } } }] },
      hostOperations: [],
    };
    const actions = { schemaVersion: "agentops.workflow-dsl@2.0.0", actions: [
      { id: "action.copilot", purpose: "first", inputSchema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] }, resultSchema: { type: "object" }, responsibleAuthority: { kind: "role", role: "role.copilot" }, allowedRoutes: ["route.copilot"], gate: { freeTextBypass: "prohibited" } },
      { id: "action.codex", purpose: "second", inputSchema: { type: "object" }, resultSchema: { type: "object" }, responsibleAuthority: { kind: "role", role: "role.codex" }, allowedRoutes: ["route.codex"], gate: { freeTextBypass: "prohibited" } },
    ] };
    const routes = { schemaVersion: "agentops.workflow-dsl@2.0.0", routes: [
      { id: "route.copilot", role: "role.copilot", resources: { rolePrompt: { id: "role.prompt.copilot" }, actionPrompts: [], skills: [{ id: "skill.review" }], tools: [], capabilities: ["structured-completion"], sessionPolicy: { scope: { kind: "episode" }, isolation: "isolated" } }, access: [{ target: "workspace", mode: "read" }] },
      { id: "route.codex", role: "role.codex", resources: { rolePrompt: { id: "role.prompt.codex" }, actionPrompts: [], tools: [], capabilities: ["structured-completion"], sessionPolicy: { scope: { kind: "episode" }, isolation: "isolated" } }, access: [{ target: "workspace", mode: "read" }] },
    ] };
    const snapshotDocument = { schemaVersion: "agentops.workflow-dsl@2.0.0", snapshot: { id: "snapshot.dual-role.1", digest: sha("5"), package: { name: "dual-role", version: "1.0.0", digest: sha("1") }, definition: { id: "workflow.dual-role", version: "1.0.0", contentIdentity: sha("2") }, authority: { mergeProof: sha("6") } } };
    await Promise.all([
      writeFile(path.join(definition, "package.json"), JSON.stringify(pkg)),
      writeFile(path.join(definition, "workflow.json"), JSON.stringify(workflow)),
      writeFile(path.join(definition, "actions.json"), JSON.stringify(actions)),
      writeFile(path.join(definition, "routes.json"), JSON.stringify(routes)),
      writeFile(path.join(definition, "artifacts.json"), JSON.stringify({ schemaVersion: "agentops.workflow-dsl@2.0.0", artifacts: [] })),
      writeFile(path.join(definition, "snapshot.json"), JSON.stringify(snapshotDocument)),
    ]);
    const factory = (identity: "provider.copilot" | "provider.codex", version: string, adapterKey: "copilot-sdk" | "codex-cli"): AgentProviderRealmFactory => Object.freeze({
      descriptor: Object.freeze({ schemaVersion: "execution.agent-provider-factory@1.0.0", identity, version, adapterKey, capabilities: Object.freeze(["structured-completion"]) }),
      async acquire() { throw new Error("projection does not acquire realms"); },
    });
    const registry = new AgentProviderFactoryRegistry([
      factory("provider.copilot", "1.0.78", "copilot-sdk"),
      factory("provider.codex", "0.144.5", "codex-cli"),
    ]);
    const repositoryBindings = Object.freeze({ schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0" as const, documentState: "PRESENT" as const, documentDigest: sha("7"), bindings: Object.freeze({
      "role.copilot": Object.freeze({ agentProvider: Object.freeze({ identity: "provider.copilot", version: "1.0.78" }), model: Object.freeze({ provider: "github-copilot", model: "gpt-5.3-codex" }) }),
      "role.codex": Object.freeze({ agentProvider: Object.freeze({ identity: "provider.codex", version: "0.144.5" }), model: Object.freeze({ provider: "openai", model: "gpt-5.6-sol" }) }),
    }) });
    const agentActionRoles = Object.freeze([
      Object.freeze({ roleId: "role.copilot", rolePromptIdentity: "role.prompt.copilot", rolePromptDigest: sha("3"), requiredCapabilities: Object.freeze(["structured-completion"]) }),
      Object.freeze({ roleId: "role.codex", rolePromptIdentity: "role.prompt.codex", rolePromptDigest: sha("4"), requiredCapabilities: Object.freeze(["structured-completion"]) }),
    ]);
    const resolvedRoleBindings = resolveRoleModelBindings({ registry, repository: repositoryBindings, agentActionRoles });
    const projectionValue = Object.freeze({
      schemaVersion: "execution.delivery-config@2.0.0" as const,
      paths: Object.freeze({ repositoryRoot: executionRoot, workspaceRoot: executionRoot, allowedWorktreeRoots: Object.freeze([executionRoot]), runnerResources: Object.freeze({ journal: "runner/journal" as const, checkpoints: "runner/checkpoints" as const, sessions: "runner/sessions" as const, custody: "runner/custody" as const }) }),
      runner: Object.freeze({ implementationKey: "runner.v2" as const, host: Object.freeze({ engine: "langgraph" as const }), maxParallelToolCalls: 2 }),
      controls: Object.freeze({ executionTimeoutMs: 60_000, maxConcurrentDeliveries: 1, allowExplicitRefresh: false }),
    });
    const deliveryConfigProjection: DeliveryConfigProjectionV2 = Object.freeze({ value: projectionValue, identity: coordinateIdentity("execution.delivery-config@2.0.0", projectionValue as never) });
    const promptSnapshot = await captureTaskPromptSnapshot({ root: path.join(root, "snapshots"), deliveryId: "delivery-dual-role", prompt: Object.freeze({ text: "run both roles", attachments: Object.freeze([]) }), attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }) });
    const manifest = createDeliveryManifestV2({
      deliveryId: "delivery-dual-role", taskId: "task-dual-role", createdAt: 1, canonicalWorktree: executionRoot,
      workflowPackage: { name: "dual-role", exactVersion: "1.0.0", packageDigest: sha("1"), localMaterializationPath: definition },
      workflowSnapshot: { workflowId: "workflow.dual-role", workflowVersion: "1.0.0", snapshotId: "snapshot.dual-role.1", snapshotDigest: sha("5") },
      agentActionRoles, repositoryModelBindings: repositoryBindings, resolvedRoleBindings, promptSnapshot, deliveryConfigProjection,
    });

    const activation = await new DeliveryAdmissionProjector().project(manifest);

    expect(activation.admission).toMatchObject({ contractRevision: "agentops.workflow-dsl@2.0.0", deliveryAdmissionContractIdentity: "agentops.delivery-admission@2.0.0" });
    expect(Object.values(activation.program.execution.agents).map((agent) => ({ role: agent.session.roleIdentity, driver: agent.session.driver.providerIdentity, model: agent.session.model.providerModelIdentity }))).toEqual([
      { role: "role.copilot", driver: "copilot-sdk", model: "gpt-5.3-codex" },
      { role: "role.codex", driver: "codex-cli", model: "gpt-5.6-sol" },
    ]);
    expect(Object.values(activation.program.execution.agents)[0]?.session.skills).toEqual([
      expect.objectContaining({ resourceIdentity: "skill.review", configuration: { kind: "skill" } }),
    ]);
    expect(compileRunnerActivation(activation).ok).toBe(true);
  });
});
