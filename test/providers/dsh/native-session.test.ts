import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDshNativeSessionFactory, DshCredentialLeaseBroker } from "../../../src/providers/dsh/index.js";

function nativeAgent(id: string) {
  return {
    id,
    session: { seq: 0, events: [] as Array<{ seq: number; type: string; data?: Record<string, unknown> }> },
    followups: [] as unknown[],
    cancellations: [] as unknown[],
    followup(message: unknown) { this.followups.push(message); },
    async whenIdle() {},
    cancel(cause: { readonly kind: "user" }) { this.cancellations.push(cause); },
  };
}

const instructionIdentity = `sha256:${createHash("sha256").update("exact instructions").digest("hex")}`;
const sessionBinding = { tools: [], instructions: { localReadOnlyPath: "/admitted/instructions.md", contentIdentity: instructionIdentity }, model: { providerModelIdentity: "deepseek-chat" }, driver: { configuration: { providerRoute: "deepseek" } } };

describe("DSH native session adapter", () => {
  it("uses AgentRegistry.resume with the exact opaque session id and has no create fallback", async () => {
    const created = nativeAgent("native-created");
    const resumed = nativeAgent("native-session-exact");
    const calls = { create: 0, resume: [] as string[], flush: [] as string[] };
    const factory = await createDshNativeSessionFactory({
      agents: {
        async create() { calls.create += 1; return { agent: created, async dispose() {} }; },
        async resume(options: { resumeSessionId: string }) {
          calls.resume.push(options.resumeSessionId);
          return { agent: resumed, async dispose() {} };
        },
      },
      sessions: { async flush(session: unknown) { calls.flush.push((session as { id?: string }).id ?? "flushed"); } },
      workspaceDirectory: "/admitted/worktree",
      readProjection: async () => "exact instructions",
    });

    const session = await factory.restore({
      opaqueIdentity: "native-session-exact",
      dispatch: { workspace: { kind: "none" }, executor: { session: sessionBinding } } as never,
      credentials: { apiKey: "secret" },
      signal: new AbortController().signal,
    });

    expect(session.opaqueIdentity).toBe("native-session-exact");
    expect(calls.resume).toEqual(["native-session-exact"]);
    expect(calls.create).toBe(0);
    await session.persist();
    await session.cancel();
    await session.dispose();
    expect(resumed.cancellations).toEqual([{ kind: "user" }]);
    expect(calls.flush).toEqual(["flushed"]);
  });

  it("maps only registered structured disposition tools to completion or awaiting input", async () => {
    const agent = nativeAgent("native-created");
    let setup: ((context: unknown) => unknown) | undefined;
    const definitions: Array<{ name: string; output: { render(args: unknown, value: unknown): unknown }; execute(args: unknown, exec: { concludeTurn(): void }): Promise<unknown> }> = [];
    const restrictions: unknown[] = [];
    const sections: unknown[] = [];
    const factory = await createDshNativeSessionFactory({
      agents: {
        async create(options: { setup?: (context: unknown) => unknown }) {
          setup = options.setup;
          await setup?.({ on: () => () => undefined, get: (name: string) => name === "systemPrompt" ? { section(value: unknown) { sections.push(value); return () => undefined; } } : { schemas: () => [{ name: "ambient-bash" }], restrict(filter: unknown) { restrictions.push(filter); return () => undefined; }, register(definition: typeof definitions[number]) { definitions.push(definition); return () => undefined; } } });
          return { agent, async dispose() {} };
        },
        async resume() { throw new Error("not used"); },
      },
      sessions: { async flush() {} },
      workspaceDirectory: "/admitted/worktree",
      readProjection: async () => "exact instructions",
    });
    const session = await factory.open({
      dispatch: { workspace: { kind: "none" }, executor: { session: sessionBinding } } as never,
      credentials: { apiKey: "secret" },
      signal: new AbortController().signal,
    });
    const completion = definitions.find((definition) => definition.name === "workflow_complete");
    expect(completion).toBeDefined();
    expect(restrictions).toEqual([{ deny: ["ambient-bash"] }]);
    expect(sections).toEqual([{ name: "workflow:admitted-instructions", order: 10, text: "exact instructions" }]);
    expect(completion!.output.render({}, {})).toEqual([{ type: "text", text: "structured completion accepted" }]);
    let concluded = false;
    agent.whenIdle = async () => {
      await completion!.execute({ result: { accepted: true } }, { concludeTurn() { concluded = true; } });
    };

    const events = await session.run({ task: "work" });

    expect(events).toEqual([{ kind: "structured-completion", result: { accepted: true } }]);
    expect(concluded).toBe(true);
    expect(agent.followups).toHaveLength(1);

    const requestInput = definitions.find((definition) => definition.name === "workflow_request_input")!;
    expect(requestInput.output.render({}, {})).toEqual([{ type: "text", text: "input request persisted" }]);
    agent.whenIdle = async () => {
      await requestInput.execute({ requestIdentity: "request-1", prompt: "?", responseSchema: { type: "boolean" } }, { concludeTurn() {} });
    };
    expect(await session.run("answer")).toEqual([{ kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: { type: "boolean" } }]);
  });

  it("forwards assistant frames but maps idle turn-end only to a non-completion event", async () => {
    const agent = nativeAgent("native-created");
    agent.session.events.push(
      { seq: -1, type: "assistant/message", data: { message: { content: "old" } } },
      { seq: 0, type: "other" },
      { seq: 1, type: "assistant/message", data: {} },
      { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "frame" }] } } },
    );
    const factory = await createDshNativeSessionFactory({
      agents: {
        async create(options: { setup?: (context: unknown) => unknown }) {
          await options.setup?.({ on: () => () => undefined, get: (name: string) => name === "systemPrompt" ? { section() { return () => undefined; } } : { schemas: () => [], restrict: () => () => undefined, register() { return () => undefined; } } });
          return { agent, async dispose() {} };
        },
        async resume() { throw new Error("not used"); },
      },
      sessions: { async flush() {} },
      workspaceDirectory: "/admitted/worktree",
      readProjection: async () => "exact instructions",
    });
    const session = await factory.open({
      dispatch: { workspace: { kind: "none" }, executor: { session: sessionBinding } } as never,
      credentials: { apiKey: "secret" },
      signal: new AbortController().signal,
    });

    expect(await session.run({ task: "work" })).toEqual([
      { kind: "output", content: [{ type: "text", text: "frame" }] },
      { kind: "turn-ended" },
    ]);
  });

  it("fails closed for missing composition, credential, provider binding, or exact resume identity", async () => {
    await expect(createDshNativeSessionFactory({ agents: {} as never, sessions: {} as never, workspaceDirectory: "relative" })).rejects.toThrow("absolute");
    const agent = nativeAgent("different-native-id");
    let disposed = 0;
    const factory = await createDshNativeSessionFactory({
      agents: {
        async create(options: { setup?: (context: unknown) => unknown }) {
          await options.setup?.({ on: () => () => undefined, get: (name: string) => name === "systemPrompt" ? { section() { return () => undefined; } } : undefined });
          return { agent, async dispose() { disposed += 1; } };
        },
        async resume() { return { agent, async dispose() { disposed += 1; } }; },
      },
      sessions: { async flush() {} },
      workspaceDirectory: "/admitted/worktree",
      readProjection: async () => "exact instructions",
    });
    const request = {
      dispatch: { workspace: { kind: "none" }, executor: { session: sessionBinding } } as never,
      credentials: { apiKey: "secret" },
      signal: new AbortController().signal,
    };
    await expect(factory.restore({ ...request, opaqueIdentity: "expected-native-id" })).rejects.toThrow("different native session");
    expect(disposed).toBe(1);
    await expect(factory.open({ ...request, credentials: {} })).rejects.toThrow("credential");
    await expect(factory.restore({ ...request, opaqueIdentity: "id", credentials: { apiKey: "" } })).rejects.toThrow("credential");
    await expect(factory.open({ ...request, dispatch: { workspace: { kind: "none" }, executor: { session: { ...sessionBinding, driver: { configuration: {} } } } } as never })).rejects.toThrow("providerRoute");
    await expect(factory.open(request)).rejects.toThrow("structured tool runtime");
  });

  it("restricts ambient DSH tools to the exact admitted projection and rejects inexact or unauthorized workspace tools", async () => {
    const agent = nativeAgent("native-created");
    const restrictions: unknown[] = [];
    const factory = await createDshNativeSessionFactory({
      agents: {
        async create(options: { setup?: (context: unknown) => unknown }) {
          await options.setup?.({
            on: () => () => undefined,
            get: (name: string) => name === "systemPrompt" ? { section() { return () => undefined; } } : ({
              schemas: () => [{ name: "admitted-fs" }, { name: "ambient-bash" }],
              restrict(filter: unknown) { restrictions.push(filter); return () => undefined; },
              register() { return () => undefined; },
            }),
          });
          return { agent, async dispose() {} };
        },
        async resume() { throw new Error("not used"); },
      },
      sessions: { async flush() {} },
      workspaceDirectory: "/admitted/worktree",
      readProjection: async () => "exact instructions",
    });
    const base = {
      workspace: { kind: "write" },
      executor: { session: { ...sessionBinding, tools: [{ configuration: { toolName: "admitted-fs", workspaceAccess: true } }] } },
    };
    await factory.open({ dispatch: base as never, credentials: { apiKey: "secret" }, signal: new AbortController().signal });
    expect(restrictions).toEqual([{ allow: ["admitted-fs"] }]);

    await expect(factory.open({ dispatch: { ...base, executor: { session: { ...base.executor.session, tools: [{ configuration: {} }] } } } as never, credentials: { apiKey: "secret" }, signal: new AbortController().signal })).rejects.toThrow("tool binding");
    await expect(factory.open({ dispatch: { ...base, workspace: { kind: "none" } } as never, credentials: { apiKey: "secret" }, signal: new AbortController().signal })).rejects.toThrow("authorized workspace");
  });

  it("acquires the exact configured credential for each turn and releases its lease", async () => {
    const resolved: string[] = [];
    const broker = new DshCredentialLeaseBroker({
      async resolve(reference: string) {
        resolved.push(reference);
        return { value: "top-secret", source: "file" };
      },
    });
    const dispatch = { executor: { session: { driver: { configuration: { credentialRef: "DEEPSEEK_API_KEY" } } } } } as never;

    const first = await broker.acquire(dispatch);
    await first.release();
    const second = await broker.acquire(dispatch);

    expect(first.material).toEqual({ apiKey: "" });
    expect(second.material).toEqual({ apiKey: "top-secret" });
    expect(resolved).toEqual(["DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"]);
    await first.release();
    await expect(new DshCredentialLeaseBroker({ async resolve() { return undefined; } }).acquire(dispatch)).rejects.toThrow("unavailable");
    await expect(new DshCredentialLeaseBroker({ async resolve() { return { value: "", source: "file" }; } }).acquire(dispatch)).rejects.toThrow("unavailable");
    await expect(broker.acquire({ executor: { session: { driver: { configuration: {} } } } } as never)).rejects.toThrow("credentialRef");
  });
});
