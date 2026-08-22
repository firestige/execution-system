import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../../src/contracts/index.js";
import type {
  ActionInputRequest,
  CoordinatorCustody,
  CoordinatorHost,
  CoordinatorInvocationControl,
  DeliveryRef,
  HostDisposition,
  OwnerRetirementDisposition,
  PublicationDisposition,
  RetirementAuthorizationRef,
  RunnerActivationContext,
  TerminalProposal,
} from "../../src/contracts/index.js";
import { EXECUTION_RUNTIME_ADAPTER_VERSION } from "../../src/execution/runtime-adapter.js";
import { createExecutionRuntimeAdapter } from "../../src/composition/create-execution-runtime-adapter.js";
import { mutatedRunnerActivation } from "../support/runner-activation-fixtures.js";

const ok = <T>(value: T) => ({ ok: true as const, value });
const sha = (value: string) => `sha256:${value.padEnd(64, value[0] ?? "0").slice(0, 64)}` as const;

function activation(): RunnerActivationContext {
  return mutatedRunnerActivation((draft) => {
    for (const executor of Object.values(draft.program.execution.agents) as any[]) {
      executor.sessionCompatibilityIdentity = canonicalDigest(executor.session);
      executor.bindingIdentity = canonicalDigest({ session: executor.session, turn: executor.turn });
    }
  });
}

function deliveryOf(value: RunnerActivationContext): DeliveryRef {
  return {
    deliveryIdentity: value.correlation.deliveryIdentity,
    manifestBindingIdentity: value.correlation.manifestBindingIdentity,
    activationBindingIdentity: value.bindingIdentity,
  };
}

function terminal(value: RunnerActivationContext, outcome: TerminalProposal["proposedOutcome"] = "COMPLETED"): TerminalProposal {
  const delivery = deliveryOf(value);
  const thread = { delivery, threadIdentity: "thread.fixture" as never };
  return {
    thread,
    checkpoint: {
      identity: "checkpoint.fixture" as never,
      thread,
      stateIdentity: sha("c"),
      savepoint: { state: "known", value: { deliveryIdentity: delivery.deliveryIdentity, savepointIdentity: "savepoint.fixture" as never, gitTree: value.initial.workspace.admittedGitTree } },
    },
    proposedOutcome: outcome,
    reason: outcome === "COMPLETED" ? "DECLARED_TERMINAL" : outcome === "INCOMPLETE" ? "DECLARED_INCOMPLETE" : outcome === "CANCELLED" ? "CANCELLED" : "ACTION_FAILED",
    result: {
      state: "known",
      value: { identity: "workflow-result.fixture" as never, content: { answer: 42 }, contentIdentity: sha("r"), artifacts: {} },
    },
  };
}

