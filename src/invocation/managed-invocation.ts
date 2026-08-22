import { createHash } from "node:crypto";
import type {
  ActionInputRequest,
  ActionOutputSink,
  CoordinatorInvocationControl,
  DeliveryRef,
  FrozenJsonSchema,
  FrozenJsonValue,
  HostInvocation,
  InteractionReceiptRef,
  InvocationCallError,
  InvocationDispatch,
  InvocationDisposition,
  InvocationJournalRef,
  ManagedSessionRef,
  OwnerRetirementDisposition,
  Result,
  RetirementAuthorizationRef,
  Sha256,
} from "../contracts/index.js";
import type { DurableInvocationJournal, InvocationJournalStore } from "./journal.js";
import type {
  CredentialLeaseBroker,
  NativeProviderSession,
  NativeProviderSessionFactory,
  NativeTurnEvent,
} from "../providers/provider.js";

export interface ManagedInvocationOptions {
  readonly providers: Readonly<Record<string, NativeProviderSessionFactory>>;
  readonly credentials: CredentialLeaseBroker;
  readonly journal: InvocationJournalStore;
  readonly validateResult: (schema: FrozenJsonSchema, value: FrozenJsonValue) => boolean;
  readonly authorizeRetirement: (authorization: RetirementAuthorizationRef, delivery: DeliveryRef) => boolean;
}

export interface ManagedInvocation {
  readonly host: HostInvocation;
  readonly control: CoordinatorInvocationControl;
}

function digest(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function deliveryMatches(left: DeliveryRef, right: DeliveryRef): boolean {
  return left.deliveryIdentity === right.deliveryIdentity &&
    left.manifestBindingIdentity === right.manifestBindingIdentity &&
    left.activationBindingIdentity === right.activationBindingIdentity;
}

function episodeMatches(left: InvocationDispatch["episode"], right: InvocationDispatch["episode"]): boolean {
  return left.invocationIdentity === right.invocationIdentity &&
    left.attemptIdentity === right.attemptIdentity &&
    left.thread.threadIdentity === right.thread.threadIdentity &&
    deliveryMatches(left.thread.delivery, right.thread.delivery);
}

function reference(dispatch: InvocationDispatch): InvocationJournalRef {
  return {
    identity: `journal-${digest(dispatch.episode).slice("sha256:".length, "sha256:".length + 24)}` as InvocationJournalRef["identity"],
    episode: dispatch.episode,
  };
}

function managedSession(dispatch: InvocationDispatch, opaqueIdentity: string, generation: number): ManagedSessionRef {
  return {
    bindingIdentity: `session-${digest({ affinity: dispatch.session.identity, opaqueIdentity }).slice("sha256:".length, "sha256:".length + 24)}` as ManagedSessionRef["bindingIdentity"],
    affinity: dispatch.session,
    generation,
  };
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((result, secret) => secret === "" ? result : result.split(secret).join("[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child, secrets)]));
  }
  return value;
}

function validateDispatch(dispatch: InvocationDispatch): InvocationCallError | undefined {
  if (dispatch.plan.actionIdentity !== dispatch.action.identity || dispatch.plan.executorIdentity !== dispatch.executor.identity) {
    return { code: "EXECUTOR_BINDING_MISMATCH" };
  }
  if (dispatch.session.sessionCompatibilityIdentity !== dispatch.executor.sessionCompatibilityIdentity) return { code: "SESSION_AFFINITY_MISMATCH" };
  if (!deliveryMatches(dispatch.session.delivery, dispatch.episode.thread.delivery)) return { code: "CORRELATION_MISMATCH" };
  if (dispatch.workspace.kind === "write" && !episodeMatches(dispatch.workspace.handle.episode, dispatch.episode)) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.workspace.kind === "read" && !episodeMatches(dispatch.workspace.view.episode, dispatch.episode)) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.workspace.kind === "none" && dispatch.executor.turn.access.length > 0) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.workspace.kind === "read" && dispatch.executor.turn.access.some((access) => access.mode === "write")) return { code: "CAPABILITY_MISMATCH" };
  if (!dispatch.executor.session.providedCapabilities.includes("structured-completion")) return { code: "CAPABILITY_MISMATCH" };
  return undefined;
}

function ok<T>(value: T): Result<T, InvocationCallError> {
  return { ok: true, value };
}

function failed(error: InvocationCallError): Result<never, InvocationCallError> {
  return { ok: false, error };
}

