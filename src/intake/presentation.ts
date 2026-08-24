import type { FrozenJsonValue } from "../contracts/index.js";
import type { WorkflowIntakeResult } from "./workflow-intake-service.js";

export const WSR_PRESENTATION_VERSION = "wsr.presentation@1.0.0" as const;

export type IntakePresentationKind =
  | "command-accepted"
  | "delivery-running"
  | "delivery-list"
  | "delivery-status"
  | "action-output"
  | "action-input-request"
  | "terminal-result"
  | "error";

export interface IntakePresentation {
  readonly schemaVersion: typeof WSR_PRESENTATION_VERSION;
  readonly correlation: string;
  readonly kind: IntakePresentationKind;
  readonly data: Readonly<Record<string, FrozenJsonValue>>;
}

const KINDS = new Set<IntakePresentationKind>([
  "command-accepted", "delivery-running", "delivery-list", "delivery-status",
  "action-output", "action-input-request", "terminal-result", "error",
]);

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validJson(value: unknown, seen = new Set<object>()): value is FrozenJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => validJson(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every((key) => typeof key === "string"
    && descriptors[key] !== undefined && "value" in descriptors[key]!
    && validJson((descriptors[key] as PropertyDescriptor & { value: unknown }).value, seen));
}

export function createIntakePresentation(
  correlation: string,
  kind: IntakePresentationKind,
  data: Readonly<Record<string, FrozenJsonValue>>,
): IntakePresentation {
  if (typeof correlation !== "string" || correlation.length === 0 || !KINDS.has(kind)
    || !validJson(data) || Array.isArray(data)) throw new TypeError("INTAKE_PRESENTATION_INVALID");
  return deepFreeze({ schemaVersion: WSR_PRESENTATION_VERSION, correlation, kind, data });
}

function truncated(correlation: string): IntakePresentation {
  return createIntakePresentation(correlation, "error", { code: "OUTPUT_TRUNCATED", message: "OUTPUT_TRUNCATED" });
}

export function serializeIntakePresentation(event: IntakePresentation, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("INTAKE_PRESENTATION_BOUND_INVALID");
  const rendered = JSON.stringify(event);
  if (Buffer.byteLength(rendered, "utf8") <= maxBytes) return rendered;
  const bounded = JSON.stringify(truncated(event.correlation));
  if (Buffer.byteLength(bounded, "utf8") > maxBytes) throw new TypeError("INTAKE_PRESENTATION_BOUND_INVALID");
  return bounded;
}

function statusData(result: Record<string, unknown>): Readonly<Record<string, FrozenJsonValue>> {
  const data: Record<string, FrozenJsonValue> = {};
  for (const key of ["worktree", "deliveryId", "state", "admissionId"] as const) {
    if (typeof result[key] === "string") data[key] = result[key];
  }
  return data;
}

export function presentationForIntakeResult(
  correlation: string,
  result: WorkflowIntakeResult,
  maxBytes: number,
): IntakePresentation {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("INTAKE_PRESENTATION_BOUND_INVALID");
  const value = result as unknown as Record<string, unknown>;
  let event: IntakePresentation;
  if (result.kind === "LIST") event = createIntakePresentation(correlation, "delivery-list", { items: result.deliveries as unknown as FrozenJsonValue });
  else if (result.kind === "START_UNCERTAIN") event = createIntakePresentation(correlation, "delivery-running", statusData(value));
  else if (result.kind === "TERMINAL") event = createIntakePresentation(correlation, "terminal-result", {
    worktree: result.worktree, deliveryId: result.deliveryId, outcome: result.outcome,
    ...(result.summary === undefined ? {} : { summary: result.summary }),
  });
  else if (result.kind === "ERROR") event = createIntakePresentation(correlation, "error", { code: result.code, message: result.message });
  else event = createIntakePresentation(correlation, "delivery-status", statusData(value));
  return Buffer.byteLength(JSON.stringify(event), "utf8") <= maxBytes ? event : truncated(correlation);
}

export function actionOutputPresentation(correlation: string, content: FrozenJsonValue): IntakePresentation {
  return createIntakePresentation(correlation, "action-output", { content });
}

export function actionInputRequestPresentation(correlation: string, prompt: FrozenJsonValue): IntakePresentation {
  return createIntakePresentation(correlation, "action-input-request", { prompt });
}
