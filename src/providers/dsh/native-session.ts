import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { InvocationDispatch } from "../../contracts/index.js";
import type {
  CredentialLease,
  CredentialLeaseBroker,
  CredentialMaterial,
  NativeProviderSession,
  NativeProviderSessionFactory,
  NativeSessionOpenRequest,
  NativeSessionRestoreRequest,
  NativeTurnEvent,
} from "../provider.js";
import { resolveDshPublicClosure, type DshPublicClosure } from "./public-closure.js";
import { createDshOperationAuthority, type DshOperationAuthority } from "./operation-authority.js";

interface DshSessionEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

interface DshAgent {
  readonly id: string;
  readonly session: { readonly seq: number; readonly events: readonly DshSessionEvent[] };
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  cancel(cause: { readonly kind: "user" }): void;
}

interface DshAgentHandle {
  readonly agent: DshAgent;
  dispose(): Promise<void>;
}

interface DshAgents {
  create(options: Record<string, unknown>): Promise<DshAgentHandle>;
  resume(options: Record<string, unknown>): Promise<DshAgentHandle>;
}

interface DshSessions {
  flush(session: DshAgent["session"]): Promise<unknown>;
}

interface DshToolRuntime {
  register(definition: unknown): () => void;
  restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void;
  schemas(): readonly { readonly name: string }[];
}

interface DshAgentContext {
  get(name: string): unknown;
}

interface DshSystemPrompt {
  section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void;
}

export interface DshNativeSessionFactoryOptions {
  readonly agents: DshAgents;
  readonly sessions: DshSessions;
  readonly workspaceDirectory: string;
  readonly readProjection?: (absolutePath: string) => Promise<string>;
}

function configuration(dispatch: InvocationDispatch): Record<string, unknown> {
  return dispatch.executor.session.driver.configuration as Record<string, unknown>;
}

function exactAgentOptions(dispatch: InvocationDispatch): Record<string, unknown> {
  if (dispatch.executor.session.driver.providerIdentity !== "dsh-headless") throw new TypeError("DSH driver provider binding is not exact");
  const provider = configuration(dispatch).providerRoute;
  if (typeof provider !== "string" || provider === "") throw new TypeError("DSH providerRoute is not admitted");
  return {
    provider,
    model: dispatch.executor.session.model.providerModelIdentity,
  };
}

function outputText(value: unknown): readonly { readonly type: "text"; readonly text: string }[] {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}

async function admittedInstructions(options: DshNativeSessionFactoryOptions, dispatch: InvocationDispatch): Promise<string> {
  const projection = dispatch.executor.session.instructions;
  if (!projection.localReadOnlyPath.startsWith("/")) throw new TypeError("DSH instruction projection path is not managed");
  const text = await (options.readProjection ?? (async (filename) => readFile(filename, "utf8")))(projection.localReadOnlyPath);
  const observed = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  if (observed !== projection.contentIdentity) throw new TypeError("DSH instruction projection identity mismatch");
  return text;
}

