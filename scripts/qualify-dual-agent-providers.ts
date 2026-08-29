import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { FrozenJsonValue, InvocationDispatch } from "../src/contracts/index.js";
import type { DeliveryManifestV2 } from "../src/delivery/index.js";
import { CodexCliProviderRealmFactory } from "../src/providers/codex/index.js";
import { createCopilotAgentProviderFactory } from "../src/providers/copilot/index.js";
import {
  AgentProviderFactoryRegistry,
  DeliveryAgentProviderRealmBroker,
  type AgentProviderRealmFactory,
  type NativeProviderSession,
  type NativeTurnEvent,
  type ProviderAdapterKey,
} from "../src/providers/provider.js";

const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fixedSha = (character: string): string => `sha256:${character.repeat(64)}`;

export interface DualProviderQualificationOptions {
  readonly deliveryId: string;
  readonly canonicalWorktree: string;
  readonly instructionsDirectory: string;
  readonly copilotFactory: AgentProviderRealmFactory;
  readonly copilotModel: string;
  readonly codexFactory: AgentProviderRealmFactory;
  readonly codexModel: string;
}

export interface DualProviderQualificationEvidence {
  readonly schemaVersion: "execution.dual-provider-qualification@1.0.0";
  readonly deliveryId: string;
  readonly canonicalWorktree: string;
  readonly credentialMaterialRead: false;
  readonly providers: readonly Readonly<{
    roleId: string;
    providerIdentity: string;
    providerVersion: string;
    adapterKey: ProviderAdapterKey;
    modelId: string;
    result: FrozenJsonValue;
  }>[];
  readonly teardown: Readonly<{ sessionsDisposed: true; realmsDisposed: true }>;
}

type QualificationStage = "realm-acquire" | "role.copilot:open" | "role.copilot:run" | "role.copilot:persist" | "role.codex:open" | "role.codex:run" | "role.codex:persist" | "session-teardown" | "realm-teardown";
class DualProviderQualificationError extends Error {
  constructor(readonly stage: QualificationStage, readonly reason: string = "stage-failed") { super("Dual Provider qualification failed"); this.name = "DualProviderQualificationError"; }
}
class QualificationResultError extends Error { constructor(readonly reason: string) { super("Typed qualification result is inexact"); } }

const RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    typed: Object.freeze({ type: "boolean" }),
    deliveryId: Object.freeze({ type: "string" }),
    roleId: Object.freeze({ type: "string" }),
    providerIdentity: Object.freeze({ type: "string" }),
  }),
  required: Object.freeze(["typed", "deliveryId", "roleId", "providerIdentity"]),
  additionalProperties: false,
});

function manifest(options: DualProviderQualificationOptions, registry: AgentProviderFactoryRegistry): DeliveryManifestV2 {
  const copilot = registry.admit({ identity: "provider.copilot", version: "1.0.78" }, ["structured-completion"]);
  const codex = registry.admit({ identity: "provider.codex", version: "0.144.5" }, ["structured-completion"]);
  return Object.freeze({
    schemaVersion: "execution.delivery-manifest@2.0.0",
    deliveryId: options.deliveryId,
    taskId: "task.dual-provider-qualification",
    createdAt: 1,
    canonicalWorktree: options.canonicalWorktree,
    workflowPackage: Object.freeze({ name: "dual-provider-qualification", exactVersion: "1.0.0", packageDigest: fixedSha("1"), localMaterializationPath: options.canonicalWorktree }),
    workflowSnapshot: Object.freeze({ workflowId: "workflow.dual-provider-qualification", workflowVersion: "1.0.0", snapshotId: "snapshot.dual-provider-qualification.1", snapshotDigest: fixedSha("2") }),
    repositoryModelBindings: Object.freeze({ documentState: "PRESENT", documentDigest: fixedSha("3"), resolvedMapDigest: fixedSha("4") }),
    resolvedRoles: Object.freeze([
      Object.freeze({ roleId: "role.copilot", rolePromptIdentity: "role.prompt.copilot", rolePromptDigest: fixedSha("5"), agentProviderId: copilot.identity, agentProviderVersion: copilot.version, agentProviderAdapterKey: copilot.adapterKey, agentProviderDescriptorDigest: copilot.descriptorDigest, requiredCapabilities: Object.freeze(["structured-completion"]), modelProviderId: "github-copilot", modelId: options.copilotModel, resolutionSource: "REPOSITORY" as const }),
      Object.freeze({ roleId: "role.codex", rolePromptIdentity: "role.prompt.codex", rolePromptDigest: fixedSha("6"), agentProviderId: codex.identity, agentProviderVersion: codex.version, agentProviderAdapterKey: codex.adapterKey, agentProviderDescriptorDigest: codex.descriptorDigest, requiredCapabilities: Object.freeze(["structured-completion"]), modelProviderId: "openai", modelId: options.codexModel, resolutionSource: "REPOSITORY" as const }),
    ]),
    prompt: Object.freeze({ taskPromptIdentity: fixedSha("7"), snapshotIdentity: fixedSha("8"), snapshotDigest: fixedSha("9"), snapshotPath: options.instructionsDirectory }),
    deliveryConfigProjection: Object.freeze({
      value: Object.freeze({
        schemaVersion: "execution.delivery-config@2.0.0",
        paths: Object.freeze({ repositoryRoot: options.canonicalWorktree, workspaceRoot: options.canonicalWorktree, allowedWorktreeRoots: Object.freeze([options.canonicalWorktree]), runnerResources: Object.freeze({ journal: "runner/journal", checkpoints: "runner/checkpoints", sessions: "runner/sessions", custody: "runner/custody" }) }),
        runner: Object.freeze({ implementationKey: "runner.v2", host: Object.freeze({ engine: "langgraph" }), maxParallelToolCalls: 2 }),
        controls: Object.freeze({ executionTimeoutMs: 7_200_000, maxConcurrentDeliveries: 1, allowExplicitRefresh: false }),
      }),
      identity: fixedSha("a"),
    }),
    deliveryBindingIdentity: fixedSha("b"),
  });
}

