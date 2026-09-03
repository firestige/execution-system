import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { FrozenJsonSchema, FrozenJsonValue, InvocationDispatch } from "../../contracts/index.js";
import type { AgentProviderDeliveryRealmLease, AgentProviderDeliveryRealmRequest, AgentProviderRealmFactory, NativeProviderSession, NativeTurnEvent } from "../provider.js";
import { projectAdmittedInstructionChain } from "../admitted-instruction-chain.js";

export const COPILOT_PROVIDER_IDENTITY = "provider.copilot" as const;
export const COPILOT_RUNTIME_VERSION = "1.0.78" as const;
const PLATFORM_PACKAGE = `@github/copilot-${process.platform}-${process.arch}`;

export interface CopilotSdkTool {
  readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>>;
  readonly skipPermission: true; readonly defer: "never"; readonly handler?: (input: any) => Promise<unknown> | unknown;
}
export interface CopilotSdkSessionConfiguration {
  readonly sessionId?: string; readonly clientName: string; readonly model: string; readonly workingDirectory: string;
  readonly systemMessage: Readonly<{ mode: "append"; content: string }>; readonly tools: readonly CopilotSdkTool[]; readonly availableTools: readonly string[];
  readonly onPermissionRequest: (request: unknown, invocation: Readonly<{ sessionId: string }>) => Promise<Readonly<{ kind: "reject"; feedback: string }>>;
  readonly onEvent: (event: unknown) => void; readonly remoteSession: "off"; readonly skipCustomInstructions: true; readonly enableConfigDiscovery: false;
  readonly customAgentsLocalOnly: true; readonly coauthorEnabled: false; readonly manageScheduleEnabled: false; readonly enableFileHooks: false;
  readonly enableHostGitOperations: false; readonly enableSessionStore: false; readonly enableSkills: false; readonly infiniteSessions: Readonly<{ enabled: false }>;
  readonly memory: Readonly<{ enabled: false }>; readonly mcpServers: Readonly<Record<string, never>>; readonly skillDirectories: readonly string[];
  readonly pluginDirectories: readonly string[]; readonly instructionDirectories: readonly string[];
}
export interface CopilotSdkSession { readonly sessionId: string; sendAndWait(message: Readonly<{ prompt: string }>, timeout?: number): Promise<unknown>; abort(): Promise<void>; disconnect(): Promise<void> }
export interface CopilotSdkClient {
  start(): Promise<void>; getStatus(): Promise<Readonly<{ version: string; protocolVersion: number }>>; getAuthStatus(): Promise<Readonly<{ isAuthenticated: boolean; authType?: string }>>;
  listModels(): Promise<readonly Readonly<{ id: string }>[]>; createSession(configuration: CopilotSdkSessionConfiguration): Promise<CopilotSdkSession>;
  resumeSession(sessionId: string, configuration: CopilotSdkSessionConfiguration): Promise<CopilotSdkSession>; getSessionMetadata(sessionId: string): Promise<unknown>;
  stop(): Promise<readonly Error[]>; forceStop(): Promise<void>;
}
export interface CopilotSdkRuntimeBinding {
  readonly wrapperPackageName: "@github/copilot"; readonly wrapperPackageVersion: string; readonly platformPackageName: string; readonly platformPackageVersion: string;
  readonly createClient: (options: Readonly<{ mode: "empty"; useLoggedInUser: true; workingDirectory: string; baseDirectory: string; logLevel: "error" }>) => CopilotSdkClient;
}
export interface CopilotAgentProviderFactoryOptions { readonly resolveRuntime?: () => Promise<CopilotSdkRuntimeBinding>; readonly turnTimeoutMs?: number }
type JsonObject = Readonly<Record<string, unknown>>;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }

