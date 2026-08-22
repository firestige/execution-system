import { mkdirSync } from "node:fs";
import path from "node:path";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import { canonicalDigest } from "../contracts/compiler.js";
import { executionSiteKey } from "../contracts/compiled-activation.js";
import type { HostOperationHandler } from "./workflow-host-adapter-factory.js";
import type {
  Absent,
  ActionOutputSink,
  AdmittedActionTemplate,
  AdmittedControlNode,
  ArtifactId,
  ArtifactVersionRef,
  AuthorizedWorkspaceCapability,
  BoundedWorkflowResult,
  BranchId,
  CanonicalExecutionSiteKey,
  CheckpointId,
  CheckpointRef,
  CompiledGraphActivation,
  CoordinatorHost,
  DeliveryRef,
  EpisodeRef,
  ExecutionSiteRef,
  ExternalControlRequest,
  FrozenJsonSchema,
  FrozenJsonValue,
  HostCustody,
  HostDisposition,
  HostError,
  HostInspection,
  HostInvocation,
  HostOperationContractId,
  HostStopFact,
  InteractionRequestId,
  InterventionId,
  InvocationDispatch,
  InvocationDisposition,
  InvocationId,
  Knowledge,
  NodeId,
  OwnerRetirementDisposition,
  Result,
  RetirementAuthorizationRef,
  SavepointRef,
  SessionAffinityId,
  SessionAffinityRef,
  SourcePortRef,
  Target,
  TerminalProposal,
  ThreadId,
  ThreadRef,
  WorkflowResultId,
} from "../contracts/index.js";

export interface LangGraphCoordinatorHostOptions {
  readonly invocation: HostInvocation;
  readonly custody: HostCustody;
  readonly checkpointDirectory: string;
  readonly hostOperations?: Readonly<Partial<Record<HostOperationContractId | string, HostOperationHandler>>>;
}

interface ParallelProgress {
  readonly nodeIdentity: NodeId;
  readonly selected: readonly BranchId[];
  index: number;
  phase: "branches" | "join";
}

interface PendingAction {
  readonly site: ExecutionSiteRef;
  readonly siteKey: CanonicalExecutionSiteKey;
  readonly episode: EpisodeRef;
  readonly dispatch: InvocationDispatch;
  readonly workspace: AuthorizedWorkspaceCapability;
  readonly requestIdentity: InteractionRequestId;
}

interface PendingWorkflow {
  readonly controlIdentity: string;
  readonly request: ExternalControlRequest;
}

interface HostThreadRecord {
  readonly compiled: CompiledGraphActivation;
  readonly thread: ThreadRef;
  currentTarget: Target;
  state: Record<string, FrozenJsonValue>;
  artifacts: Record<string, ArtifactVersionRef | Absent>;
  siteResults: Record<string, FrozenJsonValue>;
  controlResults: Record<string, FrozenJsonValue>;
  savepoint: Knowledge<SavepointRef>;
  checkpoint?: CheckpointRef;
  disposition?: HostDisposition;
  pendingAction?: PendingAction;
  pendingWorkflow?: PendingWorkflow;
  parallel?: ParallelProgress;
  sequence: number;
  stopped: boolean;
}

type HostRetirementFact = OwnerRetirementDisposition<"host">;
interface HostRetirementRow {
  readonly thread_key: string;
  readonly thread_id: string;
  readonly authorization: string;
  readonly phase: "retiring" | "complete";
  readonly fact: string | null;
  readonly cleanup_count: number;
}

interface ProjectedCommit {
  readonly state: Record<string, FrozenJsonValue>;
  readonly artifacts: Record<string, ArtifactVersionRef | Absent>;
}

const HostCheckpointState = Annotation.Root({
  record: Annotation<HostThreadRecord>(),
});

const absent: Absent = { kind: "ABSENT" };
const known = <T>(value: T): Knowledge<T> => ({ state: "known", value });
const hostUnknown = (reason: "CALL_INTERRUPTED" | "CHECKPOINT_DISPOSITION_UNOBSERVED") => ({
  state: "unknown" as const,
  owner: "host" as const,
  reason,
});
const success = <T>(value: T): Result<T, HostError> => ({ ok: true, value });
const failure = (code: HostError["code"]): Result<never, HostError> => ({ ok: false, error: { code } });

function stableId<T extends string>(prefix: string, value: unknown): T {
  return `${prefix}.${canonicalDigest(value).slice("sha256:".length)}` as T;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalDigest(left) === canonicalDigest(right);
}

function deliveryRef(compiled: CompiledGraphActivation): DeliveryRef {
  return {
    deliveryIdentity: compiled.correlation.deliveryIdentity,
    manifestBindingIdentity: compiled.correlation.manifestBindingIdentity,
    activationBindingIdentity: compiled.activationBindingIdentity,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema", "$id", "$anchor", "$defs", "definitions", "$ref",
  "title", "description", "default", "examples", "readOnly", "writeOnly", "deprecated",
  "type", "const", "enum", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "multipleOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "prefixItems", "items",
  "contains", "minContains", "maxContains", "minProperties", "maxProperties", "required", "properties",
  "patternProperties", "additionalProperties", "propertyNames", "dependentRequired",
]);

function resolvesLocalReference(root: Record<string, unknown>, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  return reference.slice(2).split("/").reduce<unknown>((current, segment) => isObject(current)
    ? current[segment.replaceAll("~1", "/").replaceAll("~0", "~")]
    : undefined, root);
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return new Set(["boolean", "string"]).has(type) && typeof value === type;
}

