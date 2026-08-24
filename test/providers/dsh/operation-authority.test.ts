import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDshOperationAuthority, resolveDshPublicClosure } from "../../../src/providers/dsh/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

describe("production DSH operation authority", () => {
  it("uses only the acquired bearer credential and denies out-of-scope filesystem access", async () => {
    const observedAuthorization: string[] = [];
    const server = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("test server did not bind");

    const workspace = await mkdtemp(join(tmpdir(), "dsh-authority-"));
    cleanups.push(async () => { await rm(workspace, { recursive: true, force: true }); });
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "allowed.txt"), "inside", "utf8");
    await writeFile(join(workspace, "outside.txt"), "outside", "utf8");

    const closure = await resolveDshPublicClosure();
    const context = new closure.Context();
    new closure.SystemPrompt(context, {});
    new closure.LlmRuntime(context);
    new closure.ToolRuntime(context, {});
    const authority = createDshOperationAuthority(closure, workspace);
    await authority.install(context, {
      provider: "deepseek",
      model: "deepseek-chat",
      baseURL: `http://127.0.0.1:${address.port}`,
      credential: { reference: "EXACT_KEY", value: "operation-secret" },
      workspace: { kind: "write" } as never,
      access: [{ mode: "read", path: "**" }, { mode: "write", path: "**" }] as never,
      tools: [{ name: "admitted-fs", workspaceAccess: true }],
    });

    const llm = context.get("llm") as { stream(options: Record<string, unknown>): AsyncIterable<unknown> };
    const chunks: unknown[] = [];
    for await (const chunk of llm.stream({ provider: "deepseek", model: "deepseek-chat", messages: [] })) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    expect(observedAuthorization).toEqual(["Bearer operation-secret"]);
    await expect(async () => { for await (const _chunk of llm.stream({ provider: "ambient", model: "deepseek-chat", messages: [] })) { /* no-op */ } }).rejects.toThrow("provider/model");

    const tools = context.get("tools") as { get(name: string): { output: { render(args: unknown, value: unknown): unknown }; execute(args: unknown, exec: unknown): Promise<unknown> } | undefined };
    const tool = tools.get("admitted-fs")!;
    expect(tool.output.render({}, {})).toEqual([]);
    expect(await tool.execute({ operation: "list", path: "." }, {})).toEqual({ entries: [
      { name: "outside.txt", kind: "file" }, { name: "src", kind: "directory" },
    ] });
    expect(await tool.execute({ operation: "read", path: "src/allowed.txt" }, {})).toEqual({ content: "inside" });
    await tool.execute({ operation: "write", path: "src/allowed.txt", content: "changed" }, {});
    expect(await readFile(join(workspace, "src", "allowed.txt"), "utf8")).toBe("changed");
    await tool.execute({ operation: "write", path: "created.txt", content: "created" }, {});
    expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe("created");
    expect(await tool.execute({ operation: "read", path: "outside.txt" }, {})).toEqual({ content: "outside" });
    await expect(tool.execute({ operation: "write", path: "src/allowed.txt" }, {})).rejects.toThrow("requires content");
    await expect(tool.execute({ operation: "read", path: "../outside.txt" }, {})).rejects.toThrow("relative admitted path");
    const external = await mkdtemp(join(tmpdir(), "dsh-external-"));
    cleanups.push(async () => { await rm(external, { recursive: true, force: true }); });
    await writeFile(join(external, "secret.txt"), "secret", "utf8");
    await symlink(external, join(workspace, "src", "escape"));
    await expect(tool.execute({ operation: "read", path: "src/escape/secret.txt" }, {})).rejects.toThrow("escapes");
    await symlink(join(external, "secret.txt"), join(workspace, "src", "write-escape.txt"));
    await expect(tool.execute({ operation: "write", path: "src/write-escape.txt", content: "leak" }, {})).rejects.toThrow("escapes");
    expect(await readFile(join(external, "secret.txt"), "utf8")).toBe("secret");
    expect(await readFile(join(workspace, "outside.txt"), "utf8")).toBe("outside");

    const readContext = new closure.Context();
    new closure.SystemPrompt(readContext, {});
    new closure.LlmRuntime(readContext);
    new closure.ToolRuntime(readContext, {});
    await authority.install(readContext, {
      provider: "deepseek", model: "deepseek-chat", baseURL: `http://127.0.0.1:${address.port}`,
      credential: { reference: "EXACT_KEY", value: "operation-secret" }, workspace: { kind: "read" } as never,
      access: [{ mode: "read", path: "src/**" }] as never,
      tools: [{ name: "read-root", workspaceAccess: true }],
    });
    const readTool = (readContext.get("tools") as typeof tools).get("read-root")!;
    expect(await readTool.execute({ operation: "list", path: "src" }, {})).toEqual({ entries: [
      { name: "allowed.txt", kind: "file" }, { name: "escape", kind: "symlink" }, { name: "write-escape.txt", kind: "symlink" },
    ] });
    await expect(readTool.execute({ operation: "write", path: "new.txt", content: "denied" }, {})).rejects.toThrow("outside signed access");
    await expect(readTool.execute({ operation: "read", path: "outside.txt" }, {})).rejects.toThrow("outside signed access");
    await expect(readTool.execute({ operation: "read", path: join(external, "secret.txt") }, {})).rejects.toThrow("relative admitted path");

    await expect(authority.install({}, { provider: "deepseek", model: "m", credential: { reference: "K", value: "v" }, workspace: { kind: "none" } as never, access: [] as never, tools: [] })).rejects.toThrow("context");
    await expect(authority.install(context, { provider: "unsupported", model: "m", credential: { reference: "K", value: "v" }, workspace: { kind: "none" } as never, access: [] as never, tools: [] })).rejects.toThrow("provider route");
    await expect(authority.install(context, { provider: "deepseek", model: "m", credential: { reference: "K", value: "v" }, workspace: { kind: "none" } as never, access: [] as never, tools: [{ name: "ambient", workspaceAccess: false }] })).rejects.toThrow("ambient tool");
  });
});
