import { canonicalDigest } from "../contracts/index.js";
import type { ObservationEventName, ObservationFamilySchema, ObservationFieldId, ObservationScalar } from "./profile.js";

export type ObservationFactOwner = "M01" | "M02" | "DSH";
export type ObservationOwnerPhase = "DELIVERY_BOUND" | "DELIVERY_TERMINAL" | "RUNNER_TERMINAL_SETTLED" | "ACTIVITY" | "WORKFLOW_FACT";

export interface ObservationCorrelation {
  readonly deliveryId: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

interface ObservationEventFactCore {
  readonly schemaVersion: "execution.observation-owner-fact@1.0.0";
  readonly correlation: ObservationCorrelation;
  readonly identity: string;
  readonly contentIdentity: string;
  readonly signal: "event";
  readonly eventName: ObservationEventName;
  readonly familySchema: ObservationFamilySchema;
  readonly fields: Readonly<Partial<Record<ObservationFieldId, ObservationScalar>>>;
}

export type ObservationEventOwnerFact = ObservationEventFactCore & (
  | Readonly<{ owner: "M01"; phase: "DELIVERY_BOUND"; eventName: "task.binding" }>
  | Readonly<{ owner: "M02"; phase: "DELIVERY_TERMINAL"; eventName: "delivery.summary" }>
  | Readonly<{ owner: "DSH"; phase: "WORKFLOW_FACT"; eventName: Exclude<ObservationEventName, "delivery.summary" | "sampling.decision" | "task.binding"> }>
);

interface ObservationSpanFactCore {
  readonly schemaVersion: "execution.observation-owner-fact@1.0.0";
  readonly correlation: ObservationCorrelation;
  readonly identity: string;
  readonly contentIdentity: string;
  readonly signal: "span";
  readonly familySchema: ObservationFamilySchema;
  readonly span: Readonly<{
    name: string;
    kind: "INTERNAL" | "CLIENT";
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    parentSpanId?: string;
    flags: number;
    status: "UNSET" | "OK" | "ERROR";
  }>;
  readonly fields: Readonly<Partial<Record<ObservationFieldId, ObservationScalar>>>;
  readonly standard: Readonly<Record<string, ObservationScalar>>;
}

export type ObservationSpanOwnerFact = ObservationSpanFactCore & (
  | Readonly<{ owner: "M01"; phase: "DELIVERY_BOUND" }>
  | Readonly<{ owner: "M02"; phase: "ACTIVITY" }>
  | Readonly<{ owner: "DSH"; phase: "ACTIVITY" }>
);

export interface RunnerSettlementOwnerFact {
  readonly schemaVersion: "execution.observation-owner-fact@1.0.0";
  readonly owner: "M02";
  readonly phase: "RUNNER_TERMINAL_SETTLED";
  readonly signal: "runner-settlement";
  readonly identity: string;
  readonly contentIdentity: string;
  readonly correlation: Readonly<{
    deliveryId: string;
    manifestBindingIdentity: string;
    activationBindingIdentity: string;
  }>;
}

export type ObservationProfileOwnerFact = ObservationEventOwnerFact | ObservationSpanOwnerFact;
export type ObservationOwnerFact = ObservationProfileOwnerFact | RunnerSettlementOwnerFact;
export type ObservationSamplingFact = ObservationEventFactCore & Readonly<{ owner: "M03"; phase: "SAMPLING_DECISION"; eventName: "sampling.decision" }>;
export type ObservationMappableFact = ObservationProfileOwnerFact | ObservationSamplingFact;
export type ObservationInputFact = ObservationOwnerFact | ObservationSamplingFact;
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "schemaVersion" | "contentIdentity"> : never;
type EventFactInput = WithoutEnvelope<ObservationEventOwnerFact>;
type SpanFactInput = WithoutEnvelope<ObservationSpanOwnerFact>;
type SamplingFactInput = Omit<ObservationSamplingFact, "schemaVersion" | "contentIdentity" | "owner" | "phase" | "eventName" | "signal">;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function createObservationOwnerFact(input: EventFactInput | SpanFactInput): ObservationProfileOwnerFact {
  const eventKeys = ["owner","phase","correlation","identity","signal","eventName","familySchema","fields"];
  const spanKeys = ["owner","phase","correlation","identity","signal","familySchema","span","fields","standard"];
  const correlationKeys = Object.keys(input.correlation);
  const allowedCorrelation = ["deliveryId", "traceId", "spanId"];
  const candidate = input as unknown as Readonly<{ signal: string; owner: string; phase: string; eventName?: string }>;
  const combinationAllowed = candidate.signal === "event"
    ? (candidate.owner === "M01" && candidate.phase === "DELIVERY_BOUND" && candidate.eventName === "task.binding")
      || (candidate.owner === "M02" && candidate.phase === "DELIVERY_TERMINAL" && candidate.eventName === "delivery.summary")
      || (candidate.owner === "DSH" && candidate.phase === "WORKFLOW_FACT" && candidate.eventName !== "delivery.summary" && candidate.eventName !== "sampling.decision" && candidate.eventName !== "task.binding")
    : (candidate.owner === "M01" && candidate.phase === "DELIVERY_BOUND")
      || (candidate.owner === "M02" && candidate.phase === "ACTIVITY")
      || (candidate.owner === "DSH" && candidate.phase === "ACTIVITY");
  if (!exactRecord(input, input.signal === "event" ? eventKeys : spanKeys)
    || correlationKeys.some((key) => !allowedCorrelation.includes(key))
    || !combinationAllowed
    || typeof input.identity !== "string" || input.identity.length === 0 || input.identity.length > 128
    || typeof input.correlation.deliveryId !== "string" || input.correlation.deliveryId.length === 0) {
    throw new TypeError("OBSERVATION_OWNER_FACT_INVALID");
  }
  const base = Object.freeze({ schemaVersion: "execution.observation-owner-fact@1.0.0" as const, ...input });
  return Object.freeze({ ...base, contentIdentity: canonicalDigest(base as never) }) as ObservationProfileOwnerFact;
}

export function createObservationSamplingFact(input: SamplingFactInput): ObservationSamplingFact {
  const keys = ["correlation", "identity", "familySchema", "fields"];
  if (!exactRecord(input, keys) || typeof input.identity !== "string" || input.identity.length === 0 || input.identity.length > 128
    || !exactRecord(input.correlation, ["deliveryId"]) || typeof input.correlation.deliveryId !== "string" || input.correlation.deliveryId.length === 0) {
    throw new TypeError("OBSERVATION_OWNER_FACT_INVALID");
  }
  const content = Object.freeze({
    schemaVersion: "execution.observation-owner-fact@1.0.0" as const,
    owner: "M03" as const,
    phase: "SAMPLING_DECISION" as const,
    correlation: input.correlation,
    identity: input.identity,
    signal: "event" as const,
    eventName: "sampling.decision" as const,
    familySchema: input.familySchema,
    fields: input.fields,
  });
  return Object.freeze({ ...content, contentIdentity: canonicalDigest(content as never) });
}

export interface ObservationResource { readonly "service.name": string; readonly "service.version": string }
export interface ObservationScope { readonly name: "io.agentops.dsh.observation"; readonly version: "1.0.0" | "2.0.0"; readonly schema_url: "https://opentelemetry.io/schemas/1.41.0" }
export interface ObservationEventRecord {
  readonly profile_version: "1.0.0" | "2.0.0";
  readonly record_type: "event";
  readonly event_name: ObservationEventName;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly resource: ObservationResource;
  readonly scope: ObservationScope;
  readonly attributes: Readonly<Record<string, ObservationScalar>>;
  readonly family_schema: ObservationFamilySchema;
}
export interface ObservationSpanRecord {
  readonly profile_version: "1.0.0";
  readonly record_type: "span";
  readonly span_name: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly span_kind: "INTERNAL" | "CLIENT";
  readonly start_time_unix_nano: string;
  readonly end_time_unix_nano: string;
  readonly parent_span_id?: string;
  readonly span_flags: number;
  readonly span_links: readonly never[];
  readonly span_status: "UNSET" | "OK" | "ERROR";
  readonly resource: ObservationResource;
  readonly scope: ObservationScope;
  readonly attributes: Readonly<Record<string, ObservationScalar>>;
  readonly family_schema: ObservationFamilySchema;
}
export type ObservationRecord = ObservationEventRecord | ObservationSpanRecord;

export interface ObservationDiagnostic {
  readonly code: "OBSERVATION_OWNER_FACT_INVALID" | "OBSERVATION_SHAPE_INCOMPLETE" | "OBSERVATION_FIELD_PROHIBITED" | "OBSERVATION_FIELD_INVALID";
  readonly owner?: ObservationFactOwner | "M03";
  readonly phase?: ObservationOwnerPhase | "SAMPLING_DECISION";
  readonly identity?: string;
}
