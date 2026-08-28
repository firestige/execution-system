import { canonicalDigest } from "../contracts/index.js";
import { EVENT_RULES, PROFILE_ENUMS, PROFILE_FIELDS, type ObservationFieldId, type ObservationScalar } from "./profile.js";
import type { ObservationDiagnostic, ObservationMappableFact, ObservationRecord, ObservationResource, ObservationScope } from "./types.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const TRACE_ID = /^[a-f0-9]{32}$/u;
const SPAN_ID = /^[a-f0-9]{16}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;
const STANDARD = new Set(["gen_ai.operation.name","gen_ai.agent.id","gen_ai.agent.name","gen_ai.agent.version","gen_ai.provider.name","gen_ai.request.model","gen_ai.response.model","gen_ai.tool.name","gen_ai.tool.type","gen_ai.tool.call.id","gen_ai.usage.input_tokens","gen_ai.usage.output_tokens","error.type"]);

export interface ObservationMapperConfig { readonly serviceName: string; readonly serviceVersion: string }
export type ObservationMappingResult = Readonly<{ ok: true; record: ObservationRecord }> | Readonly<{ ok: false; diagnostic: ObservationDiagnostic }>;

function invalid(fact: ObservationMappableFact, code: ObservationDiagnostic["code"]): ObservationMappingResult {
  return Object.freeze({ ok: false, diagnostic: Object.freeze({ code, owner: fact.owner, phase: fact.phase, identity: fact.identity }) });
}