export function createManagedInvocation(options: ManagedInvocationOptions): ManagedInvocation {
  const live = new Map<string, NativeProviderSession>();

  async function consume(
    journal: DurableInvocationJournal,
    session: NativeProviderSession,
    input: unknown,
    output: ActionOutputSink,
    secrets: readonly string[],
  ): Promise<InvocationDisposition> {
    let nextSequence = journal.nextOutputSequence;
    let pending: ActionInputRequest | undefined;
    const completions: FrozenJsonValue[] = [];
    let providerFailure: Extract<NativeTurnEvent, { kind: "provider-failed" }> | undefined;
    const redactedEvents = [...journal.redactedEvents];
    let events: readonly NativeTurnEvent[];
    try {
      events = await session.run(input);
    } catch (error) {
      events = [{ kind: "provider-failed", code: "PROVIDER_PROTOCOL_ERROR", detail: error instanceof Error ? error.message : String(error) }];
    }
    for (const event of events) {
      redactedEvents.push(redact(event, secrets));
      if (event.kind === "output") {
        const published = await output.publish({ episode: journal.reference.episode, sequence: nextSequence, content: event.content });
        nextSequence += 1;
        if (!published.ok) {
          providerFailure = {
            kind: "provider-failed",
            code: published.error.code === "INTERACTION_CANCELLED" ? "ACTION_INTERACTION_CANCELLED" : "ACTION_INTERACTION_UNAVAILABLE",
            detail: published.error,
          };
        }
      } else if (event.kind === "structured-completion") {
        completions.push(event.result);
      } else if (event.kind === "input-request") {
        if (pending !== undefined) {
          completions.splice(0);
          providerFailure = { kind: "provider-failed", code: "PROVIDER_PROTOCOL_ERROR", detail: "multiple pending input requests" };
        } else {
          pending = {
            identity: event.requestIdentity as ActionInputRequest["identity"],
            episode: journal.reference.episode,
            prompt: event.prompt,
            responseSchema: event.responseSchema,
          };
        }
      } else if (event.kind === "provider-failed") {
        providerFailure = event;
      } else if (event.kind === "process-exited") {
        providerFailure = { kind: "provider-failed", code: "PROVIDER_EXITED", detail: "provider process exited without a structured disposition" };
      }
    }

    await session.persist();
    const base = { ...journal, nextOutputSequence: nextSequence, redactedEvents };
    if (providerFailure !== undefined) {
      const saved = { ...base, status: "failed" as const, pendingInput: undefined };
      await options.journal.save(saved);
      return {
        kind: "failed",
        episode: journal.reference.episode,
        failure: { code: providerFailure.code, retry: "same-episode", detail: redact({ detail: providerFailure.detail }, secrets) as never },
        session: { state: "known", value: journal.session },
        journal: journal.reference,
      };
    }
    if (completions.length > 1) {
      await options.journal.save({ ...base, status: "invalid", pendingInput: undefined });
      return { kind: "invalid", episode: journal.reference.episode, violation: { code: "DUPLICATE_COMPLETION", detail: {} }, session: journal.session, journal: journal.reference };
    }
    const completion = completions[0];
    if (completion !== undefined && pending !== undefined) {
      await options.journal.save({ ...base, status: "invalid", pendingInput: pending });
      return { kind: "invalid", episode: journal.reference.episode, violation: { code: "PENDING_INPUT_AT_COMPLETION", detail: {} }, session: journal.session, journal: journal.reference };
    }
    if (completion !== undefined) {
      const valid = options.validateResult(journal.dispatch.action.resultSchema, completion);
      await options.journal.save({ ...base, status: valid ? "completed" : "invalid", pendingInput: undefined });
      if (!valid) return { kind: "invalid", episode: journal.reference.episode, violation: { code: "RESULT_SCHEMA_INVALID", detail: {} }, session: journal.session, journal: journal.reference };
      return { kind: "completed", episode: journal.reference.episode, result: completion, session: journal.session, interactionReceipts: journal.interactionReceipts, journal: journal.reference };
    }
    if (pending !== undefined) {
      await options.journal.save({ ...base, status: "awaiting-input", pendingInput: pending });
      return { kind: "awaiting-input", episode: journal.reference.episode, request: pending, session: journal.session, journal: journal.reference };
    }
    await options.journal.save({ ...base, status: "invalid", pendingInput: undefined });
    return { kind: "invalid", episode: journal.reference.episode, violation: { code: "TURN_ENDED_WITHOUT_DISPOSITION", detail: {} }, session: journal.session, journal: journal.reference };
  }

  const host: HostInvocation = {
    async start(dispatch, output) {
      const validationError = validateDispatch(dispatch);
      if (validationError !== undefined) return failed(validationError);
      if (await options.journal.load(dispatch.episode.invocationIdentity) !== undefined) return failed({ code: "CORRELATION_MISMATCH" });
      const provider = options.providers[dispatch.executor.session.driver.providerIdentity];
      if (provider === undefined) return failed({ code: "PROVIDER_NOT_IMPLEMENTED" });
      let lease;
      try {
        lease = await options.credentials.acquire(dispatch);
      } catch {
        return failed({ code: "CREDENTIAL_ACQUISITION_FAILED" });
      }
      const controller = new AbortController();
      let session: NativeProviderSession | undefined;
      try {
        session = await provider.open({ dispatch, credentials: lease.material, signal: controller.signal });
        live.set(dispatch.episode.invocationIdentity, session);
        const journal: DurableInvocationJournal = {
          reference: reference(dispatch),
          dispatch,
          session: managedSession(dispatch, session.opaqueIdentity, 1),
          opaqueNativeSessionIdentity: session.opaqueIdentity,
          status: "running",
          nextOutputSequence: 0,
          interactionReceipts: [],
          redactedEvents: [],
        };
        await options.journal.save(journal);
        return ok(await consume(journal, session, dispatch.input, output, Object.values(lease.material)));
      } catch (error) {
        if (error !== null && typeof error === "object" && (error as { code?: unknown }).code === "PROVIDER_NOT_IMPLEMENTED") {
          return failed({ code: "PROVIDER_NOT_IMPLEMENTED" });
        }
        if (session !== undefined) {
          return ok({
            kind: "unknown",
            episode: dispatch.episode,
            uncertainty: { state: "unknown", owner: "invocation", reason: "CALL_INTERRUPTED" },
            session: { state: "known", value: managedSession(dispatch, session.opaqueIdentity, 1) },
            journal: { state: "unknown", owner: "invocation", reason: "CALL_INTERRUPTED" },
          });
        }
        return ok({
          kind: "failed",
          episode: dispatch.episode,
          failure: { code: "PROVIDER_PROTOCOL_ERROR", retry: "new-attempt", detail: { message: "provider start failed" } },
          session: { state: "unknown", owner: "invocation", reason: "CALL_INTERRUPTED" },
          journal: reference(dispatch),
        });
      } finally {
        live.delete(dispatch.episode.invocationIdentity);
        await session?.dispose().catch(() => undefined);
        await lease.release().catch(() => undefined);
      }
    },

    async continueWithInput(request, output) {
      const journal = await options.journal.load(request.episode.invocationIdentity);
      if (journal === undefined || !episodeMatches(journal.reference.episode, request.episode) || journal.pendingInput?.identity !== request.response.requestIdentity || journal.status !== "awaiting-input") {
        return failed({ code: "CORRELATION_MISMATCH" });
      }
      if (request.response.contentIdentity !== digest(request.response.content) || !options.validateResult(journal.pendingInput.responseSchema, request.response.content)) {
        await options.journal.save({ ...journal, status: "invalid", pendingInput: undefined });
        return ok({
          kind: "invalid",
          episode: request.episode,
          violation: { code: "INTERACTION_CORRELATION_INVALID", detail: {} },
          session: journal.session,
          journal: journal.reference,
        });
      }
      const provider = options.providers[journal.dispatch.executor.session.driver.providerIdentity];
      if (provider === undefined) return failed({ code: "PROVIDER_NOT_IMPLEMENTED" });
      let lease;
      try {
        lease = await options.credentials.acquire(journal.dispatch);
      } catch {
        return failed({ code: "CREDENTIAL_ACQUISITION_FAILED" });
      }
      const controller = new AbortController();
      let session: NativeProviderSession | undefined;
      try {
        session = await provider.restore({
          opaqueIdentity: journal.opaqueNativeSessionIdentity,
          dispatch: journal.dispatch,
          credentials: lease.material,
          signal: controller.signal,
        });
      } catch {
        const unknownJournal = { ...journal, status: "unknown" as const, pendingInput: journal.pendingInput };
        await options.journal.save(unknownJournal);
        await lease.release().catch(() => undefined);
        return ok({
          kind: "unknown",
          episode: request.episode,
          uncertainty: { state: "unknown", owner: "invocation", reason: "CHILD_UNREACHABLE" },
          session: { state: "known", value: journal.session },
          journal: { state: "known", value: journal.reference },
        });
      }
      try {
        live.set(request.episode.invocationIdentity, session);
        const receipt: InteractionReceiptRef = {
          identity: `receipt-${digest(request.response).slice("sha256:".length, "sha256:".length + 24)}` as InteractionReceiptRef["identity"],
          requestIdentity: request.response.requestIdentity,
          responseIdentity: request.response.contentIdentity,
        };
        const resumedJournal: DurableInvocationJournal = {
          ...journal,
          status: "running",
          pendingInput: undefined,
          interactionReceipts: [...journal.interactionReceipts, receipt],
        };
        await options.journal.save(resumedJournal);
        return ok(await consume(resumedJournal, session, { kind: "interaction-response", response: request.response }, output, Object.values(lease.material)));
      } catch {
        return ok({
          kind: "unknown",
          episode: request.episode,
          uncertainty: { state: "unknown", owner: "invocation", reason: "CALL_INTERRUPTED" },
          session: { state: "known", value: journal.session },
          journal: { state: "unknown", owner: "invocation", reason: "CALL_INTERRUPTED" },
        });
      } finally {
        live.delete(request.episode.invocationIdentity);
        await session.dispose().catch(() => undefined);
        await lease.release().catch(() => undefined);
      }
    },
  };

  async function journalsFor(delivery: DeliveryRef): Promise<readonly DurableInvocationJournal[]> {
    return (await options.journal.list()).filter((journal) => deliveryMatches(journal.reference.episode.thread.delivery, delivery));
  }

  const control: CoordinatorInvocationControl = {
    async inspect(delivery) {
      const journals = await journalsFor(delivery);
      const process = journals.some((journal) => journal.status === "running" || journal.status === "awaiting-input") ? "running" :
        journals.some((journal) => journal.status === "completed" || journal.status === "failed" || journal.status === "invalid") ? "terminal" : "stopped";
      return ok({
        delivery,
        process: { state: "known", value: process },
        sessions: { state: "known", value: journals.map((journal) => journal.session) },
        journals: { state: "known", value: journals.map((journal) => journal.reference) },
      });
    },

    async cancel(request) {
      const journals = await journalsFor(request.delivery);
      for (const journal of journals) {
        if (journal.status !== "running" && journal.status !== "awaiting-input") continue;
        await live.get(journal.reference.episode.invocationIdentity)?.cancel().catch(() => undefined);
        await options.journal.save({ ...journal, status: "cancelled", pendingInput: undefined });
      }
      const process = journals.some((journal) => journal.status === "running" || journal.status === "awaiting-input") ? "stopped" :
        journals.some((journal) => journal.status === "completed" || journal.status === "failed" || journal.status === "invalid") ? "terminal" : "stopped";
      return ok({
        delivery: request.delivery,
        process: { state: "known", value: process },
        sessions: { state: "known", value: journals.map((journal) => journal.session) },
        journals: { state: "known", value: journals.map((journal) => journal.reference) },
      });
    },

    async retire(authorization) {
      const allJournals = await options.journal.list();
      const deliveryJournal = allJournals.find((journal) => journal.reference.episode.thread.delivery.deliveryIdentity === authorization.delivery.deliveryIdentity);
      if (deliveryJournal === undefined || !deliveryMatches(deliveryJournal.reference.episode.thread.delivery, authorization.delivery) || !options.authorizeRetirement(authorization, deliveryJournal.reference.episode.thread.delivery)) {
        return failed({ code: "RETIREMENT_NOT_AUTHORIZED" });
      }
      const journals = allJournals.filter((journal) => deliveryMatches(journal.reference.episode.thread.delivery, authorization.delivery));
      for (const journal of journals) {
        if (live.has(journal.reference.episode.invocationIdentity)) return failed({ code: "RETIREMENT_NOT_AUTHORIZED" });
      }
      await Promise.all(journals.map((journal) => options.journal.delete(journal.reference.episode.invocationIdentity)));
      const value: OwnerRetirementDisposition = {
        reference: {
          identity: `invocation-retirement-${digest(authorization).slice("sha256:".length, "sha256:".length + 24)}` as never,
          owner: "invocation",
          authorization,
        },
        state: "retired",
      };
      return ok(value);
    },
  };

  return Object.freeze({ host, control });
}