function dispositionSetup(
  closure: DshPublicClosure,
  dispatch: InvocationDispatch,
  instructions: string,
  credentials: CredentialMaterial,
  authority: DshOperationAuthority,
  dispositions: NativeTurnEvent[],
): (context: DshAgentContext) => Promise<void> {
  return async (context) => {
    closure.installModelSelection(context, { current: exactAgentOptions(dispatch), assembled: undefined });
    const systemPrompt = context.get("systemPrompt") as DshSystemPrompt | undefined;
    if (systemPrompt === undefined || typeof systemPrompt.section !== "function") throw new TypeError("DSH managed system prompt is unavailable");
    systemPrompt.section({ name: "workflow:admitted-instructions", order: 10, text: instructions });
    const tools = context.get("tools") as DshToolRuntime | undefined;
    if (tools === undefined || typeof tools.register !== "function") throw new TypeError("DSH structured tool runtime is unavailable");
    const admittedTools = dispatch.executor.session.tools.map((tool) => {
      const toolName = (tool.configuration as Record<string, unknown>).toolName;
      if (typeof toolName !== "string" || toolName === "") throw new TypeError("DSH tool binding is not exact");
      const workspaceAccess = (tool.configuration as Record<string, unknown>).workspaceAccess === true;
      if (dispatch.workspace.kind === "none" && workspaceAccess) {
        throw new TypeError("DSH workspace tool lacks an authorized workspace capability");
      }
      return { name: toolName, workspaceAccess };
    });
    const credentialRef = configuration(dispatch).credentialRef;
    if (typeof credentialRef !== "string" || credentialRef === "" || credentials.apiKey === undefined || credentials.apiKey === "") {
      throw new TypeError("DSH exact operation credential is unavailable");
    }
    const installed = await authority.install(context, {
      provider: exactAgentOptions(dispatch).provider as string,
      model: exactAgentOptions(dispatch).model as string,
      ...(typeof configuration(dispatch).baseURL === "string" ? { baseURL: configuration(dispatch).baseURL as string } : {}),
      credential: { reference: credentialRef, value: credentials.apiKey },
      workspace: dispatch.workspace,
      access: dispatch.executor.turn?.access ?? [],
      tools: admittedTools,
    });
    const admittedToolNames = admittedTools.map((tool) => tool.name);
    if (installed.authorizedToolNames.length !== admittedToolNames.length ||
      installed.authorizedToolNames.some((name, index) => name !== admittedToolNames[index])) {
      throw new TypeError("DSH operation authority did not install the exact admitted tool scope");
    }
    const globalToolNames = tools.schemas().map((schema) => schema.name);
    // Admitted implementations were registered into this agent scope above.
    // DSH restrictions apply only to inherited/global tools, so remove that
    // entire ambient surface and leave the scoped capabilities intact.
    if (globalToolNames.length > 0) tools.restrict({ deny: globalToolNames });
    tools.register(closure.defineTool({
      name: "workflow_complete",
      description: "Submit the one structured Action result. This is the only completion protocol.",
      parameters: { result: { type: "json", required: true } },
      output: {
        schema: { type: "object", properties: { accepted: { type: "boolean" } }, additionalProperties: false },
        render: () => outputText("structured completion accepted"),
      },
      async execute(args: { result: unknown }, execution: { concludeTurn(): void }) {
        dispositions.push({ kind: "structured-completion", result: args.result as never });
        execution.concludeTurn();
        return { accepted: true };
      },
    }));
    if (dispatch.executor.session.providedCapabilities.includes("action-interaction")) {
      tools.register(closure.defineTool({
        name: "workflow_request_input",
        description: "Request one natural-language external Action answer while keeping this exact episode and session.",
        parameters: {
          requestIdentity: { type: "string", required: true },
          prompt: { type: "json", required: true },
        },
        output: {
          schema: { type: "object", properties: { suspended: { type: "boolean" } }, additionalProperties: false },
          render: () => outputText("input request persisted"),
        },
        async execute(args: { requestIdentity: string; prompt: unknown }, execution: { concludeTurn(): void }) {
          dispositions.push({
            kind: "input-request",
            requestIdentity: args.requestIdentity,
            prompt: args.prompt as never,
            responseSchema: { type: "string" },
          });
          execution.concludeTurn();
          return { suspended: true };
        },
      }));
    }
  };
}

class DshNativeProviderSession implements NativeProviderSession {
  readonly opaqueIdentity: string;

  constructor(
    private readonly handle: DshAgentHandle,
    private readonly sessions: DshSessions,
    private readonly closure: DshPublicClosure,
    private readonly dispositions: NativeTurnEvent[],
  ) {
    this.opaqueIdentity = handle.agent.id;
  }