function fieldValid(id: ObservationFieldId, value: ObservationScalar): boolean {
  const definition = PROFILE_FIELDS[id];
  if (definition.type === "integer" && (!Number.isInteger(value) || (value as number) < 0)) return false;
  if (definition.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return false;
  const stringLimit = id === "C50" ? 512 : id === "C58" ? 160 : 128;
  if (definition.type === "string" && (typeof value !== "string" || value.length === 0 || value.length > stringLimit)) return false;
  if (id === "C58" && typeof value === "string" && value.trim() !== value) return false;
  if (id === "C02" && (typeof value !== "string" || !TASK_ID.test(value))) return false;
  if (PROFILE_ENUMS[id] !== undefined && !PROFILE_ENUMS[id]!.includes(value)) return false;
  if ((id === "C07" || id === "C29") && (typeof value !== "string" || !DIGEST.test(value))) return false;
  if (id === "C48" && (typeof value !== "number" || value > 1)) return false;
  return true;
}

function familyMatches(fact: ObservationMappableFact): boolean {
  if (fact.signal === "span") return fact.fields.C08 === undefined
    || (fact.familySchema === "implementation@1" ? fact.fields.C08 === "implementation" : fact.fields.C08 === "system-design");
  const family = fact.fields.C08;
  return fact.eventName === "sampling.decision" || fact.eventName === "task.binding"
    ? fact.fields.C49 === undefined
    : (fact.familySchema === "implementation@1" ? family === "implementation" : family === "system-design")
      && fact.fields.C49 === fact.familySchema;
}

function eventComplete(fact: Extract<ObservationMappableFact, { signal: "event" }>): boolean {
  const fields = fact.fields;
  if (fact.eventName === "review.finding") {
    const fix = fields.C21 !== undefined || fields.C22 !== undefined;
    const recheck = [fields.C23, fields.C24, fields.C25, fields.C26, fields.C27, fields.C35, fields.C38].some((value) => value !== undefined);
    if (fix && recheck) return false;
    if (fix && (fields.C21 === undefined || fields.C22 !== fields.C18)) return false;
    if (recheck && (fields.C23 === undefined || fields.C24 !== fields.C20 || fields.C25 !== fields.C18
      || fields.C27 === undefined || fields.C35 === undefined || fields.C38 === undefined)) return false;
    if (!fix && !recheck && fields.C20 !== fields.C12) return false;
    if (fields.C52 === "SECTION" && fields.C54 === undefined) return false;
    if (fields.C52 === "ARTIFACT" && fields.C54 !== undefined) return false;
  }
  if (fact.eventName === "review.summary") {
    const recheck = fields.C23 !== undefined;
    if (recheck && (fields.C24 === undefined || fields.C27 === undefined || fields.C35 === undefined || fields.C38 === undefined)) return false;
    if (!recheck && fields.C27 !== undefined) return false;
    if (fields.C13 === "FRESH_READER" && (fact.familySchema !== "system-design@1" || fields.S01 === undefined || fields.S02 === undefined)) return false;
  }
  if (fact.eventName === "implementation.summary" && typeof fields.I06 === "number" && typeof fields.I07 === "number" && fields.I06 > fields.I07) return false;
  return true;
}

function spanComplete(fact: Extract<ObservationMappableFact, { signal: "span" }>): boolean {
  const fieldIds = Object.keys(fact.fields) as ObservationFieldId[];
  if (fieldIds.some((id) => !["C01","C02","C03","C04","C05","C06","C07","C08","C30","C57"].includes(id))) return false;
  const operation = fact.standard["gen_ai.operation.name"];
  const root = fact.span.name.startsWith("invoke_workflow");
  if (root) return fact.span.kind === "INTERNAL" && ["C01","C03","C04","C05","C06","C07","C08"].every((id) => fact.fields[id as ObservationFieldId] !== undefined)
    && operation === undefined;
  if (["C01","C02","C03","C04","C05","C07","C08"].some((id) => fact.fields[id as ObservationFieldId] !== undefined)) return false;
  if (operation === "invoke_agent") return fact.span.kind === "INTERNAL" && typeof fact.standard["gen_ai.agent.id"] === "string";
  if (operation === "execute_tool") return fact.span.kind === "INTERNAL" && ["gen_ai.tool.name","gen_ai.tool.type","gen_ai.tool.call.id"].every((name) => typeof fact.standard[name] === "string");
  if (operation === "chat" || operation === "generate_content") {
    if (fact.span.kind !== "CLIENT" || typeof fact.standard["gen_ai.provider.name"] !== "string" || typeof fact.standard["gen_ai.request.model"] !== "string") return false;
    if ((fact.fields.C57 !== undefined || fact.fields.C30 !== undefined) && (fact.fields.C57 === undefined || fact.fields.C30 === undefined || fact.fields.C06 === undefined)) return false;
    return true;
  }
  return false;
}

export class DeliveryObservationMapper {
  readonly #resource: ObservationResource;
  readonly #scope: ObservationScope = Object.freeze({ name: "io.agentops.dsh.observation", version: "1.0.0", schema_url: "https://opentelemetry.io/schemas/1.41.0" });
  readonly #taskScope: ObservationScope = Object.freeze({ name: "io.agentops.dsh.observation", version: "2.0.0", schema_url: "https://opentelemetry.io/schemas/1.41.0" });
  constructor(config: ObservationMapperConfig) {
    if (typeof config.serviceName !== "string" || config.serviceName.length === 0 || config.serviceName.length > 128
      || typeof config.serviceVersion !== "string" || config.serviceVersion.length === 0 || config.serviceVersion.length > 128) throw new TypeError("OBSERVATION_MAPPER_CONFIG_INVALID");
    this.#resource = Object.freeze({ "service.name": config.serviceName, "service.version": config.serviceVersion });
  }

  map(fact: ObservationMappableFact): ObservationMappingResult {
    const { contentIdentity, ...content } = fact;
    if (contentIdentity !== canonicalDigest(content as never)) return invalid(fact, "OBSERVATION_OWNER_FACT_INVALID");
    const entries = Object.entries(fact.fields) as Array<[ObservationFieldId, ObservationScalar]>;
    if (entries.some(([id, value]) => PROFILE_FIELDS[id] === undefined || !fieldValid(id, value))) return invalid(fact, "OBSERVATION_FIELD_INVALID");
    if (fact.signal === "event") {
      const rule = EVENT_RULES[fact.eventName];
      const ids = new Set(entries.map(([id]) => id));
      if (entries.some(([id]) => !rule.allowed.includes(id))) return invalid(fact, "OBSERVATION_FIELD_PROHIBITED");
      if (entries.some(([id]) => (id.startsWith("I") && fact.familySchema !== "implementation@1")
        || (id.startsWith("S") && fact.familySchema !== "system-design@1"))) return invalid(fact, "OBSERVATION_FIELD_PROHIBITED");
      if (rule.required.some((id) => !ids.has(id)) || fact.fields.C09 !== fact.identity || !familyMatches(fact) || !eventComplete(fact)) return invalid(fact, "OBSERVATION_SHAPE_INCOMPLETE");
      const attributes = Object.freeze(Object.fromEntries(entries.map(([id, value]) => [PROFILE_FIELDS[id].name, value])));
      const taskBinding = fact.eventName === "task.binding";
      return Object.freeze({ ok: true, record: Object.freeze({ profile_version: taskBinding ? "2.0.0" : "1.0.0", record_type: "event", event_name: fact.eventName, resource: this.#resource, scope: taskBinding ? this.#taskScope : this.#scope, attributes, family_schema: fact.familySchema }) });
    }
    const standardEntries = Object.entries(fact.standard);
    const operation = fact.standard["gen_ai.operation.name"];
    const allowedStandard = new Set(operation === "invoke_agent"
      ? ["gen_ai.operation.name","gen_ai.agent.id","gen_ai.agent.name","gen_ai.agent.version","error.type"]
      : operation === "chat" || operation === "generate_content"
        ? ["gen_ai.operation.name","gen_ai.provider.name","gen_ai.request.model","gen_ai.response.model","gen_ai.usage.input_tokens","gen_ai.usage.output_tokens","error.type"]
        : operation === "execute_tool"
          ? ["gen_ai.operation.name","gen_ai.tool.name","gen_ai.tool.type","gen_ai.tool.call.id","error.type"]
          : ["error.type"]);
    const malformedStandard = standardEntries.some(([name, value]) => !STANDARD.has(name) || !allowedStandard.has(name)
      || (name === "gen_ai.usage.input_tokens" || name === "gen_ai.usage.output_tokens"
        ? !Number.isInteger(value) || (value as number) < 0
        : typeof value !== "string" || value.length === 0 || value.length > 128));
    if (!TRACE_ID.test(fact.correlation.traceId ?? "") || !SPAN_ID.test(fact.correlation.spanId ?? "")
      || (fact.span.parentSpanId !== undefined && !SPAN_ID.test(fact.span.parentSpanId))
      || !Number.isInteger(fact.span.flags) || fact.span.flags < 0 || fact.span.flags > 255
      || !/^(0|[1-9][0-9]{0,19})$/u.test(fact.span.startTimeUnixNano) || !/^(0|[1-9][0-9]{0,19})$/u.test(fact.span.endTimeUnixNano)
      || BigInt(fact.span.endTimeUnixNano) < BigInt(fact.span.startTimeUnixNano)
      || malformedStandard || !familyMatches(fact)) return invalid(fact, "OBSERVATION_FIELD_INVALID");
    if (!spanComplete(fact)) return invalid(fact, "OBSERVATION_SHAPE_INCOMPLETE");
    const attributes = Object.freeze({ ...Object.fromEntries(entries.map(([id, value]) => [PROFILE_FIELDS[id].name, value])), ...fact.standard });
    return Object.freeze({ ok: true, record: Object.freeze({
      profile_version: "1.0.0", record_type: "span", span_name: fact.span.name,
      trace_id: fact.correlation.traceId!, span_id: fact.correlation.spanId!, span_kind: fact.span.kind,
      start_time_unix_nano: fact.span.startTimeUnixNano, end_time_unix_nano: fact.span.endTimeUnixNano,
      ...(fact.span.parentSpanId === undefined ? {} : { parent_span_id: fact.span.parentSpanId }),
      span_flags: fact.span.flags, span_links: Object.freeze([]), span_status: fact.span.status,
      resource: this.#resource, scope: this.#scope, attributes, family_schema: fact.familySchema,
    }) });
  }
}
