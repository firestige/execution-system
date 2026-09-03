import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  ActionInteractionBridge,
  CompileRunnerActivation,
  CoordinatorCustody,
  CoordinatorHost,
  CoordinatorInvocationControl,
  DeliveryRef,
  FrozenJsonObject,
  HostDisposition,
  HostInterventionRef,
  ImplementationId,
  KnownOwnerRetirements,
  Knowledge,
  OwnerRetirementDisposition,
  PreservedResultRef,
  PublicationDisposition,
  PublicationGuardRef,
  PublicationTargetRef,
  Result,
  RetirementAuthorizationRef,
  RetirementOwner,
  RunnerActivationContext,
  SettlementId,
  TerminalProposal,
  TerminalSettlementRecord,
  ThreadRef,
  UnknownState,
  WorkflowControlBridge,
} from "../contracts/index.js";
import type {
  ExecutionRuntimeAdapter,
  ExecutionRuntimeAdapterError,
  ExecutionRuntimeCancellation,
  ExecutionRuntimeExecuteRequest,
  ExecutionRuntimeInspection,
  ExecutionRuntimeResult,
} from "../execution/runtime-adapter.js";
import { EXECUTION_RUNTIME_ADAPTER_VERSION } from "../execution/runtime-adapter.js";

export interface RunnerObservationPort {
  observe(event: Readonly<{ kind: "runner-terminal-settled"; delivery: DeliveryRef; settlementIdentity: SettlementId }>): Promise<void>;
}

export interface RunnerStartCorrelationFact {
  readonly schemaVersion: "runner.start-correlation@1.0.0";
  readonly delivery: DeliveryRef;
}

export interface RunnerStartCorrelationPort {
  acknowledge(fact: RunnerStartCorrelationFact): Promise<
    | Readonly<{ ok: true; value: undefined }>
    | Readonly<{ ok: false; error: Readonly<{ code: "CORRELATION_MISMATCH" }> }>
  >;
}

export interface RunnerCoordinatorOptions {
  readonly stateDirectory: string;
  readonly compiler: CompileRunnerActivation;
  readonly host: CoordinatorHost;
  readonly invocation: CoordinatorInvocationControl;
  readonly custody: CoordinatorCustody;
  readonly interaction: ActionInteractionBridge;
  readonly workflow: WorkflowControlBridge;
  readonly observation: RunnerObservationPort;
  readonly startCorrelation: RunnerStartCorrelationPort;
  readonly publicationTarget: PublicationTargetRef;
  readonly implementationIdentity: ImplementationId;
}

type Phase = "start-pending" | "start-acknowledged" | "running" | "stable" | "publication-pending" | "intervention" | "retiring" | "terminal" | "start-failed";

interface DurableCoordinatorRecord {
  readonly delivery: DeliveryRef;
  readonly profileIdentity: RunnerActivationContext["correlation"]["runtimeProfileIdentity"];
  readonly snapshotIdentity: RunnerActivationContext["correlation"]["snapshotIdentity"];
  readonly contractIdentity: RunnerActivationContext["admission"]["contractRevision"];
  readonly startCorrelation: RunnerStartCorrelationFact;
  phase: Phase;
  thread?: ThreadRef;
  proposal?: TerminalProposal;
  preserved?: PreservedResultRef;
  publication?: PublicationDisposition;
  authorization?: RetirementAuthorizationRef;
  retirements: Partial<Record<RetirementOwner, OwnerRetirementDisposition>>;
  result?: ExecutionRuntimeResult;
  cancelRequested?: true;
  intervention?: HostInterventionRef;
}

type RuntimeCallResult = Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>;

// The frozen trusted-local current-slot owner excludes concurrent cross-process
// coordinators. These maps coordinate overlapping instances in this process;
// collision-free candidates prevent physical temp-name aliasing.
const TERMINAL_RECONCILIATIONS = new Map<string, Promise<RuntimeCallResult>>();
const RETIREMENT_RECONCILIATIONS = new Map<string, Promise<RuntimeCallResult>>();

