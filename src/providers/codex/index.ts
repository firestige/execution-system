import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { canonicalJsonBytes, deepFreeze } from "../../configuration/canonical.js";
import type { FrozenJsonValue } from "../../contracts/index.js";
import type {
  AgentProviderAdapter,
  AgentProviderDeliveryRealmLease,
  AgentProviderDeliveryRealmRequest,
  AgentProviderRealmFactory,
  AgentProviderSessionOpenRequest,
  AgentProviderSessionRestoreRequest,
  NativeProviderSession,
  NativeTurnEvent,
} from "../provider.js";

const EXACT_VERSION = "0.144.5";
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const REQUIRED_EXEC_OPTIONS = Object.freeze([
  "--sandbox", "--json", "--model", "--config", "--ignore-user-config",
  "--output-schema", "--output-last-message", "--cd",
]);
const REQUIRED_RESUME_OPTIONS = Object.freeze([
  "--json", "--model", "--config", "--ignore-user-config", "--output-schema", "--output-last-message",
]);
const KNOWN_JSONL_EVENTS = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed", "error",
  "item.started", "item.updated", "item.completed",
]);

export interface CodexCliProviderConfiguration {
  readonly executablePath: string;
  readonly requiredVersion: "0.144.5";
  readonly stateDirectory: string;
  readonly startupTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export type CodexCliProviderErrorCode =
  | "CODEX_CONFIGURATION_INVALID"
  | "CODEX_ADMISSION_FAILED"
  | "CODEX_BINDING_REJECTED"
  | "CODEX_RESUME_INCOMPATIBLE"
  | "CODEX_SESSION_DISPOSED";

export class CodexCliProviderError extends Error {
  constructor(readonly code: CodexCliProviderErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "CodexCliProviderError";
  }
}

interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnUncertain: boolean;
  readonly outputOverflow: boolean;
}

interface PersistedCodexSession {
  readonly schemaVersion: "execution.codex-cli-session@1.0.0";
  readonly opaqueIdentity: string;
  readonly threadIdentity: string;
  readonly compatibilityIdentity: string;
  readonly deliveryId: string;
  readonly manifestBindingIdentity: string;
}

