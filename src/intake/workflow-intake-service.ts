import type { ExecutionApplication, ExecutionRequest, ExecutionResult, TaskPrompt } from "../application/execution-application.js";

export type WorkflowIntakeOperationName = "list" | "create" | "recover" | "status" | "action-finish" | "abandon";

export type WorkflowIntakeOperation =
  | Readonly<{ operation: "list"; correlation: string }>
  | Readonly<{
    operation: "create";
    selector: string;
    worktree: string;
    directive: string;
    turn: Readonly<{ text: string; attachments: TaskPrompt["attachments"] }>;
    correlation: string;
  }>
  | Readonly<{ operation: "recover"; worktree?: string; deliveryId?: string; correlation: string }>
  | Readonly<{ operation: "status"; worktree?: string; deliveryId?: string; correlation: string }>
  | Readonly<{ operation: "action-finish"; turn?: Readonly<{ text: string; attachments: TaskPrompt["attachments"] }>; correlation: string }>
  | Readonly<{ operation: "abandon"; deliveryId: string; correlation: string }>;

export interface IntakeDeliveryInventoryItem {
  readonly deliveryId: string;
  readonly worktree: string;
  readonly package: string;
  readonly lifecycle: string;
  readonly intakeBinding: "BOUND" | "DETACHED";
  readonly action: "IDLE" | "AWAITING_INPUT" | "UNKNOWN";
}

export interface IntakeDeliveryBindingInventoryItem extends IntakeDeliveryInventoryItem {
  readonly deliveryBindingIdentity: string;
}

export interface WorkflowIntakeControlPort {
  list(): Promise<readonly IntakeDeliveryInventoryItem[]>;
  recover(request: Readonly<{ worktree?: string; deliveryId?: string; correlation: string }>): Promise<ExecutionResult>;
  status(request: Readonly<{ worktree?: string; deliveryId?: string; correlation: string }>): Promise<ExecutionResult>;
  finishAction(request: Readonly<{ correlation: string; prompt?: TaskPrompt }>): Promise<ExecutionResult>;
}

export type WorkflowIntakeResult =
  | ExecutionResult
  | Readonly<{ kind: "LIST"; deliveries: readonly IntakeDeliveryInventoryItem[] }>
  | Readonly<{ kind: "ERROR"; code: "INTAKE_OPERATION_INVALID" | "INTAKE_CONTROL_UNAVAILABLE"; message: string }>;

function error(code: "INTAKE_OPERATION_INVALID" | "INTAKE_CONTROL_UNAVAILABLE"): WorkflowIntakeResult {
  return Object.freeze({ kind: "ERROR", code, message: code });
}

function record(value: unknown, required: readonly string[], allowed = required): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key): key is string => typeof key === "string")
    || required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.includes(key))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => descriptors[key] === undefined || !("value" in descriptors[key]!))) return undefined;
  return Object.fromEntries(keys.map((key) => [key, (descriptors[key] as PropertyDescriptor & { value: unknown }).value]));
}

function promptFromTurn(turn: unknown, directive?: unknown): TaskPrompt | undefined {
  const candidate = record(turn, ["text", "attachments"]);
  if (candidate === undefined || typeof candidate.text !== "string" || !Array.isArray(candidate.attachments)) return undefined;
  let text = candidate.text;
  if (directive !== undefined) {
    if (typeof directive !== "string" || directive.length === 0 || !text.startsWith(directive)) return undefined;
    text = text.slice(directive.length);
    if (text.startsWith("\r\n")) text = text.slice(2);
    else if (text.startsWith("\n") || text.startsWith(" ")) text = text.slice(1);
  }
  return Object.freeze({ text, attachments: Object.freeze([...candidate.attachments]) }) as TaskPrompt;
}

export class WorkflowIntakeService {
  static readonly operations = Object.freeze(["list", "create", "recover", "status", "action-finish", "abandon"] as const);
  readonly #application: ExecutionApplication;
  readonly #control?: WorkflowIntakeControlPort;
  readonly #execute: (request: ExecutionRequest, invocation?: unknown) => Promise<ExecutionResult>;

  constructor(options: Readonly<{
    application: ExecutionApplication;
    control?: WorkflowIntakeControlPort;
    execute?: (request: ExecutionRequest, invocation?: unknown) => Promise<ExecutionResult>;
  }>) {
    this.#application = options.application;
    this.#control = options.control;
    this.#execute = options.execute ?? options.application.execute.bind(options.application);
  }