const success = <T>(value: T): Result<T, ExecutionRuntimeAdapterError> => ({ ok: true, value });
const failure = (code: ExecutionRuntimeAdapterError["code"]): Result<never, ExecutionRuntimeAdapterError> => ({ ok: false, error: { code } });
const known = <T>(value: T): Knowledge<T> => ({ state: "known", value });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableId<T extends string>(prefix: string, value: unknown): T {
  return `${prefix}-${createHash("sha256").update(canonical(value)).digest("hex")}` as T;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function deliveryFrom(activation: RunnerActivationContext): DeliveryRef {
  return {
    deliveryIdentity: activation.correlation.deliveryIdentity,
    manifestBindingIdentity: activation.correlation.manifestBindingIdentity,
    activationBindingIdentity: activation.bindingIdentity,
  };
}

function startCorrelationFact(delivery: DeliveryRef): RunnerStartCorrelationFact {
  return deepFreeze({ schemaVersion: "runner.start-correlation@1.0.0", delivery });
}

function safelyCorrelatedDelivery(activation: RunnerActivationContext): DeliveryRef | undefined {
  const correlation = activation?.correlation;
  if (typeof correlation?.deliveryIdentity !== "string" || correlation.deliveryIdentity.length === 0
    || typeof correlation.manifestBindingIdentity !== "string" || !/^sha256:[a-f0-9]{64}$/.test(correlation.manifestBindingIdentity)
    || typeof activation?.bindingIdentity !== "string" || !/^sha256:[a-f0-9]{64}$/.test(activation.bindingIdentity)) return undefined;
  return deliveryFrom(activation);
}

function unknown(owner: UnknownState["owner"], reason: UnknownState["reason"]): UnknownState {
  return { state: "unknown", owner, reason };
}

function detail(reason: string, diagnostic?: Readonly<{ stage: string; causeCode: string }>): FrozenJsonObject {
  return Object.freeze(diagnostic === undefined ? { reason } : { reason, ...diagnostic });
}

const HOST_ERROR_CODES = new Set([
  "ACTIVATION_MISMATCH", "ILLEGAL_SUCCESSOR", "DATAFLOW_BINDING_INVALID", "CHECKPOINT_ORDER_VIOLATION",
  "CONTROL_MISMATCH", "ACTION_INPUT_MISMATCH", "RECOVERY_NOT_ADMITTED", "RETIREMENT_NOT_AUTHORIZED",
  "CORRELATION_MISMATCH", "BASELINE_MISSING", "GIT_STATE_MISMATCH", "WORKSPACE_SNAPSHOT_CAPACITY_EXCEEDED",
  "READ_VIEW_INVALID", "PUBLICATION_GUARD_INVALID",
]);

function typedHostCause(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" && HOST_ERROR_CODES.has(code) ? code : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class RunnerCoordinator implements ExecutionRuntimeAdapter {
  readonly #options: RunnerCoordinatorOptions;

  constructor(options: RunnerCoordinatorOptions) {
    this.#options = options;
    mkdirSync(options.stateDirectory, { recursive: true });
  }

  async execute(request: ExecutionRuntimeExecuteRequest): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    if (request.interfaceVersion !== EXECUTION_RUNTIME_ADAPTER_VERSION) return failure("ACTIVATION_REJECTED");
    const delivery = safelyCorrelatedDelivery(request.activation);
    if (delivery === undefined) return failure("ACTIVATION_REJECTED");
    let record: DurableCoordinatorRecord | undefined;
    try { record = this.#load(delivery); } catch { return failure("ADAPTER_UNAVAILABLE"); }
    if (record !== undefined && !same(record.delivery, delivery)) return failure("CORRELATION_MISMATCH");
    if (record?.phase === "terminal" || record?.phase === "start-failed") return success(deepFreeze(record.result!));
    if (record?.phase === "retiring") return this.#retireAndSettle(record);
    if (record?.phase === "publication-pending") return this.#reconcilePublication(record);
    if (record?.phase === "intervention") return this.#persistUnknown(record, "INTERVENTION_REQUIRED");
    if (record?.phase === "start-pending" || record?.phase === "start-acknowledged") {
      const compiled = this.#options.compiler(request.activation);
      if (!compiled.ok) return failure("ACTIVATION_REJECTED");
      return this.#acknowledgeAndStart(record, compiled.value);
    }
    if (record?.phase === "stable" || record?.phase === "running") return this.#recover(record);

    const compiled = this.#options.compiler(request.activation);
    if (!compiled.ok) return success(deepFreeze({ kind: "start-failed", code: "START_FAILED", detail: detail(compiled.error.code) }));

    record = {
      delivery,
      profileIdentity: request.activation.correlation.runtimeProfileIdentity,
      snapshotIdentity: request.activation.correlation.snapshotIdentity,
      contractIdentity: request.activation.admission.contractRevision,
      startCorrelation: startCorrelationFact(delivery),
      phase: "start-pending",
      retirements: {},
    };
    this.#save(record);
    return this.#acknowledgeAndStart(record, compiled.value);
  }

  async #acknowledgeAndStart(record: DurableCoordinatorRecord, compiled: Parameters<CoordinatorHost["start"]>[0]): Promise<RuntimeCallResult> {
    if (record.phase === "start-pending") {
      const acknowledged = await this.#options.startCorrelation.acknowledge(record.startCorrelation).catch(() => undefined);
      if (acknowledged === undefined) return failure("ADAPTER_UNAVAILABLE");
      if (!acknowledged.ok) return failure("CORRELATION_MISMATCH");
      record.phase = "start-acknowledged";
      try { record = this.#save(record); } catch { return failure("ADAPTER_UNAVAILABLE"); }
    }
    let started: Awaited<ReturnType<CoordinatorHost["start"]>> | undefined;
    let thrownCause: string | undefined;
    try { started = await this.#options.host.start(compiled, this.#options.interaction); }
    catch (cause) { thrownCause = typedHostCause(cause); }
    if (started === undefined) {
      record.phase = "running";
      record.result = this.#unknownResult(record.delivery, "HOST_START_UNRESOLVED",
        thrownCause === undefined ? undefined : { stage: "HOST_START", causeCode: thrownCause });
      record = this.#save(record);
      return success(record.result!);
    }
    if (!started.ok) {
      record.phase = "running";
      record.result = this.#unknownResult(record.delivery, "HOST_START_DISPOSITION_UNRESOLVED", {
        stage: "HOST_START", causeCode: started.error.code,
      });
      record = this.#save(record);
      return success(record.result!);
    }
    if (this.#cancelRequested(record.delivery)) return this.#persistUnknown(record, "CANCELLATION_RECONCILIATION_PENDING");
    return this.#drive(record, started.value);
  }

  async inspect(delivery: DeliveryRef): Promise<Result<ExecutionRuntimeInspection, ExecutionRuntimeAdapterError>> {
    let record: DurableCoordinatorRecord | undefined;
    try { record = this.#load(delivery); } catch { return failure("ADAPTER_UNAVAILABLE"); }
    if (record === undefined) return failure("ADAPTER_UNAVAILABLE");
    if (!same(record.delivery, delivery)) return failure("CORRELATION_MISMATCH");
    const state = record.phase === "terminal" || record.phase === "start-failed" ? "terminal"
      : record.phase === "stable" || record.phase === "publication-pending" || record.phase === "retiring" ? "stable"
        : record.phase === "running" ? "running" : "unknown";
    return success({ delivery, state, result: record.result === undefined ? unknown("coordinator", "CALL_INTERRUPTED") : known(record.result) });
  }

  async cancel(delivery: DeliveryRef): Promise<Result<ExecutionRuntimeCancellation, ExecutionRuntimeAdapterError>> {
    let record: DurableCoordinatorRecord | undefined;
    try { record = this.#load(delivery); } catch { return failure("ADAPTER_UNAVAILABLE"); }
    if (record === undefined) return failure("ADAPTER_UNAVAILABLE");
    if (!same(record.delivery, delivery)) return failure("CORRELATION_MISMATCH");
    if (record.phase === "terminal" || record.phase === "start-failed" || record.proposal !== undefined) return success({ delivery, state: known("already-stable") });
    record.cancelRequested = true;
    record.phase = "stable";
    record = this.#save(record);
    if (record.phase === "terminal" || record.phase === "start-failed") return success({ delivery, state: known("already-stable") });
    const invocation = await this.#options.invocation.cancel({ delivery, reason: "DELIVERY_CANCELLED" }).catch(() => undefined);
    const host = record.thread === undefined ? undefined : await this.#options.host.stop({ thread: record.thread, reason: "CANCEL" }).catch(() => undefined);
    const custody = await this.#options.custody.inspect(delivery).catch(() => undefined);
    const allKnown = invocation?.ok === true && invocation.value.process.state === "known"
      && host?.ok === true && host.value.state.state === "known"
      && custody?.ok === true && custody.value.currentSavepoint.state === "known";
    return success({ delivery, state: allKnown ? known("accepted") : unknown("coordinator", "CALL_INTERRUPTED") });
  }

  async #drive(record: DurableCoordinatorRecord, initial: HostDisposition): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    let disposition = initial;
    while (true) {
      if (this.#cancelRequested(record.delivery)
        && (disposition.kind !== "terminal-proposal" || disposition.proposal.proposedOutcome !== "CANCELLED")) {
        return this.#persistUnknown(record, "CANCELLATION_RECONCILIATION_PENDING");
      }
      if (disposition.kind === "intervention") {
        if (!same(disposition.intervention.thread.delivery, record.delivery)) return failure("CORRELATION_MISMATCH");
        record.thread = disposition.intervention.thread;
        record.intervention = disposition.intervention;
        record.phase = "intervention";
        return this.#persistUnknown(record, "HOST_INTERVENTION");
      }
      if (disposition.kind === "terminal-proposal") return this.#terminal(record, disposition.proposal);
      const thread = disposition.wait.checkpoint.thread;
      if (!same(thread.delivery, record.delivery)) return failure("CORRELATION_MISMATCH");
      record.thread = thread;
      record.phase = "stable";
      this.#save(record);
      if (disposition.kind === "action-input") {
        const response = await this.#options.interaction.requestInput(disposition.wait.request).catch(() => undefined);
        if (response === undefined || !response.ok || response.value.requestIdentity !== disposition.wait.request.identity) {
          return this.#persistUnknown(record, "ACTION_INPUT_UNRESOLVED");
        }
        if (this.#load(record.delivery)?.cancelRequested === true) return this.#persistUnknown(record, "CANCELLATION_RECONCILIATION_PENDING");
        const resumed = await this.#options.host.resumeAction({ thread, episode: disposition.wait.episode, response: response.value }, this.#options.interaction).catch(() => undefined);
        if (resumed === undefined || !resumed.ok) return this.#persistUnknown(record, "ACTION_RESUME_UNRESOLVED");
        disposition = resumed.value;
      } else {
        const response = await this.#options.workflow.request(disposition.wait.request).catch(() => undefined);
        if (response === undefined || !response.ok
          || response.value.controlIdentity !== disposition.wait.request.controlIdentity
          || response.value.correlationIdentity !== disposition.wait.request.correlationIdentity) {
          return this.#persistUnknown(record, "WORKFLOW_CONTROL_UNRESOLVED");
        }
        if (this.#load(record.delivery)?.cancelRequested === true) return this.#persistUnknown(record, "CANCELLATION_RECONCILIATION_PENDING");
        const resumed = await this.#options.host.resumeWorkflow({ thread, result: response.value }, this.#options.interaction).catch(() => undefined);
        if (resumed === undefined || !resumed.ok) return this.#persistUnknown(record, "WORKFLOW_RESUME_UNRESOLVED");
        disposition = resumed.value;
      }
      record.phase = "running";
      this.#save(record);
    }
  }

  async #terminal(record: DurableCoordinatorRecord, proposal: TerminalProposal): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    const key = this.#coordinationKey(record.delivery);
    const inFlight = TERMINAL_RECONCILIATIONS.get(key);
    if (inFlight !== undefined) return inFlight;
    const task = this.#performTerminal(record, proposal).finally(() => TERMINAL_RECONCILIATIONS.delete(key));
    TERMINAL_RECONCILIATIONS.set(key, task);
    return task;
  }

  async #performTerminal(record: DurableCoordinatorRecord, proposal: TerminalProposal): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    if (!same(proposal.thread.delivery, record.delivery) || !same(proposal.checkpoint.thread, proposal.thread)) return failure("CORRELATION_MISMATCH");
    record.thread = proposal.thread;
    record.proposal = proposal;
    record.phase = "stable";
    record = this.#save(record);
    if (proposal.result.state === "unknown") {
      record.phase = "intervention";
      return this.#persistUnknown(record, "TERMINAL_RESULT_UNKNOWN");
    }
    const preserved = await this.#options.custody.preserveResult({ checkpoint: proposal.checkpoint, result: proposal.result.value }).catch(() => undefined);
    if (preserved === undefined || !preserved.ok
      || !same(preserved.value.delivery, record.delivery)
      || preserved.value.contentIdentity !== proposal.result.value.contentIdentity
      || !same(preserved.value.savepoint, proposal.checkpoint.savepoint)) {
      record.phase = "intervention";
      return this.#persistUnknown(record, "RESULT_PRESERVATION_UNRESOLVED");
    }
    record.preserved = preserved.value;
    const expectedGitTree = proposal.checkpoint.savepoint.state === "known"
      ? proposal.checkpoint.savepoint.value.gitTree
      : undefined;
    if (expectedGitTree === undefined) {
      record.phase = "intervention";
      return this.#persistUnknown(record, "PUBLICATION_GUARD_UNRESOLVED");
    }
    const guard: PublicationGuardRef = {
      identity: stableId("publication-guard", { delivery: record.delivery, expectedGitTree }),
      expectedGitTree,
    };
    const published = await this.#options.custody.publish({ result: preserved.value, target: this.#options.publicationTarget, guard }).catch(() => undefined);
    if (published === undefined || !published.ok) {
      record.phase = "publication-pending";
      return this.#persistUnknown(record, "PUBLICATION_UNRESOLVED");
    }
    return this.#afterPublication(record, published.value);
  }

  async #afterPublication(record: DurableCoordinatorRecord, publication: PublicationDisposition): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    if (record.preserved === undefined) return failure("CORRELATION_MISMATCH");
    if (publication.kind === "unknown") {
      if (!same(publication.preservedResult, record.preserved)) return failure("CORRELATION_MISMATCH");
      record.publication = publication;
      record.phase = "publication-pending";
      return this.#persistUnknown(record, "PUBLICATION_UNRESOLVED");
    }
    if (publication.kind === "conflict") {
      if (!same(publication.preservedResult, record.preserved)) return failure("CORRELATION_MISMATCH");
    } else if (!same(publication.reference.result, record.preserved)
      || !same(publication.reference.target, this.#options.publicationTarget)) return failure("CORRELATION_MISMATCH");
    record.publication = publication;
    record.authorization = {
      identity: stableId("retirement-authorization", { delivery: record.delivery, proposal: record.proposal, publication }),
      delivery: record.delivery,
    };
    record.phase = "retiring";
    this.#save(record);
    return this.#retireAndSettle(record);
  }

  async #reconcilePublication(record: DurableCoordinatorRecord): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    const inspection = await this.#options.custody.inspect(record.delivery).catch(() => undefined);
    if (inspection?.ok !== true || inspection.value.publication.state === "unknown") return this.#persistUnknown(record, "PUBLICATION_UNRESOLVED");
    return this.#afterPublication(record, inspection.value.publication.value);
  }

  async #retireAndSettle(record: DurableCoordinatorRecord): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    const key = this.#coordinationKey(record.delivery);
    const inFlight = RETIREMENT_RECONCILIATIONS.get(key);
    if (inFlight !== undefined) return inFlight;
    const task = this.#performRetirement(record).finally(() => RETIREMENT_RECONCILIATIONS.delete(key));
    RETIREMENT_RECONCILIATIONS.set(key, task);
    return task;
  }

  async #performRetirement(record: DurableCoordinatorRecord): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    const authorization = record.authorization;
    const proposal = record.proposal;
    const preserved = record.preserved;
    const publication = record.publication;
    const thread = record.thread;
    if (authorization === undefined || proposal === undefined || preserved === undefined || publication === undefined
      || publication.kind === "unknown" || thread === undefined) return failure("CORRELATION_MISMATCH");

    await this.#retireOwner(record, "host", () => this.#options.host.retire({ thread, authorization }));
    await this.#retireOwner(record, "invocation", () => this.#options.invocation.retire(authorization));
    await this.#retireOwner(record, "custody", () => this.#options.custody.retire(authorization));
    const children = [record.retirements.host, record.retirements.invocation, record.retirements.custody];
    if (children.some((fact) => fact === undefined || fact.state === "unknown")) {
      return this.#persistUnknown(record, "RETIREMENT_UNRESOLVED");
    }
    record.retirements.coordinator = { owner: "coordinator", authorization, state: "retired" };
    const ownerRetirements = [record.retirements.coordinator, record.retirements.host, record.retirements.invocation, record.retirements.custody] as KnownOwnerRetirements;
    const settlement: TerminalSettlementRecord = deepFreeze({
      identity: stableId("settlement", { delivery: record.delivery, authorization, ownerRetirements }),
      delivery: record.delivery,
      profileIdentity: record.profileIdentity,
      contractIdentity: record.contractIdentity,
      implementationIdentity: this.#options.implementationIdentity,
      snapshotIdentity: record.snapshotIdentity,
      outcome: proposal.proposedOutcome,
      reason: proposal.reason,
      checkpoint: proposal.checkpoint,
      result: known(preserved),
      publication,
      retirementAuthorization: authorization,
      ownerRetirements,
    });
    record.result = deepFreeze({ kind: "terminal", outcome: proposal.proposedOutcome, settlement, result: known(preserved) });
    record.phase = "terminal";
    this.#save(record);
    try {
      void Promise.resolve(this.#options.observation.observe({ kind: "runner-terminal-settled", delivery: record.delivery, settlementIdentity: settlement.identity }))
        .catch(() => undefined);
    } catch {
      // Observation is explicitly non-controlling, including synchronous throw.
    }
    return success(record.result);
  }

  async #retireOwner(record: DurableCoordinatorRecord, owner: "host" | "invocation" | "custody", call: () => Promise<Result<OwnerRetirementDisposition, unknown>>): Promise<void> {
    const current = record.retirements[owner];
    if (current !== undefined && current.state !== "unknown") return;
    const authorization = record.authorization!;
    const result = await call().catch(() => undefined);
    const fact = result?.ok === true ? result.value : undefined;
    record.retirements[owner] = fact !== undefined && fact.owner === owner && same(fact.authorization, authorization)
      && (fact.state !== "unknown" || fact.uncertainty.owner === owner)
      ? fact
      : { owner, authorization, state: "unknown", uncertainty: unknown(owner, "CALL_INTERRUPTED") };
    this.#save(record);
  }

  async #recover(record: DurableCoordinatorRecord): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>> {
    if (record.thread === undefined) return this.#persistUnknown(record, "START_DISPOSITION_UNRESOLVED");
    const inspected = await this.#options.host.inspect(record.thread).catch(() => undefined);
    if (inspected?.ok !== true || inspected.value.disposition.state === "unknown") return this.#persistUnknown(record, "HOST_RECOVERY_UNRESOLVED");
    const disposition = inspected.value.disposition.value;
    if (!("kind" in disposition && disposition.kind === "ABSENT")) return this.#drive(record, disposition);
    if (record.cancelRequested === true) return this.#persistUnknown(record, "CANCELLATION_RECONCILIATION_PENDING");
    const custody = await this.#options.custody.inspect(record.delivery).catch(() => undefined);
    const invocation = await this.#options.invocation.inspect(record.delivery).catch(() => undefined);
    if (custody?.ok !== true || invocation?.ok !== true || inspected.value.checkpoint.state === "unknown" || custody.value.currentSavepoint.state === "unknown" || invocation.value.process.state === "unknown") {
      return this.#persistUnknown(record, "RECOVERY_FACTS_UNRESOLVED");
    }
    const checkpointSavepoint = inspected.value.checkpoint.value.savepoint;
    if (checkpointSavepoint.state === "unknown") return this.#persistUnknown(record, "RECOVERY_FACTS_UNRESOLVED");
    const restart = !same(checkpointSavepoint.value, custody.value.currentSavepoint.value);
    const restored = await this.#options.custody.recover({
      delivery: record.delivery,
      directive: restart ? "restore-from-savepoint" : "continue",
      savepoint: restart ? checkpointSavepoint : custody.value.currentSavepoint,
    }).catch(() => undefined);
    if (restored?.ok !== true || restored.value.kind === "intervention-required") return this.#persistUnknown(record, "CUSTODY_RECOVERY_UNRESOLVED");
    const resumed = await this.#options.host.recover({ thread: record.thread, directive: restart ? "restart-from-savepoint" : "continue", checkpoint: inspected.value.checkpoint, savepoint: known(restored.value.savepoint) }).catch(() => undefined);
    return resumed?.ok === true ? this.#drive(record, resumed.value) : this.#persistUnknown(record, "HOST_RECOVERY_UNRESOLVED");
  }

  #persistUnknown(record: DurableCoordinatorRecord, reason: string): Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError> {
    record.result = this.#unknownResult(record.delivery, reason);
    const saved = this.#save(record);
    return success(saved.result ?? record.result);
  }

  #cancelRequested(delivery: DeliveryRef): boolean {
    return this.#load(delivery)?.cancelRequested === true;
  }

  #coordinationKey(delivery: DeliveryRef): string {
    return `${path.resolve(this.#options.stateDirectory)}\0${delivery.deliveryIdentity}`;
  }

  #unknownResult(delivery: DeliveryRef, reason: string, diagnostic?: Readonly<{ stage: string; causeCode: string }>): ExecutionRuntimeResult {
    return deepFreeze({ kind: "unknown", delivery, detail: detail(reason, diagnostic) });
  }

  #file(delivery: DeliveryRef): string {
    return path.join(this.#options.stateDirectory, `${stableId<string>("delivery", delivery.deliveryIdentity)}.json`);
  }

  #load(delivery: DeliveryRef): DurableCoordinatorRecord | undefined {
    const file = this.#file(delivery);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as DurableCoordinatorRecord;
  }

  #save(record: DurableCoordinatorRecord): DurableCoordinatorRecord {
    const existing = this.#load(record.delivery);
    if (existing !== undefined && same(existing.delivery, record.delivery)) {
      if (existing.phase === "terminal" && record.phase !== "terminal") return existing;
      record.cancelRequested = existing.cancelRequested === true || record.cancelRequested === true ? true : undefined;
      if (record.cancelRequested === true && record.phase === "running") record.phase = existing.phase === "running" ? "stable" : existing.phase;
      for (const owner of ["coordinator", "host", "invocation", "custody"] as const) {
        const prior = existing.retirements[owner];
        const next = record.retirements[owner];
        if (prior !== undefined && (prior.state !== "unknown" || next === undefined)) record.retirements[owner] = prior;
      }
    }
    const target = this.#file(record.delivery);
    const candidate = `${target}.${process.pid}.${randomUUID()}.candidate`;
    writeFileSync(candidate, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(candidate, target);
    return record;
  }
}