async function dispatch(options: Readonly<{
  delivery: DeliveryManifestV2;
  roleId: "role.copilot" | "role.codex";
  providerIdentity: "provider.copilot" | "provider.codex";
  modelId: string;
  instructionPath: string;
}>): Promise<InvocationDispatch> {
  const instructions = await readFile(options.instructionPath, "utf8");
  const copilot = options.providerIdentity === "provider.copilot";
  const delivery = Object.freeze({ deliveryIdentity: options.delivery.deliveryId, manifestBindingIdentity: options.delivery.deliveryBindingIdentity, activationBindingIdentity: fixedSha("c") });
  const expected = Object.freeze({ typed: true, deliveryId: options.delivery.deliveryId, roleId: options.roleId, providerIdentity: options.providerIdentity });
  return Object.freeze({
    episode: Object.freeze({ thread: Object.freeze({ delivery, threadIdentity: `thread.${options.roleId}` }), site: Object.freeze({ kind: "node", nodeIdentity: `node.${options.roleId}` }), invocationIdentity: `invocation.${options.roleId}`, attemptIdentity: `attempt.${options.roleId}` }),
    plan: Object.freeze({ actionIdentity: `action.${options.roleId}`, executorIdentity: `executor.${options.roleId}`, bindingIdentity: fixedSha(copilot ? "d" : "e") }),
    action: Object.freeze({ identity: `action.${options.roleId}`, purpose: `Return exactly this typed result: ${JSON.stringify(expected)}`, inputSchema: Object.freeze({ type: "object" }), resultSchema: RESULT_SCHEMA, gate: Object.freeze({ kind: "none" }) }),
    executor: Object.freeze({
      identity: `executor.${options.roleId}`,
      bindingIdentity: fixedSha(copilot ? "f" : "0"),
      sessionCompatibilityIdentity: fixedSha(copilot ? "1" : "2"),
      session: Object.freeze({
        roleIdentity: options.roleId,
        routeIdentity: `route.${options.roleId}`,
        agent: Object.freeze({ resourceIdentity: `agent.${options.roleId}`, contentIdentity: fixedSha("3"), projectionIdentity: fixedSha("4"), localReadOnlyPath: options.instructionPath }),
        model: Object.freeze({ resourceIdentity: `model.${options.roleId}`, contentIdentity: fixedSha("5"), projectionIdentity: fixedSha("6"), providerModelIdentity: options.modelId, configuration: Object.freeze(copilot ? {} : { reasoningEffort: "medium" }) }),
        driver: Object.freeze({ resourceIdentity: `driver.${options.roleId}`, projectionIdentity: fixedSha("7"), providerIdentity: copilot ? "copilot-sdk" : "codex-cli", configuration: Object.freeze(copilot ? {} : { approvalPolicy: "never", sandbox: "read-only" }) }),
        instructions: Object.freeze({ resourceIdentity: `instructions.${options.roleId}`, contentIdentity: sha(instructions), localReadOnlyPath: options.instructionPath }),
        tools: Object.freeze([]),
        providedCapabilities: Object.freeze(["structured-completion"]),
        policy: Object.freeze({ identity: `session.${options.roleId}`, scope: Object.freeze({ kind: "episode" }), isolation: "isolated" }),
      }),
      turn: Object.freeze({ access: Object.freeze([{ mode: "read", path: "." }]) }),
    }),
    input: expected,
    workspace: Object.freeze({ kind: "read", handle: Object.freeze({ handleIdentity: `handle.${options.roleId}`, episode: Object.freeze({ thread: Object.freeze({ delivery, threadIdentity: `thread.${options.roleId}` }), site: Object.freeze({ kind: "node", nodeIdentity: `node.${options.roleId}` }), invocationIdentity: `invocation.${options.roleId}`, attemptIdentity: `attempt.${options.roleId}` }), savepoint: Object.freeze({ identity: `savepoint.${options.roleId}`, delivery, gitTree: "qualification" }), accessDigest: fixedSha("8") }) }),
    session: Object.freeze({ identity: `affinity.${options.roleId}`, delivery, sessionCompatibilityIdentity: fixedSha(copilot ? "1" : "2"), scopeValueIdentity: fixedSha("9"), isolation: "isolated" }),
  }) as unknown as InvocationDispatch;
}