function decimalInteger(value: number): Readonly<{ coefficient: bigint; scale: number }> {
  const [mantissa = "0", exponentText = "0"] = value.toString().toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  let coefficient = BigInt(`${negative ? "-" : ""}${integer}${fraction}`);
  let scale = fraction.length - Number(exponentText);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function isExactMultiple(value: number, divisor: number): boolean {
  const left = decimalInteger(value);
  const right = decimalInteger(divisor);
  const scale = Math.max(left.scale, right.scale);
  const dividend = left.coefficient * 10n ** BigInt(scale - left.scale);
  const divisorInteger = right.coefficient * 10n ** BigInt(scale - right.scale);
  return dividend % divisorInteger === 0n;
}

function validatesSchema(value: unknown, schema: FrozenJsonSchema): boolean {
  return isObject(schema) && validSchemaDefinition(schema, schema, 0) && validateSchemaNode(value, schema, schema, 0);
}

function validSchemaDefinition(schema: unknown, root: Record<string, unknown>, depth: number): boolean {
  if (typeof schema === "boolean") return true;
  if (!isObject(schema) || depth > 128 || Object.keys(schema).some((key) => !SUPPORTED_SCHEMA_KEYWORDS.has(key))) return false;
  const strings = ["$schema", "$id", "$anchor", "title", "description"];
  if (strings.some((key) => schema[key] !== undefined && typeof schema[key] !== "string")) return false;
  for (const key of ["readOnly", "writeOnly", "deprecated", "uniqueItems"] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== "boolean") return false;
  }
  for (const key of ["multipleOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) return false;
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0) return false;
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minContains", "maxContains", "minProperties", "maxProperties"] as const) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || (schema[key] as number) < 0)) return false;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") return false;
    try { new RegExp(schema.pattern, "u"); } catch { return false; }
  }
  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type] : schema.type;
    const allowed = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
    if (!Array.isArray(types) || types.length === 0 || types.some((type) => typeof type !== "string" || !allowed.has(type))) return false;
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return false;
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) return false;
  if (schema.$ref !== undefined && (typeof schema.$ref !== "string" || resolvesLocalReference(root, schema.$ref) === undefined)) return false;
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || !schema[key].every((child) => validSchemaDefinition(child, root, depth + 1)))) return false;
  }
  for (const key of ["not", "if", "then", "else", "contains", "propertyNames"] as const) {
    if (schema[key] !== undefined && !validSchemaDefinition(schema[key], root, depth + 1)) return false;
  }
  if (schema.prefixItems !== undefined && (!Array.isArray(schema.prefixItems)
    || !schema.prefixItems.every((child) => validSchemaDefinition(child, root, depth + 1)))) return false;
  if (schema.items !== undefined && !validSchemaDefinition(schema.items, root, depth + 1)) return false;
  if (schema.additionalProperties !== undefined && !validSchemaDefinition(schema.additionalProperties, root, depth + 1)) return false;
  for (const key of ["$defs", "definitions", "properties", "patternProperties"] as const) {
    if (schema[key] !== undefined && (!isObject(schema[key])
      || !Object.values(schema[key]).every((child) => validSchemaDefinition(child, root, depth + 1)))) return false;
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required)
    || schema.required.some((key) => typeof key !== "string")
    || new Set(schema.required).size !== schema.required.length)) return false;
  if (schema.dependentRequired !== undefined && (!isObject(schema.dependentRequired)
    || Object.values(schema.dependentRequired).some((dependencies) => !Array.isArray(dependencies)
      || dependencies.some((dependency) => typeof dependency !== "string")
      || new Set(dependencies).size !== dependencies.length))) return false;
  return true;
}

function validateSchemaNode(value: unknown, schema: unknown, root: Record<string, unknown>, depth: number): boolean {
  if (schema === true) return true;
  if (schema === false || !isObject(schema) || depth > 128) return false;
  if (Object.keys(schema).some((key) => !SUPPORTED_SCHEMA_KEYWORDS.has(key))) return false;
  if (typeof schema.$ref === "string") {
    const resolved = resolvesLocalReference(root, schema.$ref);
    if (resolved === undefined || !validateSchemaNode(value, resolved, root, depth + 1)) return false;
  } else if (schema.$ref !== undefined) return false;
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) if (schema[keyword] !== undefined && !Array.isArray(schema[keyword])) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((child) => validateSchemaNode(value, child, root, depth + 1))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => validateSchemaNode(value, child, root, depth + 1))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((child) => validateSchemaNode(value, child, root, depth + 1)).length !== 1) return false;
  if (schema.not !== undefined && validateSchemaNode(value, schema.not, root, depth + 1)) return false;
  if (schema.if !== undefined) {
    const condition = validateSchemaNode(value, schema.if, root, depth + 1);
    if (condition && schema.then !== undefined && !validateSchemaNode(value, schema.then, root, depth + 1)) return false;
    if (!condition && schema.else !== undefined && !validateSchemaNode(value, schema.else, root, depth + 1)) return false;
  }
  if ("const" in schema && !same(value, schema.const)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.some((candidate) => same(value, candidate)))) return false;
  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type]
      : Array.isArray(schema.type) && schema.type.every((item) => typeof item === "string") ? schema.type : undefined;
    if (types === undefined || !types.some((type) => matchesType(value, type))) return false;
  }
  if (typeof value === "number") {
    if (schema.multipleOf !== undefined && (typeof schema.multipleOf !== "number" || schema.multipleOf <= 0
      || !isExactMultiple(value, schema.multipleOf))) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum || typeof schema.maximum === "number" && value > schema.maximum
      || typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum
      || typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength
      || typeof schema.maxLength === "number" && [...value].length > schema.maxLength) return false;
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") return false;
      try { if (!new RegExp(schema.pattern, "u").test(value)) return false; } catch { return false; }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems
      || typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map((item) => canonicalDigest(item))).size !== value.length) return false;
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") return false;
    if (schema.prefixItems !== undefined && (!Array.isArray(schema.prefixItems)
      || !schema.prefixItems.every((child, index) => index >= value.length || validateSchemaNode(value[index], child, root, depth + 1)))) return false;
    const prefixLength = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
    if (schema.items === false && value.length > prefixLength) return false;
    if (schema.items !== undefined && schema.items !== true && schema.items !== false
      && !value.slice(prefixLength).every((item) => validateSchemaNode(item, schema.items, root, depth + 1))) return false;
    if (schema.contains !== undefined) {
      const count = value.filter((item) => validateSchemaNode(item, schema.contains, root, depth + 1)).length;
      if (count < (typeof schema.minContains === "number" ? schema.minContains : 1)
        || count > (typeof schema.maxContains === "number" ? schema.maxContains : Number.POSITIVE_INFINITY)) return false;
    }
  }
  if (isObject(value)) {
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties
      || typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) return false;
    if (schema.required !== undefined && (!Array.isArray(schema.required)
      || !schema.required.every((key) => typeof key === "string" && key in value))) return false;
    const properties = schema.properties ?? {};
    const patterns = schema.patternProperties ?? {};
    if (!isObject(properties) || !isObject(patterns)) return false;
    for (const [key, child] of Object.entries(properties)) if (key in value && !validateSchemaNode(value[key], child, root, depth + 1)) return false;
    const compiledPatterns: Array<readonly [RegExp, unknown]> = [];
    try { for (const [pattern, child] of Object.entries(patterns)) compiledPatterns.push([new RegExp(pattern, "u"), child]); } catch { return false; }
    for (const [key, child] of Object.entries(value)) {
      const matchingPatterns = compiledPatterns.filter(([pattern]) => pattern.test(key));
      if (matchingPatterns.some(([, childSchema]) => !validateSchemaNode(child, childSchema, root, depth + 1))) return false;
      if (!(key in properties) && matchingPatterns.length === 0) {
        if (schema.additionalProperties === false) return false;
        if (schema.additionalProperties !== undefined && schema.additionalProperties !== true
          && !validateSchemaNode(child, schema.additionalProperties, root, depth + 1)) return false;
      }
    }
    if (schema.propertyNames !== undefined && !Object.keys(value).every((key) => validateSchemaNode(key, schema.propertyNames, root, depth + 1))) return false;
    if (schema.dependentRequired !== undefined) {
      if (!isObject(schema.dependentRequired)) return false;
      for (const [key, dependencies] of Object.entries(schema.dependentRequired)) if (key in value
        && (!Array.isArray(dependencies) || !dependencies.every((dependency) => typeof dependency === "string" && dependency in value))) return false;
    }
  }
  return true;
}

