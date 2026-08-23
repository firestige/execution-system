import { realpath, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { InvocationDispatch } from "../../contracts/index.js";
import type { DshPublicClosure } from "./public-closure.js";

interface AuthorityContext {
  on(name: "llm/stream", listener: (options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>): () => void;
  get(name: "tools"): { register(definition: unknown): () => void } | undefined;
}

export interface DshOperationGrant {
  readonly provider: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly credential: Readonly<{ reference: string; value: string }>;
  readonly workspace: InvocationDispatch["workspace"];
  readonly access: InvocationDispatch["executor"]["turn"]["access"];
  readonly tools: readonly Readonly<{ name: string; workspaceAccess: boolean }>[];
}

export interface DshOperationAuthority {
  install(context: unknown, grant: DshOperationGrant): Promise<Readonly<{ authorizedToolNames: readonly string[] }>>;
}

function matches(pattern: string, candidate: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3).replace(/\/$/, "");
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  return candidate === pattern;
}

async function scopedPath(root: string, requested: unknown, mode: "read" | "write", grant: DshOperationGrant): Promise<string> {
  if (typeof requested !== "string" || requested === "" || isAbsolute(requested) || requested.split(/[\\/]/).includes("..")) {
    throw new TypeError("DSH workspace path is not a relative admitted path");
  }
  const normalized = requested.replaceAll("\\", "/").replace(/^\.\//, "");
  const permitted = grant.access.some((rule) => (mode === "read" ? rule.mode === "read" || rule.mode === "write" : rule.mode === "write") && matches(rule.path, normalized));
  if (!permitted) throw new TypeError("DSH workspace operation is outside signed access");
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, normalized);
  const existingAnchor = mode === "read"
    ? await realpath(target)
    : await realpath(target).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return await realpath(dirname(target));
      });
  const displacement = relative(canonicalRoot, existingAnchor);
  if (displacement === ".." || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) {
    throw new TypeError("DSH workspace operation escapes the admitted worktree");
  }
  return target;
}

export function createDshOperationAuthority(closure: DshPublicClosure, workspaceDirectory: string): DshOperationAuthority {
  return Object.freeze({
    async install(rawContext: unknown, grant: DshOperationGrant) {
      const context = rawContext as AuthorityContext;
      if (typeof context.on !== "function") throw new TypeError("DSH scoped LLM authority context is unavailable");
      if (grant.provider !== "deepseek" && grant.provider !== "deepseek-official") throw new TypeError("DSH provider route is not supported by the exact credential authority");
      const connection = closure.resolveDeepSeekAdapterOptions({ apiKeyEnv: grant.credential.reference, ...(grant.baseURL === undefined ? {} : { baseURL: grant.baseURL }) });
      const adapter = new closure.DeepSeekAdapter({
        options: () => connection,
        resolveApiKey: async () => grant.credential.value,
        resolveUserId: () => "00000000-0000-4000-8000-000000000000",
      });
      context.on("llm/stream", (options) => {
        if (options.provider !== grant.provider || options.model !== grant.model) {
          throw new TypeError("DSH LLM request does not match the admitted provider/model");
        }
        return adapter.stream(options);
      });

      const tools = context.get("tools");
      if (tools === undefined || typeof tools.register !== "function") throw new TypeError("DSH scoped tool authority is unavailable");
      const authorizedToolNames: string[] = [];
      for (const tool of grant.tools) {
        if (!tool.workspaceAccess || grant.workspace.kind === "none") throw new TypeError("DSH cannot authorize an ambient tool implementation");
        const definition = closure.defineTool({
          name: tool.name,
          description: "Read or write a path inside the signed workflow workspace scope.",
          parameters: {
            operation: { type: "string", enum: ["read", "write"], required: true },
            path: { type: "string", required: true },
            content: { type: "string" },
          },
          output: { schema: { type: "object", additionalProperties: true }, render: () => [] },
          async execute(args: { operation: "read" | "write"; path: string; content?: string }) {
            if (args.operation === "read") return { content: await readFile(await scopedPath(workspaceDirectory, args.path, "read", grant), "utf8") };
            if (args.operation !== "write" || typeof args.content !== "string") throw new TypeError("DSH workspace write requires content");
            await writeFile(await scopedPath(workspaceDirectory, args.path, "write", grant), args.content, "utf8");
            return { written: true };
          },
        });
        tools.register(definition);
        authorizedToolNames.push(tool.name);
      }
      return Object.freeze({ authorizedToolNames: Object.freeze(authorizedToolNames) });
    },
  });
}
