import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActionOutputSink,
  InvocationDispatch,
  RetirementAuthorizationRef,
} from "../../src/contracts/index.js";
import {
  FileInvocationJournalStore,
  createManagedInvocation,
  type CredentialLease,
  type CredentialLeaseBroker,
  type NativeProviderSession,
  type NativeProviderSessionFactory,
  type NativeTurnEvent,
} from "../../src/invocation/index.js";
import { createCopilotProviderShell } from "../../src/providers/copilot/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function delivery() {
  return {
    deliveryIdentity: "delivery-1",
    manifestBindingIdentity: `sha256:${"a".repeat(64)}`,
    activationBindingIdentity: `sha256:${"b".repeat(64)}`,
  } as const;
}

function contentIdentity(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}` as const;
}

function episode() {
  return {
    thread: { delivery: delivery(), threadIdentity: "thread-1" },
    site: { kind: "node", nodeIdentity: "node-1" },
    invocationIdentity: "invocation-1",
    attemptIdentity: "attempt-1",
  } as const;
}

function dispatch(): InvocationDispatch {
  const sessionCompatibilityIdentity = `sha256:${"c".repeat(64)}` as const;
  const bindingIdentity = `sha256:${"d".repeat(64)}` as const;
  return {
    episode: episode() as InvocationDispatch["episode"],
    plan: {
      actionIdentity: "action-1",
      executorIdentity: "executor-1",
      bindingIdentity,
    } as InvocationDispatch["plan"],
    action: {
      identity: "action-1",
      purpose: "produce an admitted result",
      inputSchema: { type: "object" },
      resultSchema: {
        type: "object",
        properties: { accepted: { type: "boolean" } },
        required: ["accepted"],
        additionalProperties: false,
      },
      gate: { kind: "none" },
    } as unknown as InvocationDispatch["action"],
    executor: {
      identity: "executor-1",
      bindingIdentity,
      sessionCompatibilityIdentity,
      session: {
        roleIdentity: "role-1",
        routeIdentity: "route-1",
        agent: {
          resourceIdentity: "agent-resource-1",
          contentIdentity: `sha256:${"e".repeat(64)}`,
          projectionIdentity: `sha256:${"f".repeat(64)}`,
          localReadOnlyPath: "/admitted/agent.md",
        },
        model: {
          resourceIdentity: "model-resource-1",
          contentIdentity: `sha256:${"1".repeat(64)}`,
          projectionIdentity: `sha256:${"2".repeat(64)}`,
          providerModelIdentity: "deepseek-chat",
          configuration: {},
        },
        driver: {
          resourceIdentity: "driver-resource-1",
          projectionIdentity: `sha256:${"3".repeat(64)}`,
          providerIdentity: "dsh-headless",
          configuration: { credentialRef: "DEEPSEEK_API_KEY" },
        },
        instructions: {
          resourceIdentity: "instruction-resource-1",
          contentIdentity: `sha256:${"4".repeat(64)}`,
          localReadOnlyPath: "/admitted/instructions.md",
        },
        tools: [],
        providedCapabilities: ["structured-completion", "interaction"],
        policy: { identity: "session-policy-1", scope: { kind: "episode" }, isolation: "isolated" },
      },
      turn: { access: [{ mode: "write", path: "src/**" }] },
    } as unknown as InvocationDispatch["executor"],
    input: { task: "work" },
    workspace: {
      kind: "write",
      handle: {
        handleIdentity: "handle-1",
        episode: episode(),
        savepoint: { identity: "savepoint-1", delivery: delivery(), gitTree: "tree-1" },
        accessDigest: `sha256:${"5".repeat(64)}`,
      },
    } as unknown as InvocationDispatch["workspace"],
    session: {
      identity: "affinity-1",
      delivery: delivery(),
      sessionCompatibilityIdentity,
      scopeValueIdentity: `sha256:${"6".repeat(64)}`,
      isolation: "isolated",
    } as InvocationDispatch["session"],
  };
}

class LeaseBroker implements CredentialLeaseBroker {
  readonly released: string[] = [];
  readonly secret = "secret-do-not-journal";

  async acquire(): Promise<CredentialLease> {
    return {
      material: { apiKey: this.secret },
      release: async () => {
        this.released.push("released");
      },
    };
  }
}

class ScriptedSession implements NativeProviderSession {
  readonly opaqueIdentity = "native-session-1";
  readonly inputs: unknown[] = [];
  cancelCount = 0;
  disposeCount = 0;

  constructor(private readonly turns: readonly (readonly NativeTurnEvent[])[]) {}

  async run(input: unknown): Promise<readonly NativeTurnEvent[]> {
    this.inputs.push(input);
    return this.turns[this.inputs.length - 1] ?? [];
  }

  async persist(): Promise<void> {}

  async cancel(): Promise<void> {
    this.cancelCount += 1;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

class ScriptedFactory implements NativeProviderSessionFactory {
  openCount = 0;
  readonly restored: string[] = [];

  constructor(readonly session: ScriptedSession) {}

  async open(): Promise<NativeProviderSession> {
    this.openCount += 1;
    return this.session;
  }

  async restore(request: { readonly opaqueIdentity: string }): Promise<NativeProviderSession> {
    this.restored.push(request.opaqueIdentity);
    return this.session;
  }
}

function sink() {
  const frames: unknown[] = [];
  const value: ActionOutputSink = {
    async publish(frame) {
      frames.push(frame);
      return { ok: true, value: undefined };
    },
  };
  return { value, frames };
}

async function harness(turns: readonly (readonly NativeTurnEvent[])[]) {
  const directory = await mkdtemp(join(tmpdir(), "g03-journal-"));
  temporaryDirectories.push(directory);
  const provider = new ScriptedFactory(new ScriptedSession(turns));
  const credentials = new LeaseBroker();
  const journal = new FileInvocationJournalStore(directory);
  const manager = createManagedInvocation({
    providers: { "dsh-headless": provider },
    credentials,
    journal,
    validateResult: (schema, value) => {
      if ((schema as { type?: unknown }).type === "boolean") return typeof value === "boolean";
      if ((schema as { type?: unknown }).type === "string") return typeof value === "string";
      return typeof schema === "object" &&
        typeof value === "object" &&
        value !== null &&
        (value as { accepted?: unknown }).accepted === true;
    },
    authorizeRetirement: (authorization, activeDelivery) =>
      authorization.delivery.deliveryIdentity === activeDelivery.deliveryIdentity,
  });
  return { directory, provider, credentials, journal, manager };
}

describe("managed Invocation", () => {
  it("treats output and turn/end as frames and an invalid non-completion, never completed", async () => {
    const fixture = await harness([
      [
        { kind: "output", content: { text: "still working" } },
        { kind: "turn-ended" },
      ],
    ]);
    const output = sink();

    const result = await fixture.manager.host.start(dispatch(), output.value);

    expect(result).toMatchObject({ ok: true, value: { kind: "invalid", violation: { code: "TURN_ENDED_WITHOUT_DISPOSITION" } } });
    expect(output.frames).toHaveLength(1);
    expect(fixture.credentials.released).toEqual(["released"]);
  });

  it("accepts completion only from one structured completion and validates its schema", async () => {
    const fixture = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);

    const result = await fixture.manager.host.start(dispatch(), sink().value);

    expect(result).toMatchObject({ ok: true, value: { kind: "completed", result: { accepted: true } } });
  });

  it("rejects duplicate structured completion fail closed", async () => {
    const fixture = await harness([[
      { kind: "structured-completion", result: { accepted: true } },
      { kind: "structured-completion", result: { accepted: true } },
    ]]);

    const result = await fixture.manager.host.start(dispatch(), sink().value);

    expect(result).toMatchObject({ ok: true, value: { kind: "invalid", violation: { code: "DUPLICATE_COMPLETION" } } });
  });

  it.each([
    ["process exit", [{ kind: "process-exited" as const }], "failed", "PROVIDER_EXITED"],
    ["session dispose", [{ kind: "session-disposed" as const }], "invalid", "TURN_ENDED_WITHOUT_DISPOSITION"],
  ])("never treats %s as completion", async (_name, events, kind, code) => {
    const fixture = await harness([events]);

    const result = await fixture.manager.host.start(dispatch(), sink().value);

    expect(result).toMatchObject({ ok: true, value: { kind } });
    expect(JSON.stringify(result)).toContain(code);
  });

  it("fails closed when completion and pending input coexist", async () => {
    const fixture = await harness([[
      { kind: "structured-completion", result: { accepted: true } },
      { kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: { type: "string" } },
    ]]);

    expect(await fixture.manager.host.start(dispatch(), sink().value)).toMatchObject({ ok: true, value: { kind: "invalid", violation: { code: "PENDING_INPUT_AT_COMPLETION" } } });
  });

  it("fails closed on multiple pending input requests", async () => {
    const fixture = await harness([[
      { kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: {} },
      { kind: "input-request", requestIdentity: "request-2", prompt: "?", responseSchema: {} },
    ]]);

    expect(await fixture.manager.host.start(dispatch(), sink().value)).toMatchObject({ ok: true, value: { kind: "failed", failure: { code: "PROVIDER_PROTOCOL_ERROR" } } });
  });

  it("reports invalid structured results without accepting them", async () => {
    const fixture = await harness([[{ kind: "structured-completion", result: { accepted: false } }]]);

    expect(await fixture.manager.host.start(dispatch(), sink().value)).toMatchObject({ ok: true, value: { kind: "invalid", violation: { code: "RESULT_SCHEMA_INVALID" } } });
  });

  it.each([
    ["INTERACTION_CANCELLED", "ACTION_INTERACTION_CANCELLED"],
    ["INTERACTION_UNAVAILABLE", "ACTION_INTERACTION_UNAVAILABLE"],
  ] as const)("maps output sink %s to a managed failure", async (sinkCode, failureCode) => {
    const fixture = await harness([[{ kind: "output", content: "frame" }, { kind: "structured-completion", result: { accepted: true } }]]);
    const rejecting: ActionOutputSink = { async publish() { return { ok: false, error: { code: sinkCode } }; } };

    expect(await fixture.manager.host.start(dispatch(), rejecting)).toMatchObject({ ok: true, value: { kind: "failed", failure: { code: failureCode } } });
  });

  it("contains thrown native turns as redacted protocol failures", async () => {
    const fixture = await harness([]);
    fixture.provider.session.run = async () => { throw new Error(`bad ${fixture.credentials.secret}`); };

    expect(await fixture.manager.host.start(dispatch(), sink().value)).toMatchObject({ ok: true, value: { kind: "failed", failure: { code: "PROVIDER_PROTOCOL_ERROR", detail: { detail: "bad [REDACTED]" } } } });
  });

  it("reports unknown rather than completion or failure when native persistence is unobserved", async () => {
    const fixture = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);
    fixture.provider.session.persist = async () => { throw new Error("flush interrupted"); };

    expect(await fixture.manager.host.start(dispatch(), sink().value)).toMatchObject({ ok: true, value: { kind: "unknown", uncertainty: { owner: "invocation", reason: "CALL_INTERRUPTED" } } });
  });

  it("validates executor, affinity, correlation, workspace, and capability before effects", async () => {
    const cases: InvocationDispatch[] = [];
    const base = dispatch();
    cases.push({ ...base, plan: { ...base.plan, actionIdentity: "wrong-action" as never } });
    cases.push({ ...base, session: { ...base.session, sessionCompatibilityIdentity: `sha256:${"0".repeat(64)}` } });
    cases.push({ ...base, session: { ...base.session, delivery: { ...base.session.delivery, deliveryIdentity: "wrong-delivery" as never } } });
    cases.push({ ...base, workspace: { kind: "write", handle: { ...base.workspace.kind === "write" ? base.workspace.handle : ({} as never), episode: { ...base.episode, invocationIdentity: "wrong-invocation" as never } } } });
    cases.push({ ...base, workspace: { kind: "read", view: { viewIdentity: "view-1", episode: { ...base.episode, invocationIdentity: "wrong-invocation" }, source: (base.workspace as never as { handle: { savepoint: unknown } }).handle.savepoint, accessDigest: `sha256:${"5".repeat(64)}` } } as never });
    cases.push({ ...base, workspace: { kind: "none" } });
    cases.push({ ...base, workspace: { kind: "read", view: { viewIdentity: "view-1", episode: base.episode, source: (base.workspace as never as { handle: { savepoint: unknown } }).handle.savepoint, accessDigest: `sha256:${"5".repeat(64)}` } } as never });
    cases.push({ ...base, executor: { ...base.executor, session: { ...base.executor.session, providedCapabilities: [] } } });

    for (const candidate of cases) {
      const fixture = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);
      expect(await fixture.manager.host.start(candidate, sink().value)).toMatchObject({ ok: false });
      expect(fixture.provider.openCount).toBe(0);
    }
  });

  it("fails start for missing provider, credential acquisition, duplicate episode, and provider open errors", async () => {
    const missing = await harness([]);
    const missingDispatch = dispatch();
    const absentProvider = { ...missingDispatch, executor: { ...missingDispatch.executor, session: { ...missingDispatch.executor.session, driver: { ...missingDispatch.executor.session.driver, providerIdentity: "codex-cli" as const } } } };
    expect(await missing.manager.host.start(absentProvider, sink().value)).toEqual({ ok: false, error: { code: "PROVIDER_NOT_IMPLEMENTED" } });

    const noCredentials = await harness([]);
    noCredentials.credentials.acquire = async () => { throw new Error("missing"); };
    expect(await noCredentials.manager.host.start(dispatch(), sink().value)).toEqual({ ok: false, error: { code: "CREDENTIAL_ACQUISITION_FAILED" } });

    const duplicate = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);
    await duplicate.manager.host.start(dispatch(), sink().value);
    expect(await duplicate.manager.host.start(dispatch(), sink().value)).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });

    const openFailure = await harness([]);
    openFailure.provider.open = async () => { throw new Error("boot failed"); };
    expect(await openFailure.manager.host.start(dispatch(), sink().value)).toMatchObject({ ok: true, value: { kind: "failed", failure: { code: "PROVIDER_PROTOCOL_ERROR" } } });
  });

  it("persists awaiting input and resumes the exact native session without opening a fallback", async () => {
    const fixture = await harness([
      [{ kind: "input-request", requestIdentity: "request-1", prompt: { text: "approve?" }, responseSchema: { type: "boolean" } }],
      [{ kind: "structured-completion", result: { accepted: true } }],
    ]);
    const first = await fixture.manager.host.start(dispatch(), sink().value);
    expect(first).toMatchObject({ ok: true, value: { kind: "awaiting-input", request: { identity: "request-1" } } });

    const resumed = await fixture.manager.host.continueWithInput({
      episode: episode() as InvocationDispatch["episode"],
      response: {
        requestIdentity: "request-1",
        content: true,
        contentIdentity: contentIdentity(true),
      } as never,
    }, sink().value);

    expect(resumed).toMatchObject({ ok: true, value: { kind: "completed", interactionReceipts: [{ requestIdentity: "request-1" }] } });
    expect(fixture.provider.openCount).toBe(1);
    expect(fixture.provider.restored).toEqual(["native-session-1"]);
  });

  it("returns unknown when exact native restore fails and never falls back to fresh", async () => {
    const fixture = await harness([[{ kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: { type: "string" } }]]);
    await fixture.manager.host.start(dispatch(), sink().value);
    fixture.provider.restore = async () => {
      throw new Error("native state missing");
    };

    const resumed = await fixture.manager.host.continueWithInput({
      episode: episode() as InvocationDispatch["episode"],
      response: { requestIdentity: "request-1", content: "answer", contentIdentity: contentIdentity("answer") } as never,
    }, sink().value);

    expect(resumed).toMatchObject({ ok: true, value: { kind: "unknown", uncertainty: { owner: "invocation" } } });
    expect(fixture.provider.openCount).toBe(1);
    expect(fixture.credentials.released).toEqual(["released", "released"]);
  });

  it("rejects a response that violates the persisted response schema before native restore", async () => {
    const fixture = await harness([[{ kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: { type: "boolean" } }]]);
    await fixture.manager.host.start(dispatch(), sink().value);

    const resumed = await fixture.manager.host.continueWithInput({
      episode: episode() as InvocationDispatch["episode"],
      response: { requestIdentity: "request-1", content: "not boolean", contentIdentity: contentIdentity("not boolean") } as never,
    }, sink().value);

    expect(resumed).toMatchObject({ ok: true, value: { kind: "invalid", violation: { code: "INTERACTION_CORRELATION_INVALID" } } });
    expect(fixture.provider.restored).toEqual([]);
  });

  it("does not equate invocation-plan binding identity with executor binding identity", async () => {
    const fixture = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);
    const input = dispatch();
    const independentPlan = { ...input, plan: { ...input.plan, bindingIdentity: `sha256:${"9".repeat(64)}` as const } };

    expect(await fixture.manager.host.start(independentPlan, sink().value)).toMatchObject({ ok: true, value: { kind: "completed" } });
  });

  it("propagates typed unimplemented Provider errors without falling back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g03-journal-"));
    temporaryDirectories.push(directory);
    const input = dispatch();
    const copilot = {
      ...input,
      executor: {
        ...input.executor,
        session: { ...input.executor.session, driver: { ...input.executor.session.driver, providerIdentity: "copilot-sdk" as const } },
      },
    };
    const manager = createManagedInvocation({
      providers: { "copilot-sdk": createCopilotProviderShell() },
      credentials: new LeaseBroker(),
      journal: new FileInvocationJournalStore(directory),
      validateResult: () => true,
      authorizeRetirement: () => true,
    });

    expect(await manager.host.start(copilot, sink().value)).toEqual({ ok: false, error: { code: "PROVIDER_NOT_IMPLEMENTED" } });
  });

  it("rejects stale input correlation before provider effects", async () => {
    const fixture = await harness([[{ kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: {} }]]);
    await fixture.manager.host.start(dispatch(), sink().value);

    const resumed = await fixture.manager.host.continueWithInput({
      episode: episode() as InvocationDispatch["episode"],
      response: { requestIdentity: "stale-request", content: "answer", contentIdentity: `sha256:${"8".repeat(64)}` } as never,
    }, sink().value);

    expect(resumed).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
    expect(fixture.provider.restored).toEqual([]);
  });

  it("redacts credential material from durable journals and releases every lease", async () => {
    const fixture = await harness([[{ kind: "provider-failed", code: "PROVIDER_PROTOCOL_ERROR", detail: { message: "bad secret-do-not-journal" } }]]);

    await fixture.manager.host.start(dispatch(), sink().value);

    const entries = await readFile(join(fixture.directory, "invocation-1.json"), "utf8");
    expect(entries).not.toContain(fixture.credentials.secret);
    expect(entries).toContain("[REDACTED]");
    expect(fixture.credentials.released).toEqual(["released"]);
  });

  it("cancels by Delivery, reports known facts, and requires owner-scoped retirement", async () => {
    const fixture = await harness([[{ kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: {} }]]);
    await fixture.manager.host.start(dispatch(), sink().value);

    const inspected = await fixture.manager.control.inspect(delivery() as never);
    expect(inspected).toMatchObject({ ok: true, value: { process: { state: "known", value: "running" } } });

    const cancelled = await fixture.manager.control.cancel({ delivery: delivery() as never, reason: "DELIVERY_CANCELLED" });
    expect(cancelled).toMatchObject({ ok: true, value: { process: { state: "known", value: "stopped" } } });

    const wrong = { identity: "retirement-wrong", delivery: { ...delivery(), deliveryIdentity: "delivery-other" } } as unknown as RetirementAuthorizationRef;
    expect(await fixture.manager.control.retire(wrong)).toEqual({ ok: false, error: { code: "RETIREMENT_NOT_AUTHORIZED" } });

    const authorization = { identity: "retirement-1", delivery: delivery() } as unknown as RetirementAuthorizationRef;
    expect(await fixture.manager.control.retire(authorization)).toMatchObject({ ok: true, value: { reference: { owner: "invocation" }, state: "retired" } });
  });

  it("preserves a terminal journal when cancellation arrives after completion", async () => {
    const fixture = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);
    await fixture.manager.host.start(dispatch(), sink().value);

    const cancelled = await fixture.manager.control.cancel({ delivery: delivery() as never, reason: "DELIVERY_CANCELLED" });

    expect(cancelled).toMatchObject({ ok: true, value: { process: { state: "known", value: "terminal" } } });
    expect(await fixture.manager.control.inspect(delivery() as never)).toMatchObject({
      ok: true,
      value: { process: { state: "known", value: "terminal" } },
    });
  });
});
