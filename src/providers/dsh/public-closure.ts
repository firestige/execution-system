import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface ConstructorWithPrototype {
  readonly prototype: Record<string, unknown>;
}

interface ContextConstructor extends ConstructorWithPrototype {
  new (): DshContext;
}

interface DshContext {
  get(name: string): unknown;
  plugin(plugin: ConstructorWithPrototype, config?: Record<string, unknown>): PromiseLike<unknown>;
  readonly fiber: { dispose(): Promise<void> };
}

export interface DshPublicClosure {
  readonly version: string;
  readonly AgentRegistry: ConstructorWithPrototype;
  readonly SessionStore: ConstructorWithPrototype;
  readonly CredentialProvider: ConstructorWithPrototype;
  readonly LocalCredentialProvider: ConstructorWithPrototype;
  readonly createUserMessage: (...args: readonly unknown[]) => unknown;
  readonly defineTool: (options: Record<string, unknown>) => unknown;
  readonly SessionId: (value: string) => unknown;
  readonly installModelSelection: (context: unknown, selection: Record<string, unknown>) => unknown;
  readonly DeepSeekAdapter: new (options: Record<string, unknown>) => { stream(options: unknown): AsyncIterable<unknown> };
  readonly resolveDeepSeekAdapterOptions: (config: Record<string, unknown>) => Record<string, unknown>;
  readonly Context: ContextConstructor;
  readonly LlmRuntime: new (context: unknown, config?: Record<string, unknown>) => unknown;
  readonly ToolRuntime: new (context: unknown, config?: Record<string, unknown>) => unknown;
  readonly SystemPrompt: new (context: unknown, config?: Record<string, unknown>) => unknown;
  readonly AgentLoop: ConstructorWithPrototype;
  readonly JsonlSessionPersistence: ConstructorWithPrototype;
  readonly parseCredentialsDocument: (text: string, filename: string) => Readonly<{
    refs: ReadonlyMap<string, string>;
  }>;
}

async function publicModule(anchor: NodeRequire, specifier: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(anchor.resolve(specifier)).href) as Record<string, unknown>;
}

function constructor(module: Record<string, unknown>, name: string): ConstructorWithPrototype {
  const value = module[name];
  if (typeof value !== "function") throw new TypeError(`DSH public closure is missing ${name}`);
  return value as unknown as ConstructorWithPrototype;
}

export async function resolveDshPublicClosure(): Promise<DshPublicClosure> {
  const localRequire = createRequire(import.meta.url);
  const manifestPath = localRequire.resolve("@deepseek-ai/dsh/package.json");
  const dshRequire = createRequire(manifestPath);
  const manifest = dshRequire(manifestPath) as { version?: unknown };
  if (manifest.version !== "0.1.1-rc.2") throw new TypeError("unsupported @deepseek-ai/dsh version");
  const [agent, session, credentials, localCredentials, llm, tools, deepseek, cordis, systemPrompt, agentLoop, persistence] = await Promise.all([
    publicModule(dshRequire, "@deepseek-ai/dsh-agent"),
    publicModule(dshRequire, "@deepseek-ai/dsh-session"),
    publicModule(dshRequire, "@deepseek-ai/dsh-credentials"),
    publicModule(dshRequire, "@deepseek-ai/dsh-credentials-local"),
    publicModule(dshRequire, "@deepseek-ai/dsh-llm"),
    publicModule(dshRequire, "@deepseek-ai/dsh-tools"),
    publicModule(dshRequire, "@deepseek-ai/dsh-llm-deepseek"),
    publicModule(dshRequire, "@deepseek-ai/cordis"),
    publicModule(dshRequire, "@deepseek-ai/dsh-system-prompt"),
    publicModule(dshRequire, "@deepseek-ai/dsh-agent-loop"),
    publicModule(dshRequire, "@deepseek-ai/dsh-session-persistence-jsonl"),
  ]);
  const createUserMessage = llm.createUserMessage;
  if (typeof createUserMessage !== "function") throw new TypeError("DSH public closure is missing createUserMessage");
  if (typeof tools.defineTool !== "function") throw new TypeError("DSH public closure is missing defineTool");
  if (typeof session.SessionId !== "function") throw new TypeError("DSH public closure is missing SessionId");
  if (typeof agent.installModelSelection !== "function") throw new TypeError("DSH public closure is missing installModelSelection");
  if (typeof deepseek.DeepSeekAdapter !== "function" || typeof deepseek.resolveAdapterOptions !== "function") {
    throw new TypeError("DSH public closure is missing the DeepSeek operation adapter");
  }
  if (typeof localCredentials.parseCredentialsDocument !== "function") {
    throw new TypeError("DSH public closure is missing the configured credential document parser");
  }
  return Object.freeze({
    version: manifest.version,
    AgentRegistry: constructor(agent, "AgentRegistry"),
    SessionStore: constructor(session, "SessionStore"),
    CredentialProvider: constructor(credentials, "CredentialProvider"),
    LocalCredentialProvider: constructor(localCredentials, "LocalCredentialProvider"),
    createUserMessage: createUserMessage as (...args: readonly unknown[]) => unknown,
    defineTool: tools.defineTool as (options: Record<string, unknown>) => unknown,
    SessionId: session.SessionId as (value: string) => unknown,
    installModelSelection: agent.installModelSelection as (context: unknown, selection: Record<string, unknown>) => unknown,
    DeepSeekAdapter: deepseek.DeepSeekAdapter as DshPublicClosure["DeepSeekAdapter"],
    resolveDeepSeekAdapterOptions: deepseek.resolveAdapterOptions as DshPublicClosure["resolveDeepSeekAdapterOptions"],
    Context: constructor(cordis, "Context") as ContextConstructor,
    LlmRuntime: constructor(llm, "LlmRuntime") as DshPublicClosure["LlmRuntime"],
    ToolRuntime: constructor(tools, "ToolRuntime") as DshPublicClosure["ToolRuntime"],
    SystemPrompt: constructor(systemPrompt, "SystemPrompt") as DshPublicClosure["SystemPrompt"],
    AgentLoop: constructor(agentLoop, "AgentLoop"),
    JsonlSessionPersistence: constructor(persistence, "JsonlSessionPersistence"),
    parseCredentialsDocument: localCredentials.parseCredentialsDocument as DshPublicClosure["parseCredentialsDocument"],
  });
}