async function packageMetadata(root: string): Promise<Readonly<{ name: string; version: string }>> {
  const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown;
  if (!plain(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") throw new TypeError("Copilot package metadata is invalid");
  return { name: parsed.name, version: parsed.version };
}
export async function resolveInstalledCopilotSdkRuntime(): Promise<CopilotSdkRuntimeBinding> {
  const require = createRequire(import.meta.url); const wrapperRoot = dirname(require.resolve("@github/copilot/npm-loader.js"));
  const platformRoot = dirname(createRequire(join(wrapperRoot, "package.json")).resolve(PLATFORM_PACKAGE));
  const [wrapper, platform] = await Promise.all([packageMetadata(wrapperRoot), packageMetadata(platformRoot)]);
  const sdk = await import(pathToFileURL(join(platformRoot, "copilot-sdk", "index.js")).href) as { readonly CopilotClient?: new (options: unknown) => CopilotSdkClient };
  if (typeof sdk.CopilotClient !== "function") throw new TypeError("Copilot SDK import probe failed");
  return Object.freeze({ wrapperPackageName: wrapper.name as "@github/copilot", wrapperPackageVersion: wrapper.version, platformPackageName: platform.name, platformPackageVersion: platform.version, createClient: (options: Parameters<CopilotSdkRuntimeBinding["createClient"]>[0]) => new sdk.CopilotClient!(options) });
}
function exactRuntime(binding: CopilotSdkRuntimeBinding): void {
  if (binding.wrapperPackageName !== "@github/copilot" || binding.wrapperPackageVersion !== COPILOT_RUNTIME_VERSION || binding.platformPackageName !== PLATFORM_PACKAGE || binding.platformPackageVersion !== COPILOT_RUNTIME_VERSION || typeof binding.createClient !== "function") throw new TypeError("Copilot exact runtime binding is unavailable");
}
function matches(pattern: string, candidate: string): boolean { if (pattern === "**") return true; if (pattern.endsWith("/**")) { const prefix = pattern.slice(0, -3).replace(/\/$/u, ""); return candidate === prefix || candidate.startsWith(`${prefix}/`); } return candidate === pattern; }
async function scopedPath(root: string, requested: unknown, mode: "read" | "write", dispatch: InvocationDispatch): Promise<string> {
  if (typeof requested !== "string" || requested === "" || isAbsolute(requested) || requested.split(/[\\/]/u).includes("..")) throw new TypeError("Copilot workspace path is not a relative admitted path");
  const normalized = requested.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized === "" || !dispatch.executor.turn.access.some((rule) => (mode === "read" ? rule.mode === "read" || rule.mode === "write" : rule.mode === "write") && matches(rule.path, normalized))) throw new TypeError("Copilot workspace path is outside the admitted path scope");
  const target = resolve(root, normalized); const anchor = mode === "read" ? await realpath(target) : await realpath(target).catch(async (error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return realpath(dirname(target)); });
  const displacement = relative(root, anchor); if (displacement === ".." || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) throw new TypeError("Copilot workspace path escapes the admitted worktree"); return target;
}
function workspaceTools(worktree: string, dispatch: InvocationDispatch): CopilotSdkTool[] {
  return dispatch.executor.session.tools.map((projection) => { const configuration = projection.configuration as JsonObject;
    if (configuration.workspaceAccess !== true || typeof configuration.toolName !== "string" || configuration.toolName === "" || dispatch.workspace.kind === "none") throw new TypeError("Copilot tool binding is not an admitted workspace tool");
    return Object.freeze({ name: configuration.toolName, description: "Read or write one path inside the signed workflow workspace scope.", parameters: Object.freeze({ type: "object", properties: { operation: { enum: ["list", "read", "write"] }, path: { type: "string" }, content: { type: "string" } }, required: ["operation", "path"], additionalProperties: false }), skipPermission: true as const, defer: "never" as const,
      async handler(args: { operation?: unknown; path?: unknown; content?: unknown }) { if (args.operation === "list") { const entries = await readdir(await scopedPath(worktree, args.path, "read", dispatch), { withFileTypes: true }); return { entries: entries.sort((left, right) => left.name.localeCompare(right.name)).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other" })) }; } if (args.operation === "read") return { content: await readFile(await scopedPath(worktree, args.path, "read", dispatch), "utf8") }; if (args.operation !== "write" || typeof args.content !== "string") throw new TypeError("Copilot workspace write requires content"); await writeFile(await scopedPath(worktree, args.path, "write", dispatch), args.content, "utf8"); return { written: true }; },
    });
  });
}
function compatibilityPrefix(dispatch: InvocationDispatch): string { return `wsr-${sha256(JSON.stringify({ delivery: dispatch.episode.thread.delivery.deliveryIdentity, manifest: dispatch.episode.thread.delivery.manifestBindingIdentity, role: dispatch.executor.session.roleIdentity, route: dispatch.executor.session.routeIdentity, model: dispatch.executor.session.model.providerModelIdentity, session: dispatch.executor.sessionCompatibilityIdentity })).slice(0, 24)}-`; }
function eventProjection(event: unknown): NativeTurnEvent | undefined { if (!plain(event) || typeof event.type !== "string") return undefined; const data = plain(event.data) ? event.data : {}; if (event.type === "assistant.message" && typeof data.content === "string" && data.content.length > 0) return { kind: "output", content: data.content }; if (event.type === "session.error") return { kind: "provider-failed", code: "PROVIDER_PROTOCOL_ERROR", detail: "Copilot session reported an error" }; if (event.type === "abort") return { kind: "provider-failed", code: "PROVIDER_CANCELLED", detail: "Copilot turn was cancelled" }; return undefined; }

class CopilotNativeSession implements NativeProviderSession {
  readonly opaqueIdentity: string; #disposed = false; #events: NativeTurnEvent[] = [];
  constructor(private readonly client: CopilotSdkClient, private readonly session: CopilotSdkSession, private readonly turnTimeoutMs: number, private readonly release: () => void) { this.opaqueIdentity = session.sessionId; }
  accept(event: unknown): void { const projected = eventProjection(event); if (projected !== undefined) this.#events.push(projected); }
  terminal(event: NativeTurnEvent): void { this.#events.push(event); }
  async run(input: unknown): Promise<readonly NativeTurnEvent[]> { if (this.#disposed) throw new TypeError("Copilot session is disposed"); this.#events.splice(0); let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.session.sendAndWait({ prompt: JSON.stringify({ kind: "WSR_AGENT_ACTION", input }) }, this.turnTimeoutMs), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "WSR_COPILOT_TIMEOUT" })), this.turnTimeoutMs); })]); }
    catch (error) { if ((error as { code?: unknown }).code === "WSR_COPILOT_TIMEOUT") { await this.session.abort().catch(() => undefined); return Object.freeze([...this.#events, { kind: "provider-failed", code: "PROVIDER_TIMED_OUT", detail: "Copilot turn timed out" } as const]); } return Object.freeze([...this.#events, { kind: "provider-failed", code: "PROVIDER_EXITED", detail: "Copilot runtime exited during the turn" } as const]); }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
    if (!this.#events.some((event) => event.kind === "structured-completion" || event.kind === "input-request" || event.kind === "provider-failed")) this.#events.push({ kind: "turn-ended" });
    const completion = this.#events.find((event): event is Extract<NativeTurnEvent, { kind: "structured-completion" }> => event.kind === "structured-completion");
    if (completion === undefined) return Object.freeze([...this.#events]);
    const projected: NativeTurnEvent[] = [];
    for (const event of this.#events) {
      if (event.kind === "output") continue;
      if (event === completion) projected.push({ kind: "output", content: completion.result });
      projected.push(event);
    }
    return Object.freeze(projected);
  }
  async persist(): Promise<void> { try { if (await this.client.getSessionMetadata(this.opaqueIdentity) === undefined) throw new Error("missing"); } catch { throw new TypeError("Copilot result persistence is uncertain"); } }
  async cancel(): Promise<void> { if (!this.#disposed) await this.session.abort(); }
  async dispose(): Promise<void> { if (this.#disposed) return; this.#disposed = true; try { await this.session.disconnect(); } finally { this.release(); } }
}
function validateDispatch(request: AgentProviderDeliveryRealmRequest, roles: ReadonlyMap<string, { modelProviderId: string; modelId: string }>, dispatch: InvocationDispatch): void {
  if (dispatch.executor.session.driver.providerIdentity !== "copilot-sdk") throw new TypeError("Copilot driver binding is not exact");
  if (dispatch.episode.thread.delivery.deliveryIdentity !== request.deliveryId || dispatch.episode.thread.delivery.manifestBindingIdentity !== request.manifestBindingIdentity) throw new TypeError("Copilot Delivery binding is not exact");
  const binding = roles.get(dispatch.executor.session.roleIdentity); if (binding === undefined) throw new TypeError("Copilot Role binding is not frozen in this Delivery realm");
  if (binding.modelId !== dispatch.executor.session.model.providerModelIdentity || binding.modelProviderId !== "github-copilot") throw new TypeError("Copilot model binding is not frozen in this Delivery realm");
}
function actionPrompt(dispatch: InvocationDispatch, text: string): string { return [text, "You are bound to exactly one admitted WSR Action. Use only the supplied tools.", `Role: ${dispatch.executor.session.roleIdentity}`, `Route: ${dispatch.executor.session.routeIdentity}`, `Action: ${dispatch.action.identity}`, `Purpose: ${dispatch.action.purpose}`, `Result schema: ${JSON.stringify(dispatch.action.resultSchema)}`, "Finish only by calling workflow_complete once, or workflow_request_input when admitted."].join("\n"); }

export function createCopilotAgentProviderFactory(options: CopilotAgentProviderFactoryOptions = {}): AgentProviderRealmFactory {
  const resolveRuntime = options.resolveRuntime ?? resolveInstalledCopilotSdkRuntime; const turnTimeoutMs = options.turnTimeoutMs ?? 7_200_000;
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1) throw new TypeError("Copilot turn timeout is invalid");
  const descriptor = Object.freeze({ schemaVersion: "execution.agent-provider-factory@1.0.0" as const, identity: COPILOT_PROVIDER_IDENTITY, version: COPILOT_RUNTIME_VERSION, adapterKey: "copilot-sdk" as const, capabilities: Object.freeze(["action-interaction", "structured-completion"] as const) });
  return Object.freeze({ descriptor, async acquire(request: AgentProviderDeliveryRealmRequest): Promise<AgentProviderDeliveryRealmLease> {
    if (request.providerIdentity !== descriptor.identity || request.providerVersion !== descriptor.version || !isAbsolute(request.canonicalWorktree) || await realpath(request.canonicalWorktree) !== request.canonicalWorktree || request.roleBindings.length === 0) throw new TypeError("Copilot Delivery realm request is invalid");
    const roles = new Map<string, { modelProviderId: string; modelId: string }>(); for (const role of request.roleBindings) { if (roles.has(role.roleId) || role.modelProviderId !== "github-copilot" || role.modelId === "") throw new TypeError("Copilot Role binding is invalid"); roles.set(role.roleId, { modelProviderId: role.modelProviderId, modelId: role.modelId }); }
    const runtime = await resolveRuntime(); exactRuntime(runtime); const client = runtime.createClient({ mode: "empty", useLoggedInUser: true, workingDirectory: request.canonicalWorktree, baseDirectory: join(homedir(), ".copilot"), logLevel: "error" });
    try { await client.start(); const [status, auth, models] = await Promise.all([client.getStatus(), client.getAuthStatus(), client.listModels()]); if (status.version !== COPILOT_RUNTIME_VERSION) throw new TypeError("Copilot observed runtime version is incompatible"); if (!auth.isAuthenticated) throw new TypeError("Copilot local login is unavailable"); for (const binding of roles.values()) if (!models.some((model) => model.id === binding.modelId)) throw new TypeError("Copilot frozen model is unavailable"); }
    catch (cause) { try { if ((await client.stop()).length > 0) await client.forceStop(); } catch { await client.forceStop().catch(() => undefined); } throw cause; }
    let disposed = false; const live = new Set<CopilotNativeSession>();
    const sessionConfiguration = async (dispatch: InvocationDispatch, sessionId?: string): Promise<Readonly<{ configuration: CopilotSdkSessionConfiguration; attach(value: CopilotNativeSession): void }>> => { if (disposed) throw new TypeError("Copilot Delivery realm is disposed"); validateDispatch(request, roles, dispatch); const pending: NativeTurnEvent[] = []; let native: CopilotNativeSession | undefined; const terminal = (event: NativeTurnEvent) => native === undefined ? pending.push(event) : native.terminal(event);
      const completion: CopilotSdkTool = Object.freeze({ name: "workflow_complete", description: "Submit the one structured result for this admitted Action.", parameters: Object.freeze({ type: "object", properties: { result: dispatch.action.resultSchema }, required: ["result"], additionalProperties: false }), skipPermission: true, defer: "never", handler: async (args: { result?: unknown }) => terminal({ kind: "structured-completion", result: args.result as FrozenJsonValue }) });
      const interaction: CopilotSdkTool = Object.freeze({ name: "workflow_request_input", description: "Suspend this Action for one typed external answer.", parameters: Object.freeze({ type: "object", properties: { requestIdentity: { type: "string" }, prompt: {}, responseSchema: {} }, required: ["requestIdentity", "prompt", "responseSchema"], additionalProperties: false }), skipPermission: true, defer: "never", handler: async (args: { requestIdentity?: unknown; prompt?: unknown; responseSchema?: unknown }) => { if (typeof args.requestIdentity !== "string" || args.requestIdentity === "" || !plain(args.responseSchema)) throw new TypeError("Copilot input request is invalid"); terminal({ kind: "input-request", requestIdentity: args.requestIdentity, prompt: args.prompt as FrozenJsonValue, responseSchema: args.responseSchema as FrozenJsonSchema }); return { suspended: true }; } });
      const tools = [completion, ...(dispatch.executor.session.providedCapabilities.includes("action-interaction") ? [interaction] : []), ...workspaceTools(request.canonicalWorktree, dispatch)].sort((left, right) => left.name.localeCompare(right.name));
      const configuration: CopilotSdkSessionConfiguration = Object.freeze({ ...(sessionId === undefined ? {} : { sessionId }), clientName: "workflow-self-recursive", model: dispatch.executor.session.model.providerModelIdentity, workingDirectory: request.canonicalWorktree, systemMessage: Object.freeze({ mode: "append" as const, content: actionPrompt(dispatch, await projectAdmittedInstructionChain(dispatch.executor.session)) }), tools: Object.freeze(tools), availableTools: Object.freeze(tools.map((tool) => tool.name)), onPermissionRequest: async () => Object.freeze({ kind: "reject" as const, feedback: "operation is outside the admitted Action tool scope" }), onEvent: (event: unknown) => { const value = eventProjection(event); if (value !== undefined) terminal(value); }, remoteSession: "off" as const, skipCustomInstructions: true as const, enableConfigDiscovery: false as const, customAgentsLocalOnly: true as const, coauthorEnabled: false as const, manageScheduleEnabled: false as const, enableFileHooks: false as const, enableHostGitOperations: false as const, enableSessionStore: false as const, enableSkills: false as const, infiniteSessions: Object.freeze({ enabled: false as const }), memory: Object.freeze({ enabled: false as const }), mcpServers: Object.freeze({}), skillDirectories: Object.freeze([]), pluginDirectories: Object.freeze([]), instructionDirectories: Object.freeze([]) });
      return Object.freeze({ configuration, attach(value: CopilotNativeSession) { native = value; for (const event of pending) native.terminal(event); } });
    };
    const sessions = Object.freeze({ async open(openRequest: { dispatch: InvocationDispatch; signal: AbortSignal }): Promise<NativeProviderSession> { if (openRequest.signal.aborted) throw new TypeError("Copilot session start was cancelled"); const id = `${compatibilityPrefix(openRequest.dispatch)}${randomUUID()}`; const prepared = await sessionConfiguration(openRequest.dispatch, id); let sdkSession: CopilotSdkSession; try { sdkSession = await client.createSession(prepared.configuration); } catch { throw new TypeError("Copilot session start is uncertain"); } if (sdkSession.sessionId !== id) { await sdkSession.disconnect().catch(() => undefined); throw new TypeError("Copilot session start returned an incompatible identity"); } const native = new CopilotNativeSession(client, sdkSession, turnTimeoutMs, () => live.delete(native)); prepared.attach(native); live.add(native); return native; },
      async restore(restoreRequest: { opaqueIdentity: string; dispatch: InvocationDispatch; signal: AbortSignal }): Promise<NativeProviderSession> { if (!restoreRequest.opaqueIdentity.startsWith(compatibilityPrefix(restoreRequest.dispatch))) throw new TypeError("Copilot recovery binding is incompatible"); const prepared = await sessionConfiguration(restoreRequest.dispatch); let sdkSession: CopilotSdkSession; try { sdkSession = await client.resumeSession(restoreRequest.opaqueIdentity, prepared.configuration); } catch { throw new TypeError("Copilot session recovery is uncertain"); } if (sdkSession.sessionId !== restoreRequest.opaqueIdentity) { await sdkSession.disconnect().catch(() => undefined); throw new TypeError("Copilot recovery returned an incompatible identity"); } const native = new CopilotNativeSession(client, sdkSession, turnTimeoutMs, () => live.delete(native)); prepared.attach(native); live.add(native); return native; } });
    const dispose = async () => { if (disposed) return; disposed = true; await Promise.all([...live].map((session) => session.dispose().catch(() => undefined))); try { if ((await client.stop()).length > 0) await client.forceStop(); } catch { await client.forceStop().catch(() => undefined); } };
    const adapter = Object.freeze({ key: "copilot-sdk" as const, sessions, dispose }); return Object.freeze({ schemaVersion: "execution.agent-provider-delivery-realm-lease@2.0.0" as const, providerIdentity: request.providerIdentity, providerVersion: request.providerVersion, descriptorDigest: request.providerDescriptorDigest, deliveryId: request.deliveryId, manifestBindingIdentity: request.manifestBindingIdentity, adapter, dispose });
  } });
}