  async invoke(candidate: WorkflowIntakeOperation, invocation?: unknown): Promise<WorkflowIntakeResult> {
    const base = record(candidate, ["operation"], ["operation", "selector", "worktree", "directive", "turn", "correlation", "deliveryId"]);
    if (base === undefined || typeof base.operation !== "string" || !WorkflowIntakeService.operations.includes(base.operation as WorkflowIntakeOperationName)) return error("INTAKE_OPERATION_INVALID");
    if (typeof base.correlation !== "string" || base.correlation.length === 0) return error("INTAKE_OPERATION_INVALID");
    if (base.operation === "create") {
      if (record(candidate, ["operation", "selector", "worktree", "directive", "turn", "correlation"]) === undefined
        || typeof base.selector !== "string" || typeof base.worktree !== "string") return error("INTAKE_OPERATION_INVALID");
      const prompt = promptFromTurn(base.turn, base.directive);
      if (prompt === undefined) return error("INTAKE_OPERATION_INVALID");
      const request: ExecutionRequest = Object.freeze({
        worktree: base.worktree,
        selector: base.selector,
        prompt,
        intakeCorrelation: base.correlation,
      });
      return this.#execute(request, invocation);
    }
    if (base.operation === "list") {
      if (record(candidate, ["operation", "correlation"]) === undefined) return error("INTAKE_OPERATION_INVALID");
      return this.#control === undefined ? error("INTAKE_CONTROL_UNAVAILABLE") : Object.freeze({ kind: "LIST", deliveries: await this.#control.list() });
    }
    if (base.operation === "recover") {
      if (record(candidate, ["operation", "correlation"], ["operation", "worktree", "deliveryId", "correlation"]) === undefined
        || (base.worktree !== undefined && typeof base.worktree !== "string")
        || (base.deliveryId !== undefined && typeof base.deliveryId !== "string")
        || (base.worktree === undefined && base.deliveryId === undefined)) return error("INTAKE_OPERATION_INVALID");
      return this.#control?.recover({ ...(base.worktree === undefined ? {} : { worktree: base.worktree }), ...(base.deliveryId === undefined ? {} : { deliveryId: base.deliveryId }), correlation: base.correlation }) ?? error("INTAKE_CONTROL_UNAVAILABLE");
    }
    if (base.operation === "status") {
      if (record(candidate, ["operation", "correlation"], ["operation", "worktree", "deliveryId", "correlation"]) === undefined
        || (base.worktree !== undefined && typeof base.worktree !== "string") || (base.deliveryId !== undefined && typeof base.deliveryId !== "string")) return error("INTAKE_OPERATION_INVALID");
      return this.#control?.status({ ...(base.worktree === undefined ? {} : { worktree: base.worktree }), ...(base.deliveryId === undefined ? {} : { deliveryId: base.deliveryId }), correlation: base.correlation }) ?? error("INTAKE_CONTROL_UNAVAILABLE");
    }
    if (base.operation === "action-finish") {
      if (record(candidate, ["operation", "correlation"], ["operation", "turn", "correlation"]) === undefined) return error("INTAKE_OPERATION_INVALID");
      const prompt = base.turn === undefined ? undefined : promptFromTurn(base.turn);
      if (base.turn !== undefined && prompt === undefined) return error("INTAKE_OPERATION_INVALID");
      return this.#control?.finishAction({ correlation: base.correlation, ...(prompt === undefined ? {} : { prompt }) }) ?? error("INTAKE_CONTROL_UNAVAILABLE");
    }
    if (record(candidate, ["operation", "deliveryId", "correlation"]) === undefined || typeof base.deliveryId !== "string") return error("INTAKE_OPERATION_INVALID");
    return this.#application.cancel(base.deliveryId);
  }
}

export interface InMemoryIntakeAdapter {
  readonly kind: "command" | "intake-tool";
  invoke(operation: WorkflowIntakeOperation): Promise<WorkflowIntakeResult>;
}

export function createInMemoryIntakeAdapter(service: WorkflowIntakeService, kind: InMemoryIntakeAdapter["kind"]): InMemoryIntakeAdapter {
  return Object.freeze({ kind, invoke: service.invoke.bind(service) });
}

export function renderIntakeResult(result: WorkflowIntakeResult, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("INTAKE_RENDER_BOUND_INVALID");
  const value = result as unknown as Record<string, unknown>;
  const allowed = ["kind", "code", "message", "worktree", "deliveryId", "state", "outcome", "admissionId", "deliveries"];
  const safe = Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  let rendered = JSON.stringify(safe);
  if (Buffer.byteLength(rendered, "utf8") <= maxBytes) return rendered;
  rendered = JSON.stringify({ kind: safe.kind ?? "ERROR", code: safe.code ?? "OUTPUT_TRUNCATED", truncated: true });
  return Buffer.byteLength(rendered, "utf8") <= maxBytes ? rendered : '{"kind":"ERROR","code":"OUTPUT_TRUNCATED"}';
}