function project(value: FrozenJsonValue, slot: Readonly<{ kind: "whole" } | { kind: "property"; name: string }>): FrozenJsonValue | undefined {
  if (slot.kind === "whole") return value;
  return isObject(value) && slot.name in value ? value[slot.name] as FrozenJsonValue : undefined;
}

function terminalOutcome(kind: string): TerminalProposal["proposedOutcome"] {
  if (kind === "success") return "COMPLETED";
  if (kind === "incomplete") return "INCOMPLETE";
  if (kind === "cancelled") return "CANCELLED";
  return "FAILED";
}

export class LangGraphCoordinatorHost implements CoordinatorHost {
  readonly #invocation: HostInvocation;
  readonly #custody: HostCustody;
  readonly #operations: LangGraphCoordinatorHostOptions["hostOperations"];
  readonly #checkpointer: SqliteSaver;
  readonly #graph;

  constructor(options: LangGraphCoordinatorHostOptions) {
    this.#invocation = options.invocation;
    this.#custody = options.custody;
    this.#operations = options.hostOperations ?? {};
    mkdirSync(options.checkpointDirectory, { recursive: true });
    const checkpointer = SqliteSaver.fromConnString(path.join(options.checkpointDirectory, "host-checkpoints.sqlite"));
    checkpointer.db.pragma("busy_timeout = 5000");
    checkpointer.db.exec(`
      CREATE TABLE IF NOT EXISTS host_retirements (
        thread_key TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        authorization TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('retiring', 'complete')),
        fact TEXT,
        cleanup_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.#checkpointer = checkpointer;
    this.#graph = new StateGraph(HostCheckpointState)
      .addNode("checkpoint", (state) => ({ record: state.record }))
      .addEdge(START, "checkpoint")
      .addEdge("checkpoint", END)
      .compile({ checkpointer });
  }

  async start(compiled: CompiledGraphActivation, output: ActionOutputSink): Promise<Result<HostDisposition, HostError>> {
    const delivery = deliveryRef(compiled);
    const thread: ThreadRef = {
      delivery,
      threadIdentity: stableId<ThreadId>("thread", { delivery, compileIdentity: compiled.compileIdentity }),
    };
    const existing = await this.#load(thread);
    if (existing !== undefined) {
      if (existing.compiled.compileIdentity !== compiled.compileIdentity) return failure("ACTIVATION_MISMATCH");
      return existing.disposition === undefined ? failure("CHECKPOINT_ORDER_VIOLATION") : success(existing.disposition);
    }
    const baseline = await this.#custody.establishBaseline({ delivery, workspace: compiled.initial.workspace });
    if (!baseline.ok) return failure("CHECKPOINT_ORDER_VIOLATION");
    const record: HostThreadRecord = {
      compiled,
      thread,
      currentTarget: compiled.plan.control.entryNode,
      state: structuredClone(compiled.initial.state.values) as Record<string, FrozenJsonValue>,
      artifacts: structuredClone(compiled.initial.artifacts.versions),
      siteResults: {},
      controlResults: {},
      savepoint: known(baseline.value),
      sequence: 0,
      stopped: false,
    };
    await this.#checkpoint(record);
    return this.#drive(record, output);
  }

  async resumeWorkflow(
    request: Parameters<CoordinatorHost["resumeWorkflow"]>[0],
    output: ActionOutputSink,
  ): Promise<Result<HostDisposition, HostError>> {
    const record = await this.#load(request.thread);
    if (record === undefined || !same(record.thread, request.thread)) return failure("CONTROL_MISMATCH");
    const pending = record.pendingWorkflow;
    if (pending === undefined
      || pending.controlIdentity !== request.result.controlIdentity
      || pending.request.correlationIdentity !== request.result.correlationIdentity
      || request.result.contentIdentity !== canonicalDigest(request.result.content)) return failure("CONTROL_MISMATCH");
    const control = record.compiled.plan.control.controls[request.result.controlIdentity as keyof typeof record.compiled.plan.control.controls];
    if (control === undefined || !validatesSchema(request.result.content, control.resultSchema)) return failure("CONTROL_MISMATCH");
    record.controlResults[request.result.controlIdentity] = request.result.content;
    const committed = this.#commitOutgoing(record, `control:${request.result.controlIdentity}`, request.result.content);
    if (!committed) return failure("DATAFLOW_BINDING_INVALID");
    delete record.pendingWorkflow;
    delete record.disposition;
    const target = await this.#evaluateDecision(record, control.resumeDecision);
    if (target === undefined) return failure("ILLEGAL_SUCCESSOR");
    record.currentTarget = target;
    await this.#checkpoint(record);
    return this.#drive(record, output);
  }

  async resumeAction(
    request: Parameters<CoordinatorHost["resumeAction"]>[0],
    output: ActionOutputSink,
  ): Promise<Result<HostDisposition, HostError>> {
    const record = await this.#load(request.thread);
    const pending = record?.pendingAction;
    const suspendedRequest = record?.disposition?.kind === "action-input" ? record.disposition.wait.request : undefined;
    if (record === undefined || pending === undefined
      || suspendedRequest === undefined
      || !same(record.thread, request.thread)
      || !same(pending.episode, request.episode)
      || pending.requestIdentity !== request.response.requestIdentity
      || request.response.contentIdentity !== canonicalDigest(request.response.content)
      || !validatesSchema(request.response.content, suspendedRequest.responseSchema)) return failure("ACTION_INPUT_MISMATCH");
    delete record.disposition;
    const result = await this.#invocation.continueWithInput({ episode: pending.episode, response: request.response }, output);
    if (!result.ok) return this.#actionFailure(record, pending, output);
    return this.#handleInvocation(record, pending, result.value, output);
  }

  async stop(request: Parameters<CoordinatorHost["stop"]>[0]): Promise<Result<HostStopFact, HostError>> {
    const record = await this.#load(request.thread);
    if (record === undefined || !same(record.thread, request.thread)) return failure("ACTIVATION_MISMATCH");
    const alreadyStable = record.stopped || record.disposition?.kind === "terminal-proposal";
    record.stopped = true;
    await this.#persist(record);
    return success({
      thread: record.thread,
      state: known(alreadyStable ? "already-stable" : "stopped"),
      checkpoint: record.checkpoint === undefined ? hostUnknown("CHECKPOINT_DISPOSITION_UNOBSERVED") : known(record.checkpoint),
    });
  }

  async inspect(thread: ThreadRef): Promise<Result<HostInspection, HostError>> {
    const record = await this.#load(thread);
    if (record === undefined || !same(record.thread, thread)) return failure("ACTIVATION_MISMATCH");
    return success({
      thread,
      checkpoint: record.checkpoint === undefined ? hostUnknown("CHECKPOINT_DISPOSITION_UNOBSERVED") : known(record.checkpoint),
      pendingSite: known(record.pendingAction?.site ?? absent),
      disposition: known(record.disposition ?? absent),
    });
  }

  async recover(request: Parameters<CoordinatorHost["recover"]>[0]): Promise<Result<HostDisposition, HostError>> {
    const record = await this.#load(request.thread);
    if (record === undefined || !same(record.thread, request.thread)) return failure("RECOVERY_NOT_ADMITTED");
    if (request.checkpoint.state === "known" && !same(request.checkpoint.value, record.checkpoint)) return failure("RECOVERY_NOT_ADMITTED");
    if (request.savepoint.state === "known" && !same(request.savepoint.value, record.savepoint.state === "known" ? record.savepoint.value : undefined)) {
      return failure("RECOVERY_NOT_ADMITTED");
    }
    if (request.directive === "intervene") return this.#intervention(record, "RECOVERY_EXHAUSTED");
    if (request.directive === "restart-from-savepoint" && request.savepoint.state !== "known") return failure("RECOVERY_NOT_ADMITTED");
    record.stopped = false;
    await this.#persist(record);
    return record.disposition === undefined ? this.#intervention(record, "RECOVERY_EXHAUSTED") : success(record.disposition);
  }

  async retire(request: Parameters<CoordinatorHost["retire"]>[0]): Promise<Result<OwnerRetirementDisposition, HostError>> {
    const existing = this.#readRetirementRow(request.thread);
    const record = existing === undefined ? await this.#load(request.thread) : undefined;
    if (existing === undefined && (record === undefined
      || !same(record.thread, request.thread)
      || !same(request.authorization.delivery, record.thread.delivery))) {
      return failure("RETIREMENT_NOT_AUTHORIZED");
    }
    return this.#retirementTransaction(request, record);
  }

  #retirementKey(thread: ThreadRef): string {
    return canonicalDigest(thread);
  }

  #readRetirementRow(thread: ThreadRef): HostRetirementRow | undefined {
    return this.#checkpointer.db.prepare("SELECT thread_key, thread_id, authorization, phase, fact, cleanup_count FROM host_retirements WHERE thread_key = ?")
      .get(this.#retirementKey(thread)) as HostRetirementRow | undefined;
  }

  #retirementTransaction(
    request: Parameters<CoordinatorHost["retire"]>[0],
    admittedRecord: HostThreadRecord | undefined,
  ): Result<OwnerRetirementDisposition, HostError> {
    const threadKey = this.#retirementKey(request.thread);
    const transaction = this.#checkpointer.db.transaction((): Result<OwnerRetirementDisposition, HostError> => {
      let row = this.#readRetirementRow(request.thread);
      if (row === undefined) {
        if (admittedRecord === undefined) return failure("RETIREMENT_NOT_AUTHORIZED");
        this.#checkpointer.db.prepare("INSERT INTO host_retirements (thread_key, thread_id, authorization, phase, fact, cleanup_count) VALUES (?, ?, ?, 'retiring', NULL, 0)")
          .run(threadKey, request.thread.threadIdentity, JSON.stringify(request.authorization));
        row = this.#readRetirementRow(request.thread);
      }
      if (row === undefined || row.thread_id !== request.thread.threadIdentity) return failure("RETIREMENT_NOT_AUTHORIZED");
      let authorization: RetirementAuthorizationRef;
      try {
        authorization = JSON.parse(row.authorization) as RetirementAuthorizationRef;
      } catch {
        return failure("RETIREMENT_NOT_AUTHORIZED");
      }
      if (!isObject(authorization) || !same(authorization, request.authorization)) return failure("RETIREMENT_NOT_AUTHORIZED");
      if (row.phase === "complete") {
        if (row.fact === null) return failure("RETIREMENT_NOT_AUTHORIZED");
        try {
          const fact = JSON.parse(row.fact) as HostRetirementFact;
          return isObject(fact)
            && fact.owner === "host"
            && fact.state === "retired"
            && same(fact.authorization, request.authorization)
            ? success(fact)
            : failure("RETIREMENT_NOT_AUTHORIZED");
        } catch {
          return failure("RETIREMENT_NOT_AUTHORIZED");
        }
      }
      this.#checkpointer.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(request.thread.threadIdentity);
      this.#checkpointer.db.prepare("DELETE FROM writes WHERE thread_id = ?").run(request.thread.threadIdentity);
      const fact: HostRetirementFact = { owner: "host", authorization: request.authorization, state: "retired" };
      this.#checkpointer.db.prepare("UPDATE host_retirements SET phase = 'complete', fact = ?, cleanup_count = cleanup_count + 1 WHERE thread_key = ? AND phase = 'retiring'")
        .run(JSON.stringify(fact), threadKey);
      return success(fact);
    });
    try {
      return transaction();
    } catch {
      return failure("CHECKPOINT_ORDER_VIOLATION");
    }
  }

  async #drive(record: HostThreadRecord, output: ActionOutputSink): Promise<Result<HostDisposition, HostError>> {
    if (record.stopped) return record.disposition === undefined ? this.#intervention(record, "CANCELLED") : success(record.disposition);
    for (;;) {
      const terminal = record.compiled.plan.control.terminals[record.currentTarget as keyof typeof record.compiled.plan.control.terminals];
      if (terminal !== undefined) return this.#declaredTerminal(record, terminal.kind);
      const decision = record.compiled.plan.control.decisions[record.currentTarget as keyof typeof record.compiled.plan.control.decisions];
      if (decision !== undefined) {
        const target = await this.#evaluateDecision(record, decision.identity);
        if (target === undefined) return failure("ILLEGAL_SUCCESSOR");
        record.currentTarget = target;
        continue;
      }
      const node = record.compiled.plan.control.nodes[record.currentTarget as keyof typeof record.compiled.plan.control.nodes];
      if (node === undefined) return failure("ILLEGAL_SUCCESSOR");
      if (node.kind === "wait" || node.kind === "wait-renewal") return this.#workflowWait(record, node);
      if (node.kind === "parallel") return this.#driveParallel(record, node, output);
      const site: ExecutionSiteRef = { kind: "node", nodeIdentity: node.id };
      const executed = await this.#executeSite(record, site, output);
      if (executed !== undefined) return executed;
    }
  }

  async #driveParallel(
    record: HostThreadRecord,
    node: Extract<AdmittedControlNode, { kind: "parallel" }>,
    output: ActionOutputSink,
  ): Promise<Result<HostDisposition, HostError>> {
    if (record.parallel === undefined) {
      const selectedValue = node.selection === undefined ? node.branches.map((branch) => branch.id) : this.#sourceValue(record, node.selection.source);
      if (!Array.isArray(selectedValue)
        || selectedValue.length === 0
        || selectedValue.some((item) => typeof item !== "string")
        || new Set(selectedValue).size !== selectedValue.length) return failure("DATAFLOW_BINDING_INVALID");
      const declared = new Set(node.branches.map((branch) => branch.id));
      if (selectedValue.some((item) => !declared.has(item as BranchId))) return failure("DATAFLOW_BINDING_INVALID");
      record.parallel = { nodeIdentity: node.id, selected: selectedValue as BranchId[], index: 0, phase: "branches" };
    }
    const progress = record.parallel;
    while (progress.phase === "branches" && progress.index < progress.selected.length) {
      const site: ExecutionSiteRef = { kind: "parallel-branch", nodeIdentity: node.id, branchIdentity: progress.selected[progress.index]! };
      const executed = await this.#executeSite(record, site, output);
      if (executed !== undefined) return executed;
    }
    progress.phase = "join";
    const joinKey = executionSiteKey({ kind: "parallel-join", nodeIdentity: node.id });
    if (record.compiled.plan.execution.sites[joinKey] !== undefined && record.siteResults[joinKey] === undefined) {
      const executed = await this.#executeSite(record, { kind: "parallel-join", nodeIdentity: node.id }, output);
      if (executed !== undefined) return executed;
    }
    delete record.parallel;
    const target = record.compiled.plan.control.ordinarySuccessor[node.id];
    if (target === undefined) return failure("ILLEGAL_SUCCESSOR");
    record.currentTarget = target;
    await this.#checkpoint(record);
    return this.#drive(record, output);
  }

  async #executeSite(
    record: HostThreadRecord,
    site: ExecutionSiteRef,
    output: ActionOutputSink,
  ): Promise<Result<HostDisposition, HostError> | undefined> {
    const siteKey = executionSiteKey(site);
    const binding = record.compiled.plan.execution.sites[siteKey];
    if (binding === undefined) return failure("ACTIVATION_MISMATCH");
    const action = record.compiled.plan.execution.actions[binding.actionIdentity];
    if (action === undefined) return failure("ACTIVATION_MISMATCH");
    const input = this.#materializeInput(record, siteKey);
    if (input === undefined || (action.inputSchema as Absent).kind !== "ABSENT" && !validatesSchema(input, action.inputSchema as FrozenJsonSchema)) {
      return failure("DATAFLOW_BINDING_INVALID");
    }
    if (binding.executor.kind === "host-operation") {
      const operation = record.compiled.plan.execution.hostOperations[binding.executor.identity];
      const handler = operation === undefined ? undefined : this.#operations?.[operation.contractIdentity];
      if (operation === undefined || handler === undefined) return failure("ACTIVATION_MISMATCH");
      const result = await handler.execute(input, operation.configuration);
      if (!result.accepted || !validatesSchema(result.value, action.resultSchema) || !await this.#passesGate(action, result.value)) {
        return this.#routeActionFailure(record, site.nodeIdentity, output);
      }
      if (!this.#commitOutgoing(record, siteKey, result.value)) return failure("DATAFLOW_BINDING_INVALID");
      record.siteResults[siteKey] = result.value;
      return this.#advanceAfterSite(record, site);
    }
    const plan = record.compiled.plan.execution.agentInvocations[siteKey];
    const executor = record.compiled.plan.execution.agents[binding.executor.identity];
    if (plan === undefined || executor === undefined) return failure("ACTIVATION_MISMATCH");
    const episode: EpisodeRef = {
      thread: record.thread,
      site,
      invocationIdentity: stableId<InvocationId>("invocation", { thread: record.thread, site, sequence: record.sequence }),
      attemptIdentity: stableId("attempt", { thread: record.thread, site, sequence: record.sequence }),
    };
    const workspace = await this.#workspace(record, episode, executor.turn.access);
    if (!workspace.ok) return workspace;
    const session = this.#sessionAffinity(record, episode, executor);
    if (session === undefined) return failure("DATAFLOW_BINDING_INVALID");
    const dispatch: InvocationDispatch = { episode, plan, action, executor, input, workspace: workspace.value, session };
    const pending: PendingAction = { site, siteKey, episode, dispatch, workspace: workspace.value, requestIdentity: "" as InteractionRequestId };
    record.pendingAction = pending;
    record.sequence += 1;
    const invoked = await this.#invocation.start(dispatch, output);
    if (!invoked.ok) return this.#actionFailure(record, pending, output);
    return this.#handleInvocation(record, pending, invoked.value, output);
  }

  async #handleInvocation(
    record: HostThreadRecord,
    pending: PendingAction,
    disposition: InvocationDisposition,
    output: ActionOutputSink,
  ): Promise<Result<HostDisposition, HostError>> {
    if (!same(disposition.episode, pending.episode)) return failure("ACTION_INPUT_MISMATCH");
    if (disposition.kind === "awaiting-input") {
      if (!same(disposition.request.episode, pending.episode)) return failure("ACTION_INPUT_MISMATCH");
      record.pendingAction = { ...pending, requestIdentity: disposition.request.identity };
      const checkpoint = await this.#checkpoint(record);
      const value: HostDisposition = {
        kind: "action-input",
        wait: { checkpoint, episode: pending.episode, request: disposition.request },
      };
      record.disposition = value;
      await this.#persist(record);
      return success(value);
    }
    if (disposition.kind !== "completed") return this.#actionFailure(record, pending, output);
    const action = pending.dispatch.action;
    const resultAccepted = validatesSchema(disposition.result, action.resultSchema) && await this.#passesGate(action, disposition.result);
    const outgoing = resultAccepted ? this.#projectOutgoing(record, pending.siteKey, disposition.result) : undefined;
    const hostAccepted = resultAccepted && outgoing !== undefined;
    const settled = await this.#custody.settleWorkspaceAttempt({
      episode: pending.episode,
      workspace: pending.workspace,
      hostDecision: hostAccepted ? "accept" : "reject",
    });
    if (!settled.ok) return failure("CHECKPOINT_ORDER_VIOLATION");
    if (!hostAccepted) {
      delete record.pendingAction;
      return this.#routeActionFailure(record, pending.site.nodeIdentity, output);
    }
    if (settled.value.kind !== "accepted") {
      delete record.pendingAction;
      return settled.value.kind === "restore-failed"
        ? this.#intervention(record, "INVARIANT_VIOLATION")
        : this.#routeActionFailure(record, pending.site.nodeIdentity, output);
    }
    if (settled.value.nextSavepoint.state === "unknown") return this.#intervention(record, "INVARIANT_VIOLATION");
    if (!("kind" in settled.value.nextSavepoint.value)) record.savepoint = known(settled.value.nextSavepoint.value);
    record.state = outgoing.state;
    record.artifacts = outgoing.artifacts;
    record.siteResults[pending.siteKey] = disposition.result;
    delete record.pendingAction;
    delete record.disposition;
    await this.#checkpoint(record);
    const advanced = await this.#advanceAfterSite(record, pending.site);
    return advanced ?? this.#drive(record, output);
  }

  async #actionFailure(
    record: HostThreadRecord,
    pending: PendingAction,
    output: ActionOutputSink,
  ): Promise<Result<HostDisposition, HostError>> {
    const settled = await this.#custody.settleWorkspaceAttempt({ episode: pending.episode, workspace: pending.workspace, hostDecision: "reject" });
    if (!settled.ok) return failure("CHECKPOINT_ORDER_VIOLATION");
    delete record.pendingAction;
    return settled.value.kind === "restore-failed"
      ? this.#intervention(record, "INVARIANT_VIOLATION")
      : this.#routeActionFailure(record, pending.site.nodeIdentity, output);
  }

  async #routeActionFailure(
    record: HostThreadRecord,
    nodeIdentity: NodeId,
    output: ActionOutputSink,
  ): Promise<Result<HostDisposition, HostError>> {
    const target = record.compiled.plan.control.eventSuccessor[nodeIdentity]?.["nonretryable-failure"];
    if (target === undefined) return this.#terminal(record, "FAILED", "ACTION_FAILED", hostUnknown("CALL_INTERRUPTED"));
    if (record.compiled.plan.control.nodes[target as NodeId] === undefined
      && record.compiled.plan.control.terminals[target as keyof typeof record.compiled.plan.control.terminals] === undefined) {
      return failure("ILLEGAL_SUCCESSOR");
    }
    delete record.parallel;
    record.currentTarget = target;
    await this.#checkpoint(record);
    return this.#drive(record, output);
  }

  async #advanceAfterSite(record: HostThreadRecord, site: ExecutionSiteRef): Promise<Result<HostDisposition, HostError> | undefined> {
    if (site.kind === "parallel-branch") {
      if (record.parallel === undefined || record.parallel.nodeIdentity !== site.nodeIdentity) return failure("ILLEGAL_SUCCESSOR");
      record.parallel.index += 1;
      await this.#checkpoint(record);
      return undefined;
    }
    if (site.kind === "parallel-join") {
      await this.#checkpoint(record);
      return undefined;
    }
    const target = record.compiled.plan.control.ordinarySuccessor[site.nodeIdentity];
    if (target === undefined) return failure("ILLEGAL_SUCCESSOR");
    record.currentTarget = target;
    await this.#checkpoint(record);
    return undefined;
  }

  async #workspace(
    record: HostThreadRecord,
    episode: EpisodeRef,
    access: InvocationDispatch["executor"]["turn"]["access"],
  ): Promise<Result<AuthorizedWorkspaceCapability, HostError>> {
    if (record.savepoint.state !== "known") return failure("CHECKPOINT_ORDER_VIOLATION");
    if (access.some((rule) => rule.mode === "write")) {
      const handle = await this.#custody.acquireWriteHandle({ episode, savepoint: record.savepoint.value, access });
      return handle.ok ? success({ kind: "write", handle: handle.value }) : failure("CHECKPOINT_ORDER_VIOLATION");
    }
    if (access.length > 0) {
      const view = await this.#custody.openReadView({ episode, source: record.savepoint.value, access });
      return view.ok ? success({ kind: "read", view: view.value }) : failure("CHECKPOINT_ORDER_VIOLATION");
    }
    return success({ kind: "none" });
  }

  #sessionAffinity(record: HostThreadRecord, episode: EpisodeRef, executor: InvocationDispatch["executor"]): SessionAffinityRef | undefined {
    const policy = executor.session.policy;
    const scopeValue = policy.scope.kind === "episode" ? episode : this.#sourceValue(record, policy.scope.source);
    if (scopeValue === undefined) return undefined;
    const scopeValueIdentity = canonicalDigest(scopeValue);
    return {
      identity: canonicalDigest({
        deliveryIdentity: record.thread.delivery.deliveryIdentity,
        sessionCompatibilityIdentity: executor.sessionCompatibilityIdentity,
        scopeValueIdentity,
        isolation: policy.isolation,
      }) as SessionAffinityId,
      delivery: record.thread.delivery,
      sessionCompatibilityIdentity: executor.sessionCompatibilityIdentity,
      scopeValueIdentity,
      isolation: policy.isolation,
    };
  }

  #materializeInput(record: HostThreadRecord, siteKey: CanonicalExecutionSiteKey): FrozenJsonValue | undefined {
    const edges = record.compiled.plan.dataflow.incomingBySite[siteKey] ?? [];
    if (edges.length === 0) return {};
    let whole: FrozenJsonValue | undefined;
    const properties: Record<string, FrozenJsonValue> = {};
    for (const edge of edges) {
      const value = this.#sourceValue(record, edge.source);
      if (value === undefined) {
        if (edge.source.kind === "site-result" && edge.source.site.kind === "parallel-branch"
          && record.parallel !== undefined && !record.parallel.selected.includes(edge.source.site.branchIdentity)) continue;
        return undefined;
      }
      if (edge.target.kind !== "site-input") return undefined;
      if (edge.target.slot.kind === "whole") {
        if (whole !== undefined || Object.keys(properties).length > 0) return undefined;
        whole = value;
      } else {
        if (whole !== undefined || edge.target.slot.name in properties) return undefined;
        properties[edge.target.slot.name] = value;
      }
    }
    return whole ?? properties;
  }

  #sourceValue(record: HostThreadRecord, source: SourcePortRef): FrozenJsonValue | undefined {
    if (source.kind === "context") return record.compiled.correlation[source.field] as FrozenJsonValue;
    if (source.kind === "state") return record.state[source.field];
    if (source.kind === "artifact") {
      const value = record.artifacts[source.artifactIdentity];
      return value === undefined || "kind" in value ? undefined : value as unknown as FrozenJsonValue;
    }
    if (source.kind === "site-result") return project(record.siteResults[executionSiteKey(source.site)]!, source.slot);
    if (source.kind === "control-result") return project(record.controlResults[source.controlIdentity]!, source.slot);
    return undefined;
  }

  #commitOutgoing(record: HostThreadRecord, producer: string, value: FrozenJsonValue): boolean {
    const projected = this.#projectOutgoing(record, producer, value);
    if (projected === undefined) return false;
    record.state = projected.state;
    record.artifacts = projected.artifacts;
    return true;
  }

  #projectOutgoing(record: HostThreadRecord, producer: string, value: FrozenJsonValue): ProjectedCommit | undefined {
    const edges = record.compiled.plan.dataflow.outgoingByProducer[producer as keyof typeof record.compiled.plan.dataflow.outgoingByProducer] ?? [];
    const state = { ...record.state };
    const artifacts = { ...record.artifacts };
    for (const edge of edges) {
      const projected = edge.source.kind === "site-result" || edge.source.kind === "control-result"
        ? project(value, edge.source.slot)
        : undefined;
      if (projected === undefined) return undefined;
      if (edge.target.kind === "state") state[edge.target.field] = projected;
      else if (edge.target.kind === "artifact") {
        const contentIdentity = canonicalDigest(projected);
        artifacts[edge.target.artifactIdentity] = {
          artifactIdentity: edge.target.artifactIdentity,
          versionIdentity: stableId("artifact-version", { artifact: edge.target.artifactIdentity, contentIdentity, producer }),
          contentIdentity,
        };
      }
    }
    return { state, artifacts };
  }

  async #passesGate(action: AdmittedActionTemplate, value: FrozenJsonValue): Promise<boolean> {
    for (const validatorIdentity of action.gate.deterministic ?? []) {
      const handler = this.#operations?.[validatorIdentity];
      if (handler === undefined) return false;
      const result = await handler.execute(value, {});
      if (!result.accepted) return false;
    }
    return action.gate.freeTextBypass === "prohibited";
  }

  async #evaluateDecision(record: HostThreadRecord, decisionIdentity: string): Promise<Target | undefined> {
    const decision = record.compiled.plan.control.decisions[decisionIdentity as keyof typeof record.compiled.plan.control.decisions];
    if (decision === undefined || !("selector" in decision)) return undefined;
    const source = this.#sourceValue(record, decision.source);
    if (source === undefined) return undefined;
    if (decision.selector.kind === "case-map") return decision.selector.cases.find((candidate) => same(candidate.value, source))?.target;
    const operation = record.compiled.plan.execution.hostOperations[decision.selector.operationIdentity];
    const handler = operation === undefined ? undefined : this.#operations?.[operation.contractIdentity];
    if (operation === undefined || handler === undefined) return undefined;
    const result = await handler.execute(source, operation.configuration);
    return result.accepted && typeof result.value === "string" && decision.selector.allowedTargets.includes(result.value)
      ? result.value
      : undefined;
  }

  async #workflowWait(
    record: HostThreadRecord,
    node: Extract<AdmittedControlNode, { kind: "wait" | "wait-renewal" }>,
  ): Promise<Result<HostDisposition, HostError>> {
    const control = Object.values(record.compiled.plan.control.controls).find((candidate) => candidate.nodeIdentity === node.id);
    if (control === undefined) return failure("CONTROL_MISMATCH");
    const content = this.#materializeControlInput(record, control.identity);
    if (content === undefined) return failure("DATAFLOW_BINDING_INVALID");
    const checkpoint = await this.#checkpoint(record);
    const request: ExternalControlRequest = {
      controlIdentity: control.identity,
      correlationIdentity: stableId("correlation", { thread: record.thread, control: control.identity, checkpoint: checkpoint.identity }),
      kind: control.kind,
      content,
      contentIdentity: canonicalDigest(content),
    };
    record.pendingWorkflow = { controlIdentity: control.identity, request };
    const value: HostDisposition = { kind: "workflow-wait", wait: { checkpoint, request } };
    record.disposition = value;
    await this.#persist(record);
    return success(value);
  }

  #materializeControlInput(record: HostThreadRecord, controlIdentity: string): FrozenJsonValue | undefined {
    const edges = record.compiled.plan.dataflow.incomingByControl[controlIdentity as keyof typeof record.compiled.plan.dataflow.incomingByControl] ?? [];
    if (edges.length === 0) return {};
    let whole: FrozenJsonValue | undefined;
    const properties: Record<string, FrozenJsonValue> = {};
    for (const edge of edges) {
      const value = this.#sourceValue(record, edge.source);
      if (value === undefined || edge.target.kind !== "control-input") return undefined;
      if (edge.target.slot.kind === "whole") {
        if (whole !== undefined || Object.keys(properties).length > 0) return undefined;
        whole = value;
      } else {
        if (whole !== undefined || edge.target.slot.name in properties) return undefined;
        properties[edge.target.slot.name] = value;
      }
    }
    return whole ?? properties;
  }

  async #declaredTerminal(record: HostThreadRecord, kind: string): Promise<Result<HostDisposition, HostError>> {
    const artifacts = Object.fromEntries(Object.entries(record.artifacts).filter((entry): entry is [string, ArtifactVersionRef] => !("kind" in entry[1])));
    const content = record.state as FrozenJsonValue;
    const result: BoundedWorkflowResult = {
      identity: stableId<WorkflowResultId>("workflow-result", { thread: record.thread, content, artifacts }),
      content,
      contentIdentity: canonicalDigest(content),
      artifacts: artifacts as Record<ArtifactId, ArtifactVersionRef>,
    };
    const reason = kind === "incomplete" ? "DECLARED_INCOMPLETE" : kind === "cancelled" ? "CANCELLED" : "DECLARED_TERMINAL";
    return this.#terminal(record, terminalOutcome(kind), reason, known(result));
  }

  async #terminal(
    record: HostThreadRecord,
    outcome: TerminalProposal["proposedOutcome"],
    reason: TerminalProposal["reason"],
    result: TerminalProposal["result"],
  ): Promise<Result<HostDisposition, HostError>> {
    const checkpoint = await this.#checkpoint(record);
    const proposal: TerminalProposal = { thread: record.thread, checkpoint, proposedOutcome: outcome, reason, result };
    const value: HostDisposition = { kind: "terminal-proposal", proposal };
    record.disposition = value;
    await this.#persist(record);
    return success(value);
  }

  async #intervention(record: HostThreadRecord, reason: TerminalProposal["reason"]): Promise<Result<HostDisposition, HostError>> {
    const checkpoint = record.checkpoint === undefined ? hostUnknown("CHECKPOINT_DISPOSITION_UNOBSERVED") : known(record.checkpoint);
    const value: HostDisposition = {
      kind: "intervention",
      intervention: {
        identity: stableId<InterventionId>("intervention", { thread: record.thread, reason, checkpoint }),
        thread: record.thread,
        reason,
        checkpoint,
      },
    };
    record.disposition = value;
    await this.#persist(record);
    return success(value);
  }

  async #checkpoint(record: HostThreadRecord): Promise<CheckpointRef> {
    const stateIdentity = canonicalDigest({ state: record.state, artifacts: record.artifacts, siteResults: record.siteResults, controlResults: record.controlResults });
    const checkpoint: CheckpointRef = {
      identity: stableId<CheckpointId>("checkpoint", { thread: record.thread, stateIdentity, savepoint: record.savepoint, sequence: record.sequence }),
      thread: record.thread,
      stateIdentity,
      savepoint: record.savepoint,
    };
    record.checkpoint = checkpoint;
    await this.#persist(record);
    return checkpoint;
  }

  async #persist(record: HostThreadRecord): Promise<void> {
    await this.#graph.invoke({ record }, { configurable: { thread_id: record.thread.threadIdentity } });
  }

  async #load(thread: ThreadRef): Promise<HostThreadRecord | undefined> {
    const snapshot = await this.#graph.getState({ configurable: { thread_id: thread.threadIdentity } });
    const record = snapshot.values.record;
    return record === undefined ? undefined : record;
  }
}

export function createLangGraphCoordinatorHost(options: LangGraphCoordinatorHostOptions): CoordinatorHost {
  return new LangGraphCoordinatorHost(options);
}