  async run(input: unknown): Promise<readonly NativeTurnEvent[]> {
    const firstSequence = this.handle.agent.session.seq;
    this.dispositions.splice(0);
    this.handle.agent.followup(this.closure.createUserMessage({
      content: outputText(input),
      source: { kind: "user" },
    }));
    await this.handle.agent.whenIdle();
    const output: NativeTurnEvent[] = [];
    for (const event of this.handle.agent.session.events) {
      if (event.seq < firstSequence || event.type !== "assistant/message") continue;
      const message = event.data?.message as { content?: unknown } | undefined;
      if (message?.content !== undefined) output.push({ kind: "output", content: message.content as never });
    }
    output.push(...this.dispositions);
    if (this.dispositions.length === 0) output.push({ kind: "turn-ended" });
    return output;
  }

  async persist(): Promise<void> {
    await this.sessions.flush(this.handle.agent.session);
  }

  async cancel(): Promise<void> {
    this.handle.agent.cancel({ kind: "user" });
    await this.handle.agent.whenIdle();
  }

  async dispose(): Promise<void> {
    await this.handle.dispose();
  }
}

export async function createDshNativeSessionFactory(options: DshNativeSessionFactoryOptions): Promise<NativeProviderSessionFactory> {
  if (!options.workspaceDirectory.startsWith("/")) throw new TypeError("DSH workspace directory must be absolute");
  const closure = await resolveDshPublicClosure();
  const operationAuthority = createDshOperationAuthority(closure, options.workspaceDirectory);
  return Object.freeze({
    async open(request: NativeSessionOpenRequest): Promise<NativeProviderSession> {
      if (request.credentials.apiKey === undefined || request.credentials.apiKey === "") throw new TypeError("DSH credential is unavailable");
      const instructions = await admittedInstructions(options, request.dispatch);
      const dispositions: NativeTurnEvent[] = [];
      const handle = await options.agents.create({
        sessionId: closure.SessionId(`session-${randomUUID()}`),
        meta: { cwd: options.workspaceDirectory },
        agentOptions: exactAgentOptions(request.dispatch),
        signal: request.signal,
        setup: dispositionSetup(closure, request.dispatch, instructions, request.credentials, operationAuthority, dispositions),
      });
      return new DshNativeProviderSession(handle, options.sessions, closure, dispositions);
    },

    async restore(request: NativeSessionRestoreRequest): Promise<NativeProviderSession> {
      if (request.credentials.apiKey === undefined || request.credentials.apiKey === "") throw new TypeError("DSH credential is unavailable");
      const instructions = await admittedInstructions(options, request.dispatch);
      const dispositions: NativeTurnEvent[] = [];
      const handle = await options.agents.resume({
        resumeSessionId: closure.SessionId(request.opaqueIdentity),
        agentOptions: exactAgentOptions(request.dispatch),
        signal: request.signal,
        setup: dispositionSetup(closure, request.dispatch, instructions, request.credentials, operationAuthority, dispositions),
      });
      if (handle.agent.id !== request.opaqueIdentity) {
        await handle.dispose();
        throw new TypeError("DSH resumed a different native session identity");
      }
      return new DshNativeProviderSession(handle, options.sessions, closure, dispositions);
    },
  });
}

export interface DshCredentialResolver {
  resolve(reference: string): Promise<{ readonly value: string; readonly source: string } | undefined>;
}

export class DshCredentialLeaseBroker implements CredentialLeaseBroker {
  constructor(private readonly credentials: DshCredentialResolver) {}

  async acquire(dispatch: InvocationDispatch): Promise<CredentialLease> {
    const reference = configuration(dispatch).credentialRef;
    if (typeof reference !== "string" || reference === "") throw new TypeError("DSH credentialRef is not admitted");
    const resolved = await this.credentials.resolve(reference);
    if (resolved === undefined || resolved.value === "") throw new TypeError("DSH credential is unavailable");
    const material: { apiKey: string } = { apiKey: resolved.value };
    let released = false;
    return {
      material,
      async release() {
        if (released) return;
        released = true;
        material.apiKey = "";
      },
    };
  }
}