function typedResult(events: readonly NativeTurnEvent[], expected: Readonly<Record<string, unknown>>): FrozenJsonValue {
  const completions = events.filter((event) => event.kind === "structured-completion");
  if (completions.length === 0) {
    const failed = events.find((event) => event.kind === "provider-failed");
    if (failed?.kind === "provider-failed") throw new QualificationResultError(`provider-failed-${failed.code}`);
    const uncertain = events.find((event) => event.kind === "provider-uncertain");
    if (uncertain?.kind === "provider-uncertain") throw new QualificationResultError(`${uncertain.phase}-uncertain`);
    throw new QualificationResultError("completion-missing");
  }
  if (completions.length !== 1) throw new QualificationResultError("completion-multiple");
  const result = completions[0]!.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new QualificationResultError("result-not-object");
  if (!Reflect.ownKeys(result).every((key): key is string => typeof key === "string") || Object.keys(result).sort().join(",") !== Object.keys(expected).sort().join(",")) throw new QualificationResultError("result-keys-inexact");
  for (const [key, value] of Object.entries(expected)) if ((result as Readonly<Record<string, unknown>>)[key] !== value) throw new QualificationResultError(`result-${key}-inexact`);
  return result;
}

export async function qualifyDualProviderDelivery(options: DualProviderQualificationOptions): Promise<DualProviderQualificationEvidence> {
  const canonical = isAbsolute(options.canonicalWorktree) ? await realpath(options.canonicalWorktree).catch(() => undefined) : undefined;
  if (canonical !== options.canonicalWorktree) throw new TypeError("Qualification worktree is not canonical");
  const registry = new AgentProviderFactoryRegistry([options.copilotFactory, options.codexFactory]);
  const delivery = manifest(options, registry);
  const realms = await new DeliveryAgentProviderRealmBroker(registry).acquire(delivery, delivery.deliveryBindingIdentity)
    .catch(() => { throw new DualProviderQualificationError("realm-acquire"); });
  const sessions: NativeProviderSession[] = [];
  let sessionsDisposed = false; let realmsDisposed = false;
  try {
    const bindings = [
      { roleId: "role.copilot" as const, providerIdentity: "provider.copilot" as const, version: "1.0.78", key: "copilot-sdk" as const, modelId: options.copilotModel, instructionPath: join(options.instructionsDirectory, "copilot.md") },
      { roleId: "role.codex" as const, providerIdentity: "provider.codex" as const, version: "0.144.5", key: "codex-cli" as const, modelId: options.codexModel, instructionPath: join(options.instructionsDirectory, "codex.md") },
    ];
    const providers: DualProviderQualificationEvidence["providers"][number][] = [];
    for (const binding of bindings) {
      const adapter = realms.forRole(binding.roleId);
      if (adapter.key !== binding.key) throw new TypeError("Role routed to an inexact Provider adapter");
      const invocation = await dispatch({ delivery, roleId: binding.roleId, providerIdentity: binding.providerIdentity, modelId: binding.modelId, instructionPath: binding.instructionPath });
      const session = await adapter.sessions.open({ dispatch: invocation, signal: new AbortController().signal })
        .catch(() => { throw new DualProviderQualificationError(`${binding.roleId}:open`); }); sessions.push(session);
      const expected = Object.freeze({ typed: true, deliveryId: delivery.deliveryId, roleId: binding.roleId, providerIdentity: binding.providerIdentity });
      const result = await session.run(expected).then((events) => typedResult(events, expected))
        .catch((error: unknown) => { throw new DualProviderQualificationError(`${binding.roleId}:run`, error instanceof QualificationResultError ? error.reason : "run-rejected"); });
      await session.persist().catch(() => { throw new DualProviderQualificationError(`${binding.roleId}:persist`); });
      providers.push(Object.freeze({ roleId: binding.roleId, providerIdentity: binding.providerIdentity, providerVersion: binding.version, adapterKey: binding.key, modelId: binding.modelId, result }));
    }
    await Promise.all(sessions.map((session) => session.dispose()))
      .catch(() => { throw new DualProviderQualificationError("session-teardown"); }); sessionsDisposed = true;
    await realms.dispose().catch(() => { throw new DualProviderQualificationError("realm-teardown"); }); realmsDisposed = true;
    return Object.freeze({ schemaVersion: "execution.dual-provider-qualification@1.0.0", deliveryId: delivery.deliveryId, canonicalWorktree: options.canonicalWorktree, credentialMaterialRead: false, providers: Object.freeze(providers), teardown: Object.freeze({ sessionsDisposed: true, realmsDisposed: true }) });
  } finally {
    if (!sessionsDisposed) await Promise.all(sessions.map((session) => session.dispose().catch(() => undefined)));
    if (!realmsDisposed) await realms.dispose().catch(() => undefined);
  }
}