function exactConfiguration(value: CodexCliProviderConfiguration): CodexCliProviderConfiguration {
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !==
    "executablePath,executionTimeoutMs,requiredVersion,shutdownTimeoutMs,startupTimeoutMs,stateDirectory") {
    throw new CodexCliProviderError("CODEX_CONFIGURATION_INVALID");
  }
  if (!isAbsolute(value.executablePath) || !isAbsolute(value.stateDirectory) || value.requiredVersion !== EXACT_VERSION ||
    ![value.startupTimeoutMs, value.executionTimeoutMs, value.shutdownTimeoutMs]
      .every((item) => Number.isSafeInteger(item) && item > 0)) {
    throw new CodexCliProviderError("CODEX_CONFIGURATION_INVALID");
  }
  return Object.freeze({ ...value });
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(value as FrozenJsonValue)).digest("hex")}`;
}

function events(...value: NativeTurnEvent[]): readonly NativeTurnEvent[] {
  return Object.freeze(value);
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "APPDATA", "CODEX_HOME", "COMSPEC", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA",
    "LOGNAME", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR",
    "USER", "USERPROFILE", "WINDIR",
  ];
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
}

function terminate(child: ChildProcessWithoutNullStreams, shutdownTimeoutMs: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, shutdownTimeoutMs);
  deadline.unref();
}

function execute(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    input?: string;
    timeoutMs: number;
    shutdownTimeoutMs: number;
    signal?: AbortSignal;
    active: Set<ChildProcessWithoutNullStreams>;
  }>,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({ exitCode: null, stdout: "", timedOut: false, cancelled: true, spawnUncertain: false, outputOverflow: false });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: safeEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ exitCode: null, stdout: "", timedOut: false, cancelled: false, spawnUncertain: true, outputOverflow: false });
      return;
    }
    options.active.add(child);
    let stdout = "";
    let timedOut = false;
    let cancelled = false;
    let outputOverflow = false;
    let settled = false;
    const finish = (outcome: Omit<ProcessOutcome, "stdout">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      options.active.delete(child);
      resolve({ ...outcome, stdout });
    };
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) + chunk.byteLength > MAX_PROCESS_OUTPUT_BYTES) {
        outputOverflow = true;
        terminate(child, options.shutdownTimeoutMs);
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.once("error", () => finish({ exitCode: null, timedOut, cancelled, spawnUncertain: true, outputOverflow }));
    child.once("close", (code) => finish({ exitCode: code, timedOut, cancelled, spawnUncertain: false, outputOverflow }));
    const abort = () => { cancelled = true; terminate(child, options.shutdownTimeoutMs); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; terminate(child, options.shutdownTimeoutMs); }, options.timeoutMs);
    timeout.unref();
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

function exactRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseCatalog(stdout: string): readonly string[] | undefined {
  try {
    const root = exactRecord(JSON.parse(stdout));
    if (!Array.isArray(root?.models)) return undefined;
    const models = root.models.map((candidate) => exactRecord(candidate)?.slug);
    return models.every((model) => typeof model === "string") ? models as string[] : undefined;
  } catch { return undefined; }
}

async function readBoundedResult(filename: string): Promise<string | undefined> {
  const handle = await open(filename, "r").catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const metadata = await handle.stat();
    if (metadata.size > MAX_PROCESS_OUTPUT_BYTES) return undefined;
    const buffer = Buffer.alloc(Math.min(MAX_PROCESS_OUTPUT_BYTES + 1, Math.max(1, metadata.size + 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > MAX_PROCESS_OUTPUT_BYTES ? undefined : buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return undefined; }
  finally { await handle.close(); }
}

async function preflight(
  configuration: CodexCliProviderConfiguration,
  worktree: string,
  modelIds: readonly string[],
  active: Set<ChildProcessWithoutNullStreams>,
): Promise<void> {
  const run = (args: readonly string[]) => execute(configuration.executablePath, args, {
    cwd: worktree,
    timeoutMs: configuration.startupTimeoutMs,
    shutdownTimeoutMs: configuration.shutdownTimeoutMs,
    active,
  });
  const version = await run(["--version"]);
  if (version.exitCode !== 0 || version.stdout.trim() !== `codex-cli ${EXACT_VERSION}`) {
    throw new CodexCliProviderError("CODEX_ADMISSION_FAILED", "exact CLI version unavailable");
  }
  const help = await run(["exec", "--help"]);
  if (help.exitCode !== 0 || REQUIRED_EXEC_OPTIONS.some((option) => !help.stdout.includes(option))) {
    throw new CodexCliProviderError("CODEX_ADMISSION_FAILED", "non-interactive JSONL surface unavailable");
  }
  const resumeHelp = await run(["exec", "resume", "--help"]);
  if (resumeHelp.exitCode !== 0 || REQUIRED_RESUME_OPTIONS.some((option) => !resumeHelp.stdout.includes(option))) {
    throw new CodexCliProviderError("CODEX_ADMISSION_FAILED", "exact resume surface unavailable");
  }
  const login = await run(["login", "status"]);
  if (login.exitCode !== 0) throw new CodexCliProviderError("CODEX_ADMISSION_FAILED", "local login unavailable");
  const catalog = await run(["debug", "models"]);
  const available = catalog.exitCode === 0 ? parseCatalog(catalog.stdout) : undefined;
  if (available === undefined || modelIds.some((model) => !available.includes(model))) {
    throw new CodexCliProviderError("CODEX_ADMISSION_FAILED", "frozen model unavailable");
  }
}

function exactRealmRequest(value: AgentProviderDeliveryRealmRequest): void {
  if (value.schemaVersion !== "execution.agent-provider-delivery-realm-request@2.0.0" ||
    value.providerIdentity !== "provider.codex" || value.providerVersion !== EXACT_VERSION ||
    !Number.isSafeInteger(value.maxParallelToolCalls) || value.maxParallelToolCalls < 1 ||
    !Array.isArray(value.roleBindings) || value.roleBindings.length === 0 ||
    value.roleBindings.some((role) => role.modelProviderId !== "openai" || role.modelId.length === 0)) {
    throw new CodexCliProviderError("CODEX_ADMISSION_FAILED", "Delivery realm binding mismatch");
  }
}

interface CapturedBinding {
  readonly roleIdentity: string;
  readonly modelIdentity: string;
  readonly sandbox: "read-only" | "workspace-write";
  readonly reasoningEffort?: string;
  readonly approvalPolicy: "never";
  readonly compatibilityIdentity: string;
  readonly prompt: string;
  readonly resultSchema: FrozenJsonValue;
}

async function captureBinding(
  request: AgentProviderSessionOpenRequest,
  worktree: string,
  admittedRoles: ReadonlyMap<string, string>,
): Promise<CapturedBinding> {
  const dispatch = request.dispatch;
  const session = dispatch.executor?.session;
  const driver = exactRecord(session?.driver?.configuration);
  const modelConfiguration = exactRecord(session?.model?.configuration);
  const roleIdentity = session?.roleIdentity as string;
  const modelIdentity = session?.model?.providerModelIdentity as string;
  const approvalPolicy = driver?.approvalPolicy;
  const sandbox = driver?.sandbox;
  const reasoningEffort = modelConfiguration?.reasoningEffort;
  const workspaceKind = dispatch.workspace?.kind;
  const instructionPath = session?.instructions?.localReadOnlyPath as string;
  const access = dispatch.executor?.turn?.access;
  const accessMatches = Array.isArray(access) && access.every((rule) => rule.path === ".") && (
    (workspaceKind === "none" && access.length === 0) ||
    (workspaceKind === "read" && access.length > 0 && access.every((rule) => rule.mode === "read")) ||
    (workspaceKind === "write" && access.some((rule) => rule.mode === "write"))
  );
  if (session?.driver?.providerIdentity !== "codex-cli" || admittedRoles.get(roleIdentity) !== modelIdentity ||
    Object.keys(driver ?? {}).sort().join(",") !== "approvalPolicy,sandbox" || approvalPolicy !== "never" ||
    (sandbox !== "read-only" && sandbox !== "workspace-write") ||
    Object.keys(modelConfiguration ?? {}).sort().join(",") !== "reasoningEffort" ||
    typeof reasoningEffort !== "string" || !["low", "medium", "high", "xhigh"].includes(reasoningEffort) ||
    !Array.isArray(session?.tools) || session.tools.length !== 0 ||
    !session.providedCapabilities.includes("structured-completion") || session.providedCapabilities.includes("action-interaction") ||
    (workspaceKind === "write" ? sandbox !== "workspace-write" : sandbox !== "read-only") || !accessMatches ||
    !isAbsolute(instructionPath)) {
    throw new CodexCliProviderError("CODEX_BINDING_REJECTED");
  }
  const instructions = await readFile(instructionPath, "utf8").catch(() => undefined);
  const instructionIdentity = instructions === undefined ? undefined : `sha256:${createHash("sha256").update(instructions).digest("hex")}`;
  if (instructions === undefined || instructionIdentity !== session.instructions.contentIdentity) {
    throw new CodexCliProviderError("CODEX_BINDING_REJECTED", "instruction projection mismatch");
  }
  const projection = deepFreeze({
    action: { identity: dispatch.action.identity, purpose: dispatch.action.purpose },
    role: roleIdentity,
    model: modelIdentity,
    workspace: { canonicalWorktree: worktree, kind: workspaceKind, access: dispatch.executor.turn.access },
    input: dispatch.input,
    instructions,
  });
  return Object.freeze({
    roleIdentity,
    modelIdentity,
    sandbox,
    reasoningEffort,
    approvalPolicy: "never",
    compatibilityIdentity: digest({
      roleIdentity,
      modelIdentity,
      sandbox,
      reasoningEffort,
      approvalPolicy,
      worktree,
      manifestBindingIdentity: request.dispatch.episode?.thread?.delivery?.manifestBindingIdentity ?? null,
      sessionCompatibilityIdentity: request.dispatch.session?.sessionCompatibilityIdentity ?? null,
    }),
    prompt: `${instructions}\n\n<wsr-admitted-action>${JSON.stringify(projection)}</wsr-admitted-action>`,
    resultSchema: dispatch.action.resultSchema as FrozenJsonValue,
  });
}

function parseJsonl(stdout: string): Readonly<{
  threadIdentity?: string;
  completed: boolean;
  failed: boolean;
  anomaly: boolean;
}> {
  let threadIdentity: string | undefined;
  let completed = false;
  let failed = false;
  let anomaly = false;
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    let record: Record<string, unknown> | undefined;
    try { record = exactRecord(JSON.parse(line)); }
    catch { anomaly = true; continue; }
    const type = record?.type;
    if (typeof type !== "string" || !KNOWN_JSONL_EVENTS.has(type)) { anomaly = true; continue; }
    if (type === "thread.started") {
      if (threadIdentity !== undefined || typeof record?.thread_id !== "string" || record.thread_id.length === 0) anomaly = true;
      else threadIdentity = record.thread_id;
    } else if (type === "turn.completed") completed = true;
    else if (type === "turn.failed" || type === "error") failed = true;
  }
  return Object.freeze({ ...(threadIdentity === undefined ? {} : { threadIdentity }), completed, failed, anomaly });
}

class CodexCliSession implements NativeProviderSession {
  readonly #active: Set<ChildProcessWithoutNullStreams>;
  readonly #configuration: CodexCliProviderConfiguration;
  readonly #deliveryId: string;
  readonly #manifestBindingIdentity: string;
  readonly #stateDirectory: string;
  readonly #worktree: string;
  readonly #binding: CapturedBinding;
  readonly #signal: AbortSignal;
  readonly #lifecycle = new AbortController();
  #threadIdentity: string | undefined;
  #disposed = false;
  #running = false;

  constructor(options: Readonly<{
    active: Set<ChildProcessWithoutNullStreams>;
    configuration: CodexCliProviderConfiguration;
    deliveryId: string;
    manifestBindingIdentity: string;
    stateDirectory: string;
    worktree: string;
    binding: CapturedBinding;
    signal: AbortSignal;
    opaqueIdentity: string;
    threadIdentity?: string;
  }>, readonly opaqueIdentity: string = options.opaqueIdentity) {
    this.#active = options.active;
    this.#configuration = options.configuration;
    this.#deliveryId = options.deliveryId;
    this.#manifestBindingIdentity = options.manifestBindingIdentity;
    this.#stateDirectory = options.stateDirectory;
    this.#worktree = options.worktree;
    this.#binding = options.binding;
    this.#signal = options.signal;
    this.#threadIdentity = options.threadIdentity;
  }

  #recordPath(): string {
    return join(this.#stateDirectory, `${createHash("sha256").update(this.opaqueIdentity).digest("hex")}.json`);
  }

  async #saveThread(threadIdentity: string): Promise<void> {
    const record: PersistedCodexSession = Object.freeze({
      schemaVersion: "execution.codex-cli-session@1.0.0",
      opaqueIdentity: this.opaqueIdentity,
      threadIdentity,
      compatibilityIdentity: this.#binding.compatibilityIdentity,
      deliveryId: this.#deliveryId,
      manifestBindingIdentity: this.#manifestBindingIdentity,
    });
    const target = this.#recordPath();
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    this.#threadIdentity = threadIdentity;
  }

  async run(input: unknown): Promise<readonly NativeTurnEvent[]> {
    if (this.#disposed) throw new CodexCliProviderError("CODEX_SESSION_DISPOSED");
    if (this.#running) throw new CodexCliProviderError("CODEX_BINDING_REJECTED", "concurrent session turn");
    this.#running = true;
    const operationDirectory = await mkdtemp(join(this.#stateDirectory, "operation-"));
    const schemaPath = join(operationDirectory, "result.schema.json");
    const outputPath = join(operationDirectory, "result.json");
    await writeFile(schemaPath, `${JSON.stringify(this.#binding.resultSchema)}\n`, { mode: 0o600 });
    const common = [
      "--json", "--ignore-user-config", "--model", this.#binding.modelIdentity,
      "--config", `approval_policy=${JSON.stringify(this.#binding.approvalPolicy)}`,
      "--config", `model_reasoning_effort=${JSON.stringify(this.#binding.reasoningEffort)}`,
      "--config", "shell_environment_policy.inherit=\"none\"",
      "--output-schema", schemaPath, "--output-last-message", outputPath,
    ];
    const args = this.#threadIdentity === undefined
      ? ["exec", ...common, "--sandbox", this.#binding.sandbox, "--cd", this.#worktree, "-"]
      : ["exec", "resume", this.#threadIdentity, ...common, "-"];
    try {
      const outcome = await execute(this.#configuration.executablePath, args, {
        cwd: this.#worktree,
        input: `${this.#binding.prompt}\n\n<wsr-turn-input>${JSON.stringify(input)}</wsr-turn-input>`,
        timeoutMs: this.#configuration.executionTimeoutMs,
        shutdownTimeoutMs: this.#configuration.shutdownTimeoutMs,
        signal: AbortSignal.any([this.#signal, this.#lifecycle.signal]),
        active: this.#active,
      });
      const protocol = parseJsonl(outcome.stdout);
      if (protocol.threadIdentity !== undefined) {
        if (this.#threadIdentity !== undefined && protocol.threadIdentity !== this.#threadIdentity) {
          return events({ kind: "provider-uncertain", phase: "result", detail: "resume returned a different thread identity" });
        }
        await this.#saveThread(protocol.threadIdentity);
      }
      if (outcome.cancelled) return events({ kind: "provider-failed", code: "PROVIDER_CANCELLED", detail: {} });
      if (outcome.timedOut) return events({ kind: "provider-failed", code: "PROVIDER_TIMED_OUT", detail: {} });
      if (outcome.spawnUncertain) {
        return events({ kind: "provider-uncertain", phase: "startup", detail: "Codex start outcome is not observable" });
      }
      if (outcome.exitCode !== 0 && protocol.threadIdentity === undefined) {
        return events({ kind: "provider-failed", code: "PROVIDER_EXITED", detail: "Codex rejected or exited" });
      }
      if (protocol.threadIdentity === undefined) return events({ kind: "provider-uncertain", phase: "startup", detail: "Codex start outcome is not observable" });
      if (outcome.outputOverflow || protocol.anomaly) {
        return events({ kind: "provider-uncertain", phase: "result", detail: "Codex JSONL protocol became unobservable" });
      }
      if (outcome.exitCode !== 0 || protocol.failed) {
        return events({ kind: "provider-failed", code: "PROVIDER_EXITED", detail: "Codex rejected or exited" });
      }
      if (!protocol.completed) {
        return events({ kind: "provider-uncertain", phase: "result", detail: "Codex turn completion is not observable" });
      }
      let result: unknown;
      try {
        const serialized = await readBoundedResult(outputPath);
        if (serialized === undefined) throw new Error("typed result unavailable");
        result = JSON.parse(serialized);
      }
      catch {
        return events({ kind: "provider-uncertain", phase: "result", detail: "Codex typed result is not observable" });
      }
      return events({ kind: "structured-completion", result: deepFreeze(result) as FrozenJsonValue });
    } finally {
      this.#running = false;
      await rm(operationDirectory, { recursive: true, force: true });
    }
  }

  async persist(): Promise<void> {
    if (this.#disposed) throw new CodexCliProviderError("CODEX_SESSION_DISPOSED");
  }

  async cancel(): Promise<void> {
    this.#lifecycle.abort();
    for (const child of this.#active) terminate(child, this.#configuration.shutdownTimeoutMs);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.cancel();
  }
}

export class CodexCliProviderRealmFactory implements AgentProviderRealmFactory {
  readonly descriptor = Object.freeze({
    schemaVersion: "execution.agent-provider-factory@1.0.0" as const,
    identity: "provider.codex",
    version: EXACT_VERSION,
    adapterKey: "codex-cli" as const,
    capabilities: Object.freeze(["structured-completion"]),
  });
  readonly #configuration: CodexCliProviderConfiguration;

  constructor(configuration: CodexCliProviderConfiguration) {
    this.#configuration = exactConfiguration(configuration);
  }

  async acquire(request: AgentProviderDeliveryRealmRequest): Promise<AgentProviderDeliveryRealmLease> {
    exactRealmRequest(request);
    await access(this.#configuration.executablePath, constants.X_OK).catch(() => {
      throw new CodexCliProviderError("CODEX_ADMISSION_FAILED", "CLI executable unavailable");
    });
    const worktree = await realpath(request.canonicalWorktree).catch(() => undefined);
    if (worktree === undefined || worktree !== request.canonicalWorktree) {
      throw new CodexCliProviderError("CODEX_ADMISSION_FAILED", "canonical worktree unavailable");
    }
    await mkdir(this.#configuration.stateDirectory, { recursive: true, mode: 0o700 });
    const stateDirectory = join(this.#configuration.stateDirectory, digest({
      deliveryId: request.deliveryId,
      manifestBindingIdentity: request.manifestBindingIdentity,
    }).slice("sha256:".length));
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const preflightProcesses = new Set<ChildProcessWithoutNullStreams>();
    const admittedRoles = new Map(request.roleBindings.map((role) => [role.roleId, role.modelId]));
    await preflight(this.#configuration, worktree, [...new Set(admittedRoles.values())], preflightProcesses);
    const sessions = new Set<CodexCliSession>();
    let disposed = false;
    const assertLive = () => {
      if (disposed) throw new CodexCliProviderError("CODEX_SESSION_DISPOSED");
    };
    const create = async (sessionRequest: AgentProviderSessionOpenRequest, restored?: PersistedCodexSession): Promise<CodexCliSession> => {
      assertLive();
      const binding = await captureBinding(sessionRequest, worktree, admittedRoles);
      if (restored !== undefined && (restored.compatibilityIdentity !== binding.compatibilityIdentity ||
        restored.deliveryId !== request.deliveryId || restored.manifestBindingIdentity !== request.manifestBindingIdentity)) {
        throw new CodexCliProviderError("CODEX_RESUME_INCOMPATIBLE");
      }
      const session = new CodexCliSession({
        active: new Set<ChildProcessWithoutNullStreams>(),
        configuration: this.#configuration,
        deliveryId: request.deliveryId,
        manifestBindingIdentity: request.manifestBindingIdentity,
        stateDirectory,
        worktree,
        binding,
        signal: sessionRequest.signal,
        opaqueIdentity: restored?.opaqueIdentity ?? `codex:${randomUUID()}`,
        threadIdentity: restored?.threadIdentity,
      });
      sessions.add(session);
      return session;
    };
    const adapter: AgentProviderAdapter = Object.freeze({
      key: "codex-cli" as const,
      sessions: Object.freeze({
        open: (sessionRequest: AgentProviderSessionOpenRequest) => create(sessionRequest),
        restore: async (sessionRequest: AgentProviderSessionRestoreRequest) => {
          assertLive();
          const recordPath = join(stateDirectory, `${createHash("sha256").update(sessionRequest.opaqueIdentity).digest("hex")}.json`);
          let restored: PersistedCodexSession;
          try {
            restored = JSON.parse(await readFile(recordPath, "utf8")) as PersistedCodexSession;
          } catch {
            throw new CodexCliProviderError("CODEX_RESUME_INCOMPATIBLE");
          }
          if (restored.schemaVersion !== "execution.codex-cli-session@1.0.0" || restored.opaqueIdentity !== sessionRequest.opaqueIdentity ||
            typeof restored.threadIdentity !== "string" || typeof restored.compatibilityIdentity !== "string") {
            throw new CodexCliProviderError("CODEX_RESUME_INCOMPATIBLE");
          }
          return create(sessionRequest, restored);
        },
      }),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await Promise.all([...sessions].map((session) => session.dispose()));
      },
    });
    let leaseDisposed = false;
    return Object.freeze({
      schemaVersion: "execution.agent-provider-delivery-realm-lease@2.0.0",
      providerIdentity: request.providerIdentity,
      providerVersion: request.providerVersion,
      descriptorDigest: request.providerDescriptorDigest,
      deliveryId: request.deliveryId,
      manifestBindingIdentity: request.manifestBindingIdentity,
      adapter,
      async dispose() {
        if (leaseDisposed) return;
        leaseDisposed = true;
        await adapter.dispose();
      },
    });
  }
}
