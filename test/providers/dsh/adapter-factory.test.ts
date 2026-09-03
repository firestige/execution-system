import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DshProviderAdapterFactory } from "../../../src/providers/dsh/index.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dispatch(instructionsPath: string, baseURL?: string) {
  const instructions = "complete with the structured completion tool";
  return {
    instructions,
    value: {
      workspace: { kind: "none" },
      executor: {
        session: {
          agent: {
            resourceIdentity: "role.test",
            localReadOnlyPath: instructionsPath,
            contentIdentity: `sha256:${createHash("sha256").update(instructions).digest("hex")}`,
          },
          skills: [],
          tools: [],
          providedCapabilities: ["structured-completion"],
          instructions: {
            resourceIdentity: "role.test",
            localReadOnlyPath: instructionsPath,
            contentIdentity: `sha256:${createHash("sha256").update(instructions).digest("hex")}`,
          },
          model: { providerModelIdentity: "deepseek-chat" },
          driver: {
            providerIdentity: "dsh-headless",
            configuration: {
              providerRoute: "deepseek",
              credentialRef: "EXACT_FACTORY_KEY",
              ...(baseURL === undefined ? {} : { baseURL }),
            },
          },
        },
      },
    } as never,
  };
}

describe("DSH Provider Adapter Factory", () => {
  it("creates the native adapter from exact config without preconstructed agents or sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-adapter-factory-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    await mkdir(workspaceDirectory);
    const factory = new DshProviderAdapterFactory();

    const adapter = await factory.create({
      providerIdentity: "dsh-headless",
      workspaceDirectory,
      sessionStorageDirectory: join(root, "sessions"),
      credentialStore: { path: join(root, "credentials.yml"), watch: false },
      maxParallelToolCalls: 1,
    });

    expect(factory.key).toBe("dsh-headless");
    expect(adapter.key).toBe("dsh-headless");
    expect(adapter.sessions.open).toBeTypeOf("function");
    expect(adapter.sessions.restore).toBeTypeOf("function");
    expect(adapter.credentials.acquire).toBeTypeOf("function");
    await adapter.dispose();
    await adapter.dispose();
  });

  it("rejects an inexact selection and propagates exact startup failure without fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-adapter-factory-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    await mkdir(workspaceDirectory);
    const factory = new DshProviderAdapterFactory();
    const base = {
      providerIdentity: "dsh-headless" as const,
      workspaceDirectory,
      sessionStorageDirectory: join(root, "sessions"),
      credentialStore: { path: join(root, "credentials.yml"), watch: false as const },
      maxParallelToolCalls: 1,
    };

    await expect(factory.create({ ...base, providerIdentity: "copilot-sdk" } as never)).rejects.toMatchObject({ code: "PROVIDER_FACTORY_SELECTION_MISMATCH" });
    await writeFile(base.credentialStore.path, "not: [valid", "utf8");
    await expect(factory.create(base)).rejects.toMatchObject({ code: "PROVIDER_ADAPTER_STARTUP_FAILED", provider: "dsh-headless" });
  });

  it("resolves credentials only from the exact configured file, never an ambient same-key override", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-adapter-factory-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const credentialPath = join(root, "credentials.yml");
    await mkdir(workspaceDirectory);
    await writeFile(credentialPath, "version: 1\nrefs:\n  EXACT_FACTORY_KEY: configured-file-secret\n", "utf8");
    await chmod(credentialPath, 0o600);
    const previous = process.env.EXACT_FACTORY_KEY;
    const previousAmbientOnly = process.env.AMBIENT_ONLY_FACTORY_KEY;
    process.env.EXACT_FACTORY_KEY = "ambient-secret";
    process.env.AMBIENT_ONLY_FACTORY_KEY = "ambient-only-secret";
    try {
      const adapter = await new DshProviderAdapterFactory().create({
        providerIdentity: "dsh-headless",
        workspaceDirectory,
        sessionStorageDirectory: join(root, "sessions"),
        credentialStore: { path: credentialPath, watch: false },
        maxParallelToolCalls: 1,
      });
      const lease = await adapter.credentials.acquire({
        executor: { session: { driver: { configuration: { credentialRef: "EXACT_FACTORY_KEY" } } } },
      } as never);
      expect(lease.material).toEqual({ apiKey: "configured-file-secret" });
      await lease.release();
      await expect(adapter.credentials.acquire({
        executor: { session: { driver: { configuration: { credentialRef: "AMBIENT_ONLY_FACTORY_KEY" } } } },
      } as never)).rejects.toThrow("credential is unavailable");
      await adapter.dispose();
    } finally {
      if (previous === undefined) delete process.env.EXACT_FACTORY_KEY;
      else process.env.EXACT_FACTORY_KEY = previous;
      if (previousAmbientOnly === undefined) delete process.env.AMBIENT_ONLY_FACTORY_KEY;
      else process.env.AMBIENT_ONLY_FACTORY_KEY = previousAmbientOnly;
    }
  });

  it("creates a real rc.2 session that completes, persists, and restores the exact opaque identity", async () => {
    const observedAuthorization: string[] = [];
    const server = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        'data: {"id":"completion-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"workflow_complete","arguments":"{\\"result\\":{\\"accepted\\":true}}"}}]},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("test server did not bind");

    const root = await mkdtemp(join(tmpdir(), "dsh-adapter-factory-real-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const credentialPath = join(root, "credentials.yml");
    const instructionsPath = join(root, "instructions.md");
    await mkdir(workspaceDirectory);
    await writeFile(credentialPath, "version: 1\nrefs:\n  EXACT_FACTORY_KEY: configured-file-secret\n", "utf8");
    await chmod(credentialPath, 0o600);
    const fixture = dispatch(instructionsPath, `http://127.0.0.1:${address.port}`);
    await writeFile(instructionsPath, fixture.instructions, "utf8");
    const previous = process.env.EXACT_FACTORY_KEY;
    process.env.EXACT_FACTORY_KEY = "ambient-secret";
    try {
      const adapter = await new DshProviderAdapterFactory().create({
        providerIdentity: "dsh-headless",
        workspaceDirectory,
        sessionStorageDirectory: join(root, "sessions"),
        credentialStore: { path: credentialPath, watch: false },
        maxParallelToolCalls: 1,
      });
      const lease = await adapter.credentials.acquire(fixture.value);
      const request = { dispatch: fixture.value, credentials: lease.material, signal: new AbortController().signal };
      const session = await adapter.sessions.open(request);
      const opaqueIdentity = session.opaqueIdentity;
      expect(await session.run({ task: "complete" })).toContainEqual({ kind: "structured-completion", result: { accepted: true } });
      await session.persist();
      await session.dispose();
      const restored = await adapter.sessions.restore({ ...request, opaqueIdentity });
      expect(restored.opaqueIdentity).toBe(opaqueIdentity);
      expect(observedAuthorization).toEqual(["Bearer configured-file-secret"]);
      await restored.dispose();
      await lease.release();
      await adapter.dispose();
    } finally {
      if (previous === undefined) delete process.env.EXACT_FACTORY_KEY;
      else process.env.EXACT_FACTORY_KEY = previous;
    }
  });
});