export async function qualifyTemporaryDualProviderDelivery(runtime: Readonly<{
  copilotFactory: AgentProviderRealmFactory;
  copilotModel: string;
  codexFactory: (stateDirectory: string) => AgentProviderRealmFactory;
  codexModel: string;
}>): Promise<DualProviderQualificationEvidence> {
  const root = await mkdtemp(join(tmpdir(), "wsr-dual-provider-qualification-"));
  try {
    const worktreeCandidate = join(root, "worktree"); const instructionsDirectory = join(root, "instructions"); const stateDirectory = join(root, "codex-state");
    await mkdir(worktreeCandidate); await mkdir(instructionsDirectory); await mkdir(stateDirectory);
    if (spawnSync("git", ["init", "--quiet", worktreeCandidate], { stdio: "ignore" }).status !== 0) throw new TypeError("Temporary Git worktree initialization failed");
    await writeFile(join(instructionsDirectory, "copilot.md"), "Act only as role.copilot in the admitted Delivery. Return the exact typed result requested by the Action.");
    await writeFile(join(instructionsDirectory, "codex.md"), "Act only as role.codex in the admitted Delivery. Return the exact typed result requested by the Action.");
    const canonicalWorktree = await realpath(worktreeCandidate);
    const evidence = await qualifyDualProviderDelivery({
      deliveryId: "delivery.dual-provider-real-qualification",
      canonicalWorktree,
      instructionsDirectory,
      copilotFactory: runtime.copilotFactory,
      copilotModel: runtime.copilotModel,
      codexFactory: runtime.codexFactory(stateDirectory),
      codexModel: runtime.codexModel,
    });
    return evidence;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    const codexExecutable = await realpath(createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"));
    const evidence = await qualifyTemporaryDualProviderDelivery({
      copilotFactory: createCopilotAgentProviderFactory(), copilotModel: "gpt-5.3-codex",
      codexFactory: (stateDirectory) => new CodexCliProviderRealmFactory({ executablePath: codexExecutable, requiredVersion: "0.144.5", stateDirectory, startupTimeoutMs: 30_000, executionTimeoutMs: 300_000, shutdownTimeoutMs: 5_000 }),
      codexModel: "gpt-5.6-sol",
    });
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    const stage = error instanceof DualProviderQualificationError ? error.stage : "setup";
    const reason = error instanceof DualProviderQualificationError ? error.reason : "setup-failed";
    process.stderr.write(`Dual Provider qualification failed at ${stage} (${reason}) without emitting provider payloads.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
