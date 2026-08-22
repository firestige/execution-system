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
import { canonicalDigest } from "../../src/contracts/index.js";
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

function bindDispatch(value: InvocationDispatch): InvocationDispatch {
  const mutable = value as unknown as {
    executor: { bindingIdentity: string; sessionCompatibilityIdentity: string; session: unknown; turn: { access: unknown } };
    plan: { bindingIdentity: string };
    session: { identity: string; sessionCompatibilityIdentity: string; delivery: { deliveryIdentity: string }; scopeValueIdentity: string; isolation: string };
    workspace: { kind: string; handle?: { accessDigest: string }; view?: { accessDigest: string } };
    episode: { site: unknown };
    action: unknown;
  };
  mutable.executor.sessionCompatibilityIdentity = canonicalDigest(mutable.executor.session);
  mutable.executor.bindingIdentity = canonicalDigest({ session: mutable.executor.session, turn: mutable.executor.turn });
  mutable.plan.bindingIdentity = canonicalDigest({ site: mutable.episode.site, action: mutable.action, executorBindingIdentity: mutable.executor.bindingIdentity });
  mutable.session.sessionCompatibilityIdentity = mutable.executor.sessionCompatibilityIdentity;
  mutable.session.identity = canonicalDigest({
    deliveryIdentity: mutable.session.delivery.deliveryIdentity,
    sessionCompatibilityIdentity: mutable.session.sessionCompatibilityIdentity,
    scopeValueIdentity: mutable.session.scopeValueIdentity,
    isolation: mutable.session.isolation,
  });
  if (mutable.workspace.kind === "write") mutable.workspace.handle!.accessDigest = canonicalDigest(mutable.executor.turn.access);
  if (mutable.workspace.kind === "read") mutable.workspace.view!.accessDigest = canonicalDigest(mutable.executor.turn.access);
  return value;
}

function dispatch(): InvocationDispatch {
  const value = {
    episode: episode() as InvocationDispatch["episode"],
    plan: {
      actionIdentity: "action-1",
      executorIdentity: "executor-1",
      bindingIdentity: `sha256:${"d".repeat(64)}`,
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
      bindingIdentity: `sha256:${"d".repeat(64)}`,
      sessionCompatibilityIdentity: `sha256:${"c".repeat(64)}`,
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
          configuration: { credentialRef: "DEEPSEEK_API_KEY", providerRoute: "deepseek" },
        },
        instructions: {
          resourceIdentity: "instruction-resource-1",
          contentIdentity: `sha256:${"4".repeat(64)}`,
          localReadOnlyPath: "/admitted/instructions.md",
        },
        tools: [],
        providedCapabilities: ["structured-completion", "action-interaction"],
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
      sessionCompatibilityIdentity: `sha256:${"c".repeat(64)}`,
      scopeValueIdentity: `sha256:${"6".repeat(64)}`,
      isolation: "isolated",
    } as InvocationDispatch["session"],
  } as unknown as InvocationDispatch;
  return bindDispatch(value);
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

class CountingJournalStore extends FileInvocationJournalStore {
  journalDeleteCount = 0;
  affinityDeleteCount = 0;

  override async delete(identity: string): Promise<void> {
    this.journalDeleteCount += 1;
    await super.delete(identity);
  }

