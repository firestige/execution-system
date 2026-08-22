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

function authorizationMatches(left: RetirementAuthorizationRef, right: RetirementAuthorizationRef): boolean {
  return left.identity === right.identity && deliveryMatches(left.delivery, right.delivery);
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
  if (digest(dispatch.executor.session) !== dispatch.executor.sessionCompatibilityIdentity) return { code: "SESSION_AFFINITY_MISMATCH" };
  if (digest({ session: dispatch.executor.session, turn: dispatch.executor.turn }) !== dispatch.executor.bindingIdentity) return { code: "EXECUTOR_BINDING_MISMATCH" };
  if (digest({ site: dispatch.episode.site, action: dispatch.action, executorBindingIdentity: dispatch.executor.bindingIdentity }) !== dispatch.plan.bindingIdentity) return { code: "EXECUTOR_BINDING_MISMATCH" };
  if (dispatch.session.sessionCompatibilityIdentity !== dispatch.executor.sessionCompatibilityIdentity) return { code: "SESSION_AFFINITY_MISMATCH" };
  if (digest({
    deliveryIdentity: dispatch.session.delivery.deliveryIdentity,
    sessionCompatibilityIdentity: dispatch.session.sessionCompatibilityIdentity,
    scopeValueIdentity: dispatch.session.scopeValueIdentity,
    isolation: dispatch.session.isolation,
  }) !== dispatch.session.identity) return { code: "SESSION_AFFINITY_MISMATCH" };
  if (!deliveryMatches(dispatch.session.delivery, dispatch.episode.thread.delivery)) return { code: "CORRELATION_MISMATCH" };
  if (dispatch.workspace.kind === "write" && !episodeMatches(dispatch.workspace.handle.episode, dispatch.episode)) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.workspace.kind === "read" && !episodeMatches(dispatch.workspace.view.episode, dispatch.episode)) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.workspace.kind === "write" && dispatch.workspace.handle.accessDigest !== digest(dispatch.executor.turn.access)) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.workspace.kind === "read" && dispatch.workspace.view.accessDigest !== digest(dispatch.executor.turn.access)) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.workspace.kind === "none" && dispatch.executor.turn.access.length > 0) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.workspace.kind === "read" && dispatch.executor.turn.access.some((access) => access.mode === "write")) return { code: "CAPABILITY_MISMATCH" };
  if (!dispatch.executor.session.providedCapabilities.includes("structured-completion")) return { code: "CAPABILITY_MISMATCH" };
  if (dispatch.executor.session.model.providerModelIdentity.length === 0) return { code: "MODEL_BINDING_MISMATCH" };
  if (dispatch.executor.session.driver.providerIdentity === "dsh-headless") {
    const providerRoute = (dispatch.executor.session.driver.configuration as Record<string, unknown>).providerRoute;
    if (typeof providerRoute !== "string" || providerRoute.length === 0) return { code: "MODEL_BINDING_MISMATCH" };
  }
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

  function cancelledDisposition(journal: DurableInvocationJournal): InvocationDisposition {
    return {
      kind: "failed",
      episode: journal.reference.episode,
      failure: { code: "PROVIDER_CANCELLED", retry: "same-episode", detail: {} },
      session: { state: "known", value: journal.session },
      journal: journal.reference,
    };
  }

  async function commitUnlessCancelled(next: DurableInvocationJournal): Promise<boolean> {
    const observed = await options.journal.update(next.reference.episode.invocationIdentity, (current) =>
      current?.status === "cancelled" ? current : next);
    return observed?.status !== "cancelled";
  }

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
      if (!await commitUnlessCancelled(saved)) return cancelledDisposition(journal);
      return {
        kind: "failed",
        episode: journal.reference.episode,
        failure: { code: providerFailure.code, retry: "same-episode", detail: redact({ detail: providerFailure.detail }, secrets) as never },
        session: { state: "known", value: journal.session },
        journal: journal.reference,
      };
    }
    if (completions.length > 1) {
      if (!await commitUnlessCancelled({ ...base, status: "invalid", pendingInput: undefined })) return cancelledDisposition(journal);
      return { kind: "invalid", episode: journal.reference.episode, violation: { code: "DUPLICATE_COMPLETION", detail: {} }, session: journal.session, journal: journal.reference };
    }
    const completion = completions[0];
    if (completion !== undefined && pending !== undefined) {
      if (!await commitUnlessCancelled({ ...base, status: "invalid", pendingInput: pending })) return cancelledDisposition(journal);
      return { kind: "invalid", episode: journal.reference.episode, violation: { code: "PENDING_INPUT_AT_COMPLETION", detail: {} }, session: journal.session, journal: journal.reference };
    }
    if (completion !== undefined) {
      const valid = options.validateResult(journal.dispatch.action.resultSchema, completion);
      if (!await commitUnlessCancelled({ ...base, status: valid ? "completed" : "invalid", pendingInput: undefined })) return cancelledDisposition(journal);
      if (!valid) return { kind: "invalid", episode: journal.reference.episode, violation: { code: "RESULT_SCHEMA_INVALID", detail: {} }, session: journal.session, journal: journal.reference };
      return { kind: "completed", episode: journal.reference.episode, result: completion, session: journal.session, interactionReceipts: journal.interactionReceipts, journal: journal.reference };
    }
    if (pending !== undefined) {
      if (!journal.dispatch.executor.session.providedCapabilities.includes("action-interaction")) {
        const denied = { ...base, status: "failed" as const, pendingInput: undefined };
        if (!await commitUnlessCancelled(denied)) return cancelledDisposition(journal);
        return {
          kind: "failed",
          episode: journal.reference.episode,
          failure: { code: "PROVIDER_PROTOCOL_ERROR", retry: "never", detail: { reason: "action interaction capability not admitted" } },
          session: { state: "known", value: journal.session },
          journal: journal.reference,
        };
      }
      if (!await commitUnlessCancelled({ ...base, status: "awaiting-input", pendingInput: pending })) return cancelledDisposition(journal);
      return { kind: "awaiting-input", episode: journal.reference.episode, request: pending, session: journal.session, journal: journal.reference };
    }
    if (!await commitUnlessCancelled({ ...base, status: "invalid", pendingInput: undefined })) return cancelledDisposition(journal);
    return { kind: "invalid", episode: journal.reference.episode, violation: { code: "TURN_ENDED_WITHOUT_DISPOSITION", detail: {} }, session: journal.session, journal: journal.reference };
  }

  const host: HostInvocation = {
    async start(dispatch, output) {
      const validationError = validateDispatch(dispatch);
      if (validationError !== undefined) return failed(validationError);
      const provider = options.providers[dispatch.executor.session.driver.providerIdentity];
      if (provider === undefined) return failed({ code: "PROVIDER_NOT_IMPLEMENTED" });
      const affinity = await options.journal.loadAffinity(dispatch.session.identity);
      if (affinity !== undefined && (
        affinity.affinity.sessionCompatibilityIdentity !== dispatch.session.sessionCompatibilityIdentity ||
        affinity.affinity.scopeValueIdentity !== dispatch.session.scopeValueIdentity ||
        affinity.affinity.isolation !== dispatch.session.isolation ||
        !deliveryMatches(affinity.affinity.delivery, dispatch.session.delivery)
      )) return failed({ code: "SESSION_AFFINITY_MISMATCH" });
      const generation = (affinity?.generation ?? 0) + 1;
      const reservedSession = affinity === undefined
        ? managedSession(dispatch, "pending-native-session", generation)
        : { bindingIdentity: affinity.bindingIdentity, affinity: dispatch.session, generation };
      const reservation: DurableInvocationJournal = {
        reference: reference(dispatch),
        dispatch,
        session: reservedSession,
        opaqueNativeSessionIdentity: affinity?.opaqueNativeSessionIdentity ?? "",
        status: "starting",
        nextOutputSequence: 0,
        interactionReceipts: [],
        redactedEvents: [],
      };
      if (!await options.journal.create(reservation)) return failed({ code: "CORRELATION_MISMATCH" });
      let lease;
      try {
        lease = await options.credentials.acquire(dispatch);
      } catch {
        await options.journal.delete(dispatch.episode.invocationIdentity);
        return failed({ code: "CREDENTIAL_ACQUISITION_FAILED" });
      }
      const controller = new AbortController();
      let session: NativeProviderSession | undefined;
      let activeJournal: DurableInvocationJournal | undefined;
      try {
        session = affinity === undefined
          ? await provider.open({ dispatch, credentials: lease.material, signal: controller.signal })
          : await provider.restore({ opaqueIdentity: affinity.opaqueNativeSessionIdentity, dispatch, credentials: lease.material, signal: controller.signal });
        if (affinity !== undefined && session.opaqueIdentity !== affinity.opaqueNativeSessionIdentity) throw new Error("provider restored a different native session identity");
        live.set(dispatch.episode.invocationIdentity, session);
        const journal: DurableInvocationJournal = {
          ...reservation,
          session: affinity === undefined ? managedSession(dispatch, session.opaqueIdentity, generation) : reservedSession,
          opaqueNativeSessionIdentity: session.opaqueIdentity,
          status: "running",
        };
        const activated = await options.journal.update(dispatch.episode.invocationIdentity, (current) =>
          current?.status === "starting" ? journal : current);
        if (activated?.status === "cancelled") {
          await session.cancel().catch(() => undefined);
          return ok(cancelledDisposition({ ...journal, status: "cancelled" }));
        }
        if (activated?.status !== "running") throw new Error("invocation start journal state is unavailable");
        activeJournal = activated;
        await options.journal.bindAffinity({
          affinity: dispatch.session,
          opaqueNativeSessionIdentity: session.opaqueIdentity,
          bindingIdentity: activated.session.bindingIdentity,
          generation,
        });
        return ok(await consume(activated, session, dispatch.input, output, Object.values(lease.material)));
      } catch (error) {
        if (error !== null && typeof error === "object" && (error as { code?: unknown }).code === "PROVIDER_NOT_IMPLEMENTED") {
          await options.journal.delete(dispatch.episode.invocationIdentity);
          return failed({ code: "PROVIDER_NOT_IMPLEMENTED" });
        }
        if (session !== undefined) {
          const lastKnownJournal = activeJournal ?? reservation;
          const observed = await options.journal.update(dispatch.episode.invocationIdentity, (current) => current?.status === "cancelled" ? current : { ...lastKnownJournal, status: "unknown" });
          if (observed?.status === "cancelled") return ok(cancelledDisposition(observed));
          return ok({
            kind: "unknown",
            episode: dispatch.episode,
            uncertainty: { state: "unknown", owner: "invocation", reason: "CALL_INTERRUPTED" },
            session: { state: "known", value: lastKnownJournal.session },
            journal: { state: "unknown", owner: "invocation", reason: "CALL_INTERRUPTED" },
          });
        }
        const observed = await options.journal.update(dispatch.episode.invocationIdentity, (current) => current?.status === "cancelled" ? current : { ...reservation, status: "failed" });
        if (observed?.status === "cancelled") return ok(cancelledDisposition(observed));
        if (affinity !== undefined) {
          return ok({
            kind: "unknown",
            episode: dispatch.episode,
            uncertainty: { state: "unknown", owner: "invocation", reason: "CHILD_UNREACHABLE" },
            session: { state: "known", value: reservedSession },
            journal: { state: "known", value: reservation.reference },
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
        if (!await commitUnlessCancelled({ ...journal, status: "invalid", pendingInput: undefined })) return ok(cancelledDisposition(journal));
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
        if (session.opaqueIdentity !== journal.opaqueNativeSessionIdentity) throw new Error("provider restored a different native session identity");
      } catch {
        const unknownJournal = { ...journal, status: "unknown" as const, pendingInput: journal.pendingInput };
        if (!await commitUnlessCancelled(unknownJournal)) {
          await lease.release().catch(() => undefined);
          return ok(cancelledDisposition(journal));
        }
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
        const activated = await options.journal.update(request.episode.invocationIdentity, (current) =>
          current?.status === "awaiting-input" ? resumedJournal : current);
        if (activated?.status === "cancelled") {
          await session.cancel().catch(() => undefined);
          return ok(cancelledDisposition(journal));
        }
        if (activated?.status !== "running") return failed({ code: "SESSION_STATE_UNKNOWN" });
        return ok(await consume(activated, session, { kind: "interaction-response", response: request.response }, output, Object.values(lease.material)));
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
      const process = journals.some((journal) => journal.status === "starting" || journal.status === "running") ? "running" :
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
        if (journal.status !== "starting" && journal.status !== "running" && journal.status !== "awaiting-input") continue;
        const cancelled = await options.journal.update(journal.reference.episode.invocationIdentity, (current) =>
          current !== undefined && (current.status === "starting" || current.status === "running" || current.status === "awaiting-input")
            ? { ...current, status: "cancelled", pendingInput: undefined }
            : current);
        if (cancelled?.status === "cancelled") await live.get(journal.reference.episode.invocationIdentity)?.cancel().catch(() => undefined);
      }
      const process = journals.some((journal) => journal.status === "starting" || journal.status === "running" || journal.status === "awaiting-input") ? "stopped" :
        journals.some((journal) => journal.status === "completed" || journal.status === "failed" || journal.status === "invalid") ? "terminal" : "stopped";
      return ok({
        delivery: request.delivery,
        process: { state: "known", value: process },
        sessions: { state: "known", value: journals.map((journal) => journal.session) },
        journals: { state: "known", value: journals.map((journal) => journal.reference) },
      });
    },

    async retire(authorization) {
      return options.journal.serializeRetirement(authorization.delivery.deliveryIdentity, async () => {
        const retired = await options.journal.loadRetirement(authorization.delivery.deliveryIdentity);
        if (retired !== undefined) {
          return authorizationMatches(retired.disposition.authorization, authorization)
            ? ok(retired.disposition)
            : failed({ code: "RETIREMENT_NOT_AUTHORIZED" });
        }
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
        await Promise.all([...new Set(journals.map((journal) => journal.session.affinity.identity))].map((identity) => options.journal.deleteAffinity(identity)));
        const value: OwnerRetirementDisposition<"invocation"> = {
          owner: "invocation",
          authorization,
          state: "retired",
        };
        const tombstone = await options.journal.saveRetirement({ disposition: value });
        return authorizationMatches(tombstone.disposition.authorization, authorization)
          ? ok(tombstone.disposition)
          : failed({ code: "RETIREMENT_NOT_AUTHORIZED" });
      });
    },
  };

  return Object.freeze({ host, control });
}