function fixture(dispositions: HostDisposition[], retirement?: Partial<Record<"host" | "invocation" | "custody", OwnerRetirementDisposition>>) {
  const value = activation();
  const delivery = deliveryOf(value);
  const events: string[] = [];
  const queue = [...dispositions];
  const next = async () => ok(queue.shift()!);
  const host = {
    start: vi.fn(async () => { events.push("host.start"); return next(); }),
    resumeAction: vi.fn(async () => { events.push("host.resumeAction"); return next(); }),
    resumeWorkflow: vi.fn(async () => { events.push("host.resumeWorkflow"); return next(); }),
    stop: vi.fn(async (request: any) => ok({ thread: request.thread, state: { state: "known", value: "stopped" }, checkpoint: { state: "unknown", owner: "host", reason: "CHECKPOINT_DISPOSITION_UNOBSERVED" } })),
    inspect: vi.fn(async () => ok({ thread: terminal(value).thread, checkpoint: { state: "known", value: terminal(value).checkpoint }, pendingSite: { state: "known", value: { kind: "ABSENT" } }, disposition: { state: "known", value: { kind: "ABSENT" } } })),
    recover: vi.fn(next),
    retire: vi.fn(async ({ authorization }: { authorization: RetirementAuthorizationRef }) => {
      events.push("host.retire");
      return ok(retirement?.host ?? { owner: "host", authorization, state: "retired" });
    }),
  } as unknown as CoordinatorHost;
  const invocation = {
    cancel: vi.fn(async () => ok({ delivery, process: { state: "known", value: "stopped" }, sessions: { state: "known", value: [] }, journals: { state: "known", value: [] } })),
    inspect: vi.fn(async () => ok({ delivery, process: { state: "known", value: "terminal" }, sessions: { state: "known", value: [] }, journals: { state: "known", value: [] } })),
    retire: vi.fn(async (authorization: RetirementAuthorizationRef) => {
      events.push("invocation.retire");
      return ok(retirement?.invocation ?? { owner: "invocation", authorization, state: "retired" });
    }),
  } as unknown as CoordinatorInvocationControl;
  const preserved = { identity: "preserved.fixture" as never, delivery, contentIdentity: sha("r"), savepoint: terminal(value).checkpoint.savepoint };
  const published: PublicationDisposition = { kind: "published", reference: { identity: "publication.fixture" as never, target: { identity: "target.fixture" as never }, result: preserved } };
  const custody = {
    preserveResult: vi.fn(async () => { events.push("custody.preserve"); return ok(preserved); }),
    publish: vi.fn(async () => { events.push("custody.publish"); return ok(published); }),
    inspect: vi.fn(async () => ok({ delivery, currentSavepoint: terminal(value).checkpoint.savepoint, preservedResult: { state: "known", value: preserved }, publication: { state: "known", value: published } })),
    recover: vi.fn(async () => ok({ kind: "continued", savepoint: (terminal(value).checkpoint.savepoint as any).value })),
    retire: vi.fn(async (authorization: RetirementAuthorizationRef) => {
      events.push("custody.retire");
      return ok(retirement?.custody ?? { owner: "custody", authorization, state: "retired" });
    }),
  } as unknown as CoordinatorCustody;
  const interaction = {
    publish: vi.fn(async () => ok(undefined)),
    requestInput: vi.fn(async (request: ActionInputRequest) => ok({ requestIdentity: request.identity, content: { answer: "yes" }, contentIdentity: canonicalDigest({ answer: "yes" }) })),
  };
  const workflow = { request: vi.fn(async (request: any) => ok({ controlIdentity: request.controlIdentity, correlationIdentity: request.correlationIdentity, content: true, contentIdentity: canonicalDigest(true) })) };
  const observe = vi.fn(async () => undefined);
  const stateDirectory = mkdtempSync(path.join(tmpdir(), "formal-g05-"));
  const options = {
    stateDirectory: stateDirectory as never,
    host,
    invocation,
    custody,
    interaction,
    workflow,
    observation: { observe },
    publicationTarget: { identity: "target.fixture" as never },
    implementationIdentity: "implementation.fixture" as never,
  };
  const adapter = createExecutionRuntimeAdapter(options);
  return { adapter, options, stateDirectory, value, delivery, events, host, invocation, custody, preserved, published, interaction, workflow, observe };
}