  override async deleteAffinity(identity: string): Promise<void> {
    this.affinityDeleteCount += 1;
    await super.deleteAffinity(identity);
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
  const journal = new CountingJournalStore(directory);
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
    cases.push({ ...base, plan: { ...base.plan, bindingIdentity: `sha256:${"0".repeat(64)}` } });
    cases.push({ ...base, executor: { ...base.executor, bindingIdentity: `sha256:${"0".repeat(64)}` } });
    cases.push({ ...base, session: { ...base.session, sessionCompatibilityIdentity: `sha256:${"0".repeat(64)}` } });
    cases.push({ ...base, session: { ...base.session, identity: "stale-affinity" as never } });
    cases.push({ ...base, session: { ...base.session, delivery: { ...base.session.delivery, deliveryIdentity: "wrong-delivery" as never } } });
    cases.push({ ...base, workspace: { kind: "write", handle: { ...base.workspace.kind === "write" ? base.workspace.handle : ({} as never), episode: { ...base.episode, invocationIdentity: "wrong-invocation" as never } } } });
    cases.push({ ...base, workspace: { kind: "write", handle: { ...base.workspace.kind === "write" ? base.workspace.handle : ({} as never), accessDigest: `sha256:${"0".repeat(64)}` } } });
    cases.push({ ...base, workspace: { kind: "read", view: { viewIdentity: "view-1", episode: { ...base.episode, invocationIdentity: "wrong-invocation" }, source: (base.workspace as never as { handle: { savepoint: unknown } }).handle.savepoint, accessDigest: `sha256:${"5".repeat(64)}` } } as never });
    cases.push({ ...base, workspace: { kind: "none" } });
    cases.push({ ...base, workspace: { kind: "read", view: { viewIdentity: "view-1", episode: base.episode, source: (base.workspace as never as { handle: { savepoint: unknown } }).handle.savepoint, accessDigest: `sha256:${"5".repeat(64)}` } } as never });
    cases.push({ ...base, executor: { ...base.executor, session: { ...base.executor.session, providedCapabilities: [] } } });
    const emptyModel = structuredClone(base) as InvocationDispatch;
    (emptyModel.executor.session.model as { providerModelIdentity: string }).providerModelIdentity = "";
    cases.push(bindDispatch(emptyModel));
    const missingRoute = structuredClone(base) as InvocationDispatch;
    (missingRoute.executor.session.driver as { configuration: unknown }).configuration = { credentialRef: "DEEPSEEK_API_KEY" };
    cases.push(bindDispatch(missingRoute));

    for (const candidate of cases) {
      const fixture = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);
      expect(await fixture.manager.host.start(candidate, sink().value)).toMatchObject({ ok: false });
      expect(fixture.provider.openCount).toBe(0);
    }
  });

  it("fails start for missing provider, credential acquisition, duplicate episode, and provider open errors", async () => {
    const missing = await harness([]);
    const missingDispatch = dispatch();
    const absentProvider = structuredClone(missingDispatch) as InvocationDispatch;
    (absentProvider.executor.session.driver as { providerIdentity: string }).providerIdentity = "codex-cli";
    bindDispatch(absentProvider);
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

  it("rejects a stale invocation-plan binding identity", async () => {
    const fixture = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);
    const input = dispatch();
    const independentPlan = { ...input, plan: { ...input.plan, bindingIdentity: `sha256:${"9".repeat(64)}` as const } };

    expect(await fixture.manager.host.start(independentPlan, sink().value)).toEqual({ ok: false, error: { code: "EXECUTOR_BINDING_MISMATCH" } });
    expect(fixture.provider.openCount).toBe(0);
  });

  it("durably restores the exact native session for a compatible affinity across episodes", async () => {
    const fixture = await harness([
      [{ kind: "structured-completion", result: { accepted: true } }],
      [{ kind: "structured-completion", result: { accepted: true } }],
    ]);
    const first = dispatch();
    const firstMutable = structuredClone(first) as InvocationDispatch;
    (firstMutable.executor.session.policy as { scope: unknown; isolation: string }).scope = { kind: "data-bound", source: { nodeIdentity: "node-source", port: "result" } };
    (firstMutable.executor.session.policy as { scope: unknown; isolation: string }).isolation = "shared";
    (firstMutable.session as { isolation: string }).isolation = "shared";
    bindDispatch(firstMutable);
    await fixture.manager.host.start(firstMutable, sink().value);

    const second = structuredClone(firstMutable) as InvocationDispatch;
    (second.episode as { invocationIdentity: string; attemptIdentity: string }).invocationIdentity = "invocation-2";
    (second.episode as { invocationIdentity: string; attemptIdentity: string }).attemptIdentity = "attempt-2";
    if (second.workspace.kind === "write") (second.workspace.handle as { episode: unknown }).episode = second.episode;
    bindDispatch(second);

    expect(await fixture.manager.host.start(second, sink().value)).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(fixture.provider.openCount).toBe(1);
    expect(fixture.provider.restored).toEqual(["native-session-1"]);
  });

  it("keeps awaiting-input quiescent and prevents cancellation from being overwritten by late completion", async () => {
    const awaiting = await harness([[{ kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: {} }]]);
    await awaiting.manager.host.start(dispatch(), sink().value);
    expect(await awaiting.manager.control.inspect(delivery() as never)).toMatchObject({ ok: true, value: { process: { state: "known", value: "stopped" } } });

    const racing = await harness([]);
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredRun = new Promise<void>((resolve) => { entered = resolve; });
    racing.provider.session.run = async () => {
      entered();
      await running;
      return [{ kind: "structured-completion", result: { accepted: true } }];
    };
    const started = racing.manager.host.start(dispatch(), sink().value);
    await enteredRun;
    await racing.manager.control.cancel({ delivery: delivery() as never, reason: "DELIVERY_CANCELLED" });
    release();

    expect(await started).toMatchObject({ ok: true, value: { kind: "failed", failure: { code: "PROVIDER_CANCELLED" } } });
    expect(await racing.manager.control.inspect(delivery() as never)).toMatchObject({ ok: true, value: { process: { state: "known", value: "stopped" } } });
  });

  it("fails closed on input suspension without the admitted action-interaction capability", async () => {
    const fixture = await harness([[{ kind: "input-request", requestIdentity: "request-1", prompt: "?", responseSchema: {} }]]);
    const input = dispatch();
    const withoutInteraction = structuredClone(input) as InvocationDispatch;
    (withoutInteraction.executor.session as unknown as { providedCapabilities: string[] }).providedCapabilities = ["structured-completion"];
    bindDispatch(withoutInteraction);

    expect(await fixture.manager.host.start(withoutInteraction, sink().value)).toMatchObject({
      ok: true,
      value: { kind: "failed", failure: { code: "PROVIDER_PROTOCOL_ERROR" } },
    });
  });

  it("propagates typed unimplemented Provider errors without falling back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g03-journal-"));
    temporaryDirectories.push(directory);
    const input = dispatch();
    const copilot = structuredClone(input) as InvocationDispatch;
    (copilot.executor.session.driver as { providerIdentity: string }).providerIdentity = "copilot-sdk";
    bindDispatch(copilot);
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
    expect(inspected).toMatchObject({ ok: true, value: { process: { state: "known", value: "stopped" } } });

    const cancelled = await fixture.manager.control.cancel({ delivery: delivery() as never, reason: "DELIVERY_CANCELLED" });
    expect(cancelled).toMatchObject({ ok: true, value: { process: { state: "known", value: "stopped" } } });

    const wrong = { identity: "retirement-wrong", delivery: { ...delivery(), deliveryIdentity: "delivery-other" } } as unknown as RetirementAuthorizationRef;
    expect(await fixture.manager.control.retire(wrong)).toEqual({ ok: false, error: { code: "RETIREMENT_NOT_AUTHORIZED" } });

    const authorization = { identity: "retirement-1", delivery: delivery() } as unknown as RetirementAuthorizationRef;
    expect(await fixture.manager.control.retire(authorization)).toEqual({ ok: true, value: { owner: "invocation", authorization, state: "retired" } });
  });

  it("durably replays the same retirement fact after response loss without repeating cleanup", async () => {
    const fixture = await harness([[{ kind: "structured-completion", result: { accepted: true } }]]);
    const activeDispatch = dispatch();
    await fixture.manager.host.start(activeDispatch, sink().value);
    const authorization = { identity: "retirement-retry", delivery: delivery() } as unknown as RetirementAuthorizationRef;

    const lostResponse = await fixture.manager.control.retire(authorization);
    expect(lostResponse).toEqual({ ok: true, value: { owner: "invocation", authorization, state: "retired" } });
    expect(await fixture.journal.list()).toEqual([]);
    expect(await fixture.journal.loadAffinity(activeDispatch.session.identity)).toBeUndefined();
    const cleanupCounts = [fixture.journal.journalDeleteCount, fixture.journal.affinityDeleteCount];

    expect(await fixture.manager.control.retire(authorization)).toEqual(lostResponse);
    expect([fixture.journal.journalDeleteCount, fixture.journal.affinityDeleteCount]).toEqual(cleanupCounts);
    const differentAuthorization = { ...authorization, identity: "retirement-different" } as unknown as RetirementAuthorizationRef;
    expect(await fixture.manager.control.retire(differentAuthorization)).toEqual({ ok: false, error: { code: "RETIREMENT_NOT_AUTHORIZED" } });
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