describe("formal G05 Execution Runtime Adapter", () => {
  it("compiles before starting Host and settles only after preservation, known publication, and four known retirements", async () => {
    const value = activation();
    const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value) }]);
    // Use the fixture's correlated activation/proposal pair.
    (f.host.start as any).mockImplementationOnce(async () => { f.events.push("host.start"); return ok({ kind: "terminal-proposal", proposal: terminal(f.value) }); });

    const result = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });

    expect(result.ok && result.value.kind).toBe("terminal");
    if (!result.ok || result.value.kind !== "terminal") throw new Error("terminal settlement missing");
    expect(result.value.outcome).toBe("COMPLETED");
    expect(result.value.settlement.ownerRetirements.map((fact) => fact.owner)).toEqual(["coordinator", "host", "invocation", "custody"]);
    expect(f.events).toEqual(["host.start", "custody.preserve", "custody.publish", "host.retire", "invocation.retire", "custody.retire"]);
    expect(f.host.start).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: "runner.compiled-activation@1.0.0", activationBindingIdentity: f.value.bindingIdentity }), f.interaction);
    expect(Object.isFrozen(result.value.settlement)).toBe(true);
  });

  it("uses the Action bridge and resumes the exact same episode without creating Workflow control", async () => {
    const value = activation();
    const proposal = terminal(value);
    const episode = { thread: proposal.thread, site: { kind: "node", nodeIdentity: "node.action" }, invocationIdentity: "invocation.fixture", attemptIdentity: "attempt.fixture" } as never;
    const request = { identity: "input.fixture", episode, prompt: "continue?", responseSchema: {} } as never;
    const f = fixture([{ kind: "action-input", wait: { checkpoint: proposal.checkpoint, episode, request } }, { kind: "terminal-proposal", proposal }]);

    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });

    expect(f.interaction.requestInput).toHaveBeenCalledWith(request);
    expect(f.host.resumeAction).toHaveBeenCalledWith(expect.objectContaining({ thread: proposal.thread, episode }), f.interaction);
    expect(f.workflow.request).not.toHaveBeenCalled();
  });

  it("uses Workflow control only for workflow-wait and resumes the same thread", async () => {
    const value = activation();
    const proposal = terminal(value);
    const request = { controlIdentity: "control.fixture", correlationIdentity: "correlation.fixture", kind: "user", content: { approval: true }, contentIdentity: sha("w") } as never;
    const f = fixture([{ kind: "workflow-wait", wait: { checkpoint: proposal.checkpoint, request } }, { kind: "terminal-proposal", proposal }]);

    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });

    expect(f.workflow.request).toHaveBeenCalledWith(request);
    expect(f.host.resumeWorkflow).toHaveBeenCalledWith(expect.objectContaining({ thread: proposal.thread }), f.interaction);
    expect(f.interaction.requestInput).not.toHaveBeenCalled();
  });

  it("retains terminal facts without settlement when one owner is unknown, then retries with the same authorization", async () => {
    const value = activation();
    const proposal = terminal(value);
    let attempts = 0;
    const f = fixture([{ kind: "terminal-proposal", proposal }]);
    (f.invocation.retire as any).mockImplementation(async (authorization: RetirementAuthorizationRef) => {
      f.events.push("invocation.retire");
      attempts += 1;
      return ok(attempts === 1
        ? { owner: "invocation", authorization, state: "unknown", uncertainty: { state: "unknown", owner: "invocation", reason: "CALL_INTERRUPTED" } }
        : { owner: "invocation", authorization, state: "retired" });
    });

    const first = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    const second = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });

    expect(first.ok && first.value.kind).toBe("unknown");
    expect(second.ok && second.value.kind).toBe("terminal");
    const authorizations = (f.invocation.retire as any).mock.calls.map((call: any[]) => call[0].identity);
    expect(new Set(authorizations).size).toBe(1);
    expect(f.host.retire).toHaveBeenCalledTimes(1);
    expect(f.custody.retire).toHaveBeenCalledTimes(1);
    expect(f.custody.preserveResult).toHaveBeenCalledTimes(1);
    expect(f.custody.publish).toHaveBeenCalledTimes(1);
  });

  it("turns publication conflict into intervention truth and never retires or settles", async () => {
    const value = activation();
    const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value) }]);
    (f.custody.publish as any).mockImplementationOnce(async () => ok({ kind: "conflict", preservedResult: f.preserved }));

    const result = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });

    expect(result.ok && result.value.kind).toBe("unknown");
    expect(f.host.retire).not.toHaveBeenCalled();
  });

  it("keeps all five result categories distinct, including conclusive START_FAILED", async () => {
    for (const outcome of ["COMPLETED", "INCOMPLETE", "FAILED", "CANCELLED"] as const) {
      const value = activation();
      const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value, outcome) }]);
      (f.host.start as any).mockImplementationOnce(async () => ok({ kind: "terminal-proposal", proposal: terminal(f.value, outcome) }));
      const result = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
      expect(result.ok && result.value.kind === "terminal" && result.value.outcome).toBe(outcome);
    }
    const f = fixture([]);
    (f.host.start as any).mockResolvedValueOnce({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
    const failed = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    expect(failed).toMatchObject({ ok: true, value: { kind: "start-failed", code: "START_FAILED" } });
  });

  it("isolates Observation throw from immutable settlement and exposes only execute/inspect/cancel", async () => {
    const value = activation();
    const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value) }]);
    (f.host.start as any).mockImplementationOnce(async () => ok({ kind: "terminal-proposal", proposal: terminal(f.value) }));
    f.observe.mockRejectedValueOnce(new Error("observation unavailable"));

    const result = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    const inspection = await f.adapter.inspect(f.delivery);
    const cancellation = await f.adapter.cancel(f.delivery);

    expect(result.ok && result.value.kind).toBe("terminal");
    expect(inspection).toMatchObject({ ok: true, value: { state: "terminal" } });
    expect(cancellation).toMatchObject({ ok: true, value: { state: { state: "known", value: "already-stable" } } });
    expect(Object.keys(f.adapter).sort()).toEqual(["cancel", "execute", "inspect"]);
  });

  it("fails closed on invalid activation and same Delivery identity with changed correlation", async () => {
    const f = fixture([]);
    const invalid = { ...f.value, bindingIdentity: sha("0") } as RunnerActivationContext;
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: invalid })).toEqual({ ok: false, error: { code: "ACTIVATION_REJECTED" } });
    (f.host.start as any).mockResolvedValueOnce({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    const changed = mutatedRunnerActivation((draft) => {
      draft.correlation.deliveryIdentity = f.delivery.deliveryIdentity;
      draft.correlation.manifestBindingIdentity = sha("m");
      for (const executor of Object.values(draft.program.execution.agents) as any[]) {
        executor.sessionCompatibilityIdentity = canonicalDigest(executor.session);
        executor.bindingIdentity = canonicalDigest({ session: executor.session, turn: executor.turn });
      }
    });
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: changed })).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
  });

  it("rejects stale Action and Workflow bridge responses without resuming Host", async () => {
    const value = activation();
    const proposal = terminal(value);
    const episode = { thread: proposal.thread, site: { kind: "node", nodeIdentity: "node.action" }, invocationIdentity: "invocation.fixture", attemptIdentity: "attempt.fixture" } as never;
    const action = fixture([{ kind: "action-input", wait: { checkpoint: proposal.checkpoint, episode, request: { identity: "input.fixture", episode, prompt: "?", responseSchema: {} } as never } }]);
    (action.interaction.requestInput as any).mockResolvedValueOnce(ok({ requestIdentity: "stale", content: true, contentIdentity: sha("s") }));
    expect(await action.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: action.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(action.host.resumeAction).not.toHaveBeenCalled();

    const request: any = { controlIdentity: "control.fixture", correlationIdentity: "correlation.fixture", kind: "user", content: {}, contentIdentity: sha("w") };
    const workflow = fixture([{ kind: "workflow-wait", wait: { checkpoint: terminal(activation()).checkpoint, request } }]);
    (workflow.workflow.request as any).mockResolvedValueOnce(ok({ controlIdentity: request.controlIdentity, correlationIdentity: "stale", content: true, contentIdentity: sha("x") }));
    expect(await workflow.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: workflow.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(workflow.host.resumeWorkflow).not.toHaveBeenCalled();
  });

  it("coordinates cancellation across Invocation, Host, and Custody and reports uncertainty", async () => {
    const value = activation();
    const proposal = terminal(value);
    const episode = { thread: proposal.thread, site: { kind: "node", nodeIdentity: "node.action" }, invocationIdentity: "invocation.fixture", attemptIdentity: "attempt.fixture" } as never;
    const f = fixture([{ kind: "action-input", wait: { checkpoint: proposal.checkpoint, episode, request: { identity: "input.fixture", episode, prompt: "?", responseSchema: {} } as never } }]);
    (f.interaction.requestInput as any).mockResolvedValueOnce({ ok: false, error: { code: "INTERACTION_CANCELLED" } });
    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    expect(await f.adapter.cancel(f.delivery)).toMatchObject({ ok: true, value: { state: { state: "known", value: "accepted" } } });
    expect(f.invocation.cancel).toHaveBeenCalledWith({ delivery: f.delivery, reason: "DELIVERY_CANCELLED" });
    expect(f.host.stop).toHaveBeenCalledWith({ thread: proposal.thread, reason: "CANCEL" });

    (f.invocation.cancel as any).mockRejectedValueOnce(new Error("lost"));
    expect(await f.adapter.cancel(f.delivery)).toMatchObject({ ok: true, value: { state: { state: "unknown" } } });
    const missing = { ...f.delivery, deliveryIdentity: "delivery.missing" as never };
    expect(await f.adapter.cancel(missing)).toEqual({ ok: false, error: { code: "ADAPTER_UNAVAILABLE" } });
  });

  it("reconciles a durable publication unknown without repeating preservation", async () => {
    const value = activation();
    const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value) }]);
    (f.host.start as any).mockImplementationOnce(async () => ok({ kind: "terminal-proposal", proposal: terminal(f.value) }));
    (f.custody.publish as any).mockResolvedValueOnce(ok({ kind: "unknown", preservedResult: f.preserved, uncertainty: { state: "unknown", owner: "custody", reason: "PUBLICATION_DISPOSITION_UNOBSERVED" } }));
    const first = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    const second = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    expect(first).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(second).toMatchObject({ ok: true, value: { kind: "terminal" } });
    expect(f.custody.preserveResult).toHaveBeenCalledTimes(1);
    expect(f.custody.publish).toHaveBeenCalledTimes(1);
  });

  it("recovers a stable bridge boundary from Host inspection instead of replaying start", async () => {
    const value = activation();
    const proposal = terminal(value);
    const episode = { thread: proposal.thread, site: { kind: "node", nodeIdentity: "node.action" }, invocationIdentity: "invocation.fixture", attemptIdentity: "attempt.fixture" } as never;
    const f = fixture([{ kind: "action-input", wait: { checkpoint: proposal.checkpoint, episode, request: { identity: "input.fixture", episode, prompt: "?", responseSchema: {} } as never } }]);
    (f.interaction.requestInput as any).mockResolvedValueOnce({ ok: false, error: { code: "INTERACTION_UNAVAILABLE" } });
    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    (f.host.inspect as any).mockResolvedValueOnce(ok({ thread: proposal.thread, checkpoint: { state: "known", value: proposal.checkpoint }, pendingSite: { state: "known", value: { kind: "ABSENT" } }, disposition: { state: "known", value: { kind: "terminal-proposal", proposal } } }));
    const recovered = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    expect(recovered).toMatchObject({ ok: true, value: { kind: "terminal" } });
    expect(f.host.start).toHaveBeenCalledTimes(1);
    expect(f.host.inspect).toHaveBeenCalledTimes(1);
  });

  it("does not preserve an unknown terminal result or a mismatched preserved result", async () => {
    const value = activation();
    const unknownProposal = { ...terminal(value), result: { state: "unknown", owner: "host", reason: "CHECKPOINT_DISPOSITION_UNOBSERVED" } } as TerminalProposal;
    const unknownResult = fixture([{ kind: "terminal-proposal", proposal: unknownProposal }]);
    (unknownResult.host.start as any).mockResolvedValueOnce(ok({ kind: "terminal-proposal", proposal: { ...unknownProposal, thread: terminal(unknownResult.value).thread, checkpoint: terminal(unknownResult.value).checkpoint } }));
    expect(await unknownResult.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: unknownResult.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(unknownResult.custody.preserveResult).not.toHaveBeenCalled();

    const mismatch = fixture([{ kind: "terminal-proposal", proposal: terminal(activation()) }]);
    (mismatch.host.start as any).mockResolvedValueOnce(ok({ kind: "terminal-proposal", proposal: terminal(mismatch.value) }));
    (mismatch.custody.preserveResult as any).mockResolvedValueOnce(ok({ ...mismatch.preserved, contentIdentity: sha("z") }));
    expect(await mismatch.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: mismatch.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(mismatch.custody.publish).not.toHaveBeenCalled();
  });

  it("treats wrong-owner retirement as unknown and retries only that owner", async () => {
    const value = activation();
    const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value) }]);
    (f.host.start as any).mockImplementationOnce(async () => ok({ kind: "terminal-proposal", proposal: terminal(f.value) }));
    let attempts = 0;
    (f.host.retire as any).mockImplementation(async ({ authorization }: any) => {
      attempts += 1;
      return ok({ owner: attempts === 1 ? "custody" : "host", authorization, state: "retired" });
    });
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "terminal" } });
    expect(f.host.retire).toHaveBeenCalledTimes(2);
    expect(f.invocation.retire).toHaveBeenCalledTimes(1);
    expect(f.custody.retire).toHaveBeenCalledTimes(1);
  });

  it("performs three-owner known recovery from an absent Host disposition", async () => {
    const value = activation();
    const proposal = terminal(value);
    const episode = { thread: proposal.thread, site: { kind: "node", nodeIdentity: "node.action" }, invocationIdentity: "invocation.fixture", attemptIdentity: "attempt.fixture" } as never;
    const f = fixture([{ kind: "action-input", wait: { checkpoint: proposal.checkpoint, episode, request: { identity: "input.fixture", episode, prompt: "?", responseSchema: {} } as never } }]);
    (f.interaction.requestInput as any).mockResolvedValueOnce({ ok: false, error: { code: "INTERACTION_UNAVAILABLE" } });
    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    (f.host.recover as any).mockResolvedValueOnce(ok({ kind: "terminal-proposal", proposal }));

    const recovered = await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });

    expect(recovered).toMatchObject({ ok: true, value: { kind: "terminal" } });
    expect(f.invocation.inspect).toHaveBeenCalledWith(f.delivery);
    expect(f.custody.recover).toHaveBeenCalledWith(expect.objectContaining({ delivery: f.delivery, directive: "continue" }));
    expect(f.host.recover).toHaveBeenCalledWith(expect.objectContaining({ thread: proposal.thread, directive: "continue" }));
  });

  it("turns uncertain recovery facts and Custody intervention into unresolved truth", async () => {
    const value = activation();
    const proposal = terminal(value);
    const episode = { thread: proposal.thread, site: { kind: "node", nodeIdentity: "node.action" }, invocationIdentity: "invocation.fixture", attemptIdentity: "attempt.fixture" } as never;
    const f = fixture([{ kind: "action-input", wait: { checkpoint: proposal.checkpoint, episode, request: { identity: "input.fixture", episode, prompt: "?", responseSchema: {} } as never } }]);
    (f.interaction.requestInput as any).mockRejectedValueOnce(new Error("unavailable"));
    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    (f.host.inspect as any).mockResolvedValueOnce(ok({ thread: proposal.thread, checkpoint: { state: "unknown", owner: "host", reason: "CHECKPOINT_DISPOSITION_UNOBSERVED" }, pendingSite: { state: "known", value: { kind: "ABSENT" } }, disposition: { state: "known", value: { kind: "ABSENT" } } }));
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });

    (f.host.inspect as any).mockResolvedValueOnce(ok({ thread: proposal.thread, checkpoint: { state: "known", value: proposal.checkpoint }, pendingSite: { state: "known", value: { kind: "ABSENT" } }, disposition: { state: "known", value: { kind: "ABSENT" } } }));
    (f.custody.recover as any).mockResolvedValueOnce(ok({ kind: "intervention-required", state: proposal.checkpoint.savepoint }));
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(f.host.recover).not.toHaveBeenCalled();

    (f.custody.recover as any).mockRejectedValueOnce(new Error("restore response lost"));
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
  });

  it("keeps interrupted publication pending until Custody inspection becomes known", async () => {
    const value = activation();
    const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value) }]);
    (f.host.start as any).mockImplementationOnce(async () => ok({ kind: "terminal-proposal", proposal: terminal(f.value) }));
    (f.custody.publish as any).mockRejectedValueOnce(new Error("call interrupted"));
    (f.custody.inspect as any).mockResolvedValueOnce(ok({ delivery: f.delivery, currentSavepoint: terminal(f.value).checkpoint.savepoint, preservedResult: { state: "known", value: f.preserved }, publication: { state: "unknown", owner: "custody", reason: "PUBLICATION_DISPOSITION_UNOBSERVED" } }));

    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(f.host.retire).not.toHaveBeenCalled();
  });

  it("fails closed on a terminal proposal with mismatched checkpoint correlation", async () => {
    const value = activation();
    const f = fixture([]);
    const proposal = terminal(f.value);
    const mismatched = { ...proposal, checkpoint: { ...proposal.checkpoint, thread: { ...proposal.thread, threadIdentity: "thread.other" as never } } };
    (f.host.start as any).mockResolvedValueOnce(ok({ kind: "terminal-proposal", proposal: mismatched }));
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
    expect(f.custody.preserveResult).not.toHaveBeenCalled();
  });

  it("keeps Host intervention and interrupted Host start distinct from Runtime outcomes", async () => {
    const intervention = fixture([]);
    const thread = terminal(intervention.value).thread;
    (intervention.host.start as any).mockResolvedValueOnce(ok({ kind: "intervention", intervention: { identity: "intervention.fixture", thread, reason: "RECOVERY_EXHAUSTED", checkpoint: { state: "unknown", owner: "host", reason: "CHECKPOINT_DISPOSITION_UNOBSERVED" } } }));
    expect(await intervention.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: intervention.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });

    const interrupted = fixture([]);
    (interrupted.host.start as any).mockRejectedValueOnce(new Error("lost start response"));
    expect(await interrupted.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: interrupted.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
  });

  it("does not publish when the terminal checkpoint has no known savepoint", async () => {
    const f = fixture([]);
    const proposal = terminal(f.value);
    const withoutSavepoint = { ...proposal, checkpoint: { ...proposal.checkpoint, savepoint: { state: "unknown", owner: "custody", reason: "CALL_INTERRUPTED" } } } as TerminalProposal;
    (f.host.start as any).mockResolvedValueOnce(ok({ kind: "terminal-proposal", proposal: withoutSavepoint }));
    (f.custody.preserveResult as any).mockResolvedValueOnce(ok({ ...f.preserved, savepoint: withoutSavepoint.checkpoint.savepoint }));
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(f.custody.publish).not.toHaveBeenCalled();
  });

  it("keeps a correlated bridge boundary stable when Host resume is interrupted", async () => {
    const value = activation();
    const proposal = terminal(value);
    const episode = { thread: proposal.thread, site: { kind: "node", nodeIdentity: "node.action" }, invocationIdentity: "invocation.fixture", attemptIdentity: "attempt.fixture" } as never;
    const f = fixture([{ kind: "action-input", wait: { checkpoint: proposal.checkpoint, episode, request: { identity: "input.fixture", episode, prompt: "?", responseSchema: {} } as never } }]);
    (f.host.resumeAction as any).mockRejectedValueOnce(new Error("resume interrupted"));
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(f.custody.preserveResult).not.toHaveBeenCalled();
  });

  it("returns typed public-seam errors for an unsupported version, missing state, and changed correlation", async () => {
    const f = fixture([]);
    expect(await f.adapter.execute({ interfaceVersion: "execution.runtime-adapter@wrong" as never, activation: f.value })).toEqual({ ok: false, error: { code: "ACTIVATION_REJECTED" } });
    expect(await f.adapter.inspect(f.delivery)).toEqual({ ok: false, error: { code: "ADAPTER_UNAVAILABLE" } });
    (f.host.start as any).mockResolvedValueOnce({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    const changed = { ...f.delivery, manifestBindingIdentity: sha("q") };
    expect(await f.adapter.inspect(changed)).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
    expect(await f.adapter.cancel(changed)).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
  });

  it("does not call an ambiguous Host start error a conclusive START_FAILED", async () => {
    const f = fixture([]);
    (f.host.start as any).mockResolvedValueOnce({ ok: false, error: { code: "ILLEGAL_SUCCESSOR" } });
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "unknown" } });
    expect(await f.adapter.inspect(f.delivery)).toMatchObject({ ok: true, value: { state: "running", result: { state: "known", value: { kind: "unknown" } } } });
  });

  it("rejects a known publication fact correlated to another target", async () => {
    const value = activation();
    const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value) }]);
    (f.host.start as any).mockImplementationOnce(async () => ok({ kind: "terminal-proposal", proposal: terminal(f.value) }));
    (f.custody.publish as any).mockResolvedValueOnce(ok({ kind: "published", reference: { ...f.published.reference, target: { identity: "target.other" } } }));
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
    expect(f.host.retire).not.toHaveBeenCalled();
  });

  it("fails closed when durable retirement state loses required terminal correlation", async () => {
    const value = activation();
    const f = fixture([{ kind: "terminal-proposal", proposal: terminal(value) }]);
    (f.host.start as any).mockImplementationOnce(async () => ok({ kind: "terminal-proposal", proposal: terminal(f.value) }));
    (f.host.retire as any).mockImplementation(async ({ authorization }: any) => ok({ owner: "host", authorization, state: "unknown", uncertainty: { state: "unknown", owner: "host", reason: "CALL_INTERRUPTED" } }));
    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    const recordPath = path.join(f.stateDirectory, readdirSync(f.stateDirectory)[0]!);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    delete record.proposal;
    writeFileSync(recordPath, JSON.stringify(record));
    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
  });

  it("restores the Host checkpoint savepoint before an admitted restart", async () => {
    const value = activation();
    const proposal = terminal(value);
    const episode = { thread: proposal.thread, site: { kind: "node", nodeIdentity: "node.action" }, invocationIdentity: "invocation.fixture", attemptIdentity: "attempt.fixture" } as never;
    const f = fixture([{ kind: "action-input", wait: { checkpoint: proposal.checkpoint, episode, request: { identity: "input.fixture", episode, prompt: "?", responseSchema: {} } as never } }]);
    (f.interaction.requestInput as any).mockRejectedValueOnce(new Error("unavailable"));
    await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value });
    const newer = { deliveryIdentity: f.delivery.deliveryIdentity, savepointIdentity: "savepoint.newer", gitTree: "tree.newer" } as never;
    (f.custody.inspect as any).mockResolvedValueOnce(ok({ delivery: f.delivery, currentSavepoint: { state: "known", value: newer }, preservedResult: { state: "unknown", owner: "custody", reason: "CALL_INTERRUPTED" }, publication: { state: "unknown", owner: "custody", reason: "PUBLICATION_DISPOSITION_UNOBSERVED" } }));
    (f.custody.recover as any).mockResolvedValueOnce(ok({ kind: "restored", savepoint: (proposal.checkpoint.savepoint as any).value }));
    (f.host.recover as any).mockResolvedValueOnce(ok({ kind: "terminal-proposal", proposal }));

    expect(await f.adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation: f.value })).toMatchObject({ ok: true, value: { kind: "terminal" } });
    expect(f.custody.recover).toHaveBeenCalledWith({ delivery: f.delivery, directive: "restore-from-savepoint", savepoint: proposal.checkpoint.savepoint });
    expect(f.host.recover).toHaveBeenCalledWith(expect.objectContaining({ directive: "restart-from-savepoint" }));
  });
});
