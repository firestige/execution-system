import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DeliveryObservationMapper,
  OBSERVATION_PROFILE_SOURCE_MATRIX,
  createObservationOwnerFact,
  createObservationSamplingFact,
  encodeOtlpRequest,
  type ObservationEventName,
  type ObservationFieldId,
  type ObservationScalar,
} from "../../src/observation/index.js";

const require = createRequire(import.meta.url);
const oracle = require("../../../system-contracts/observation/tools/validator.cjs") as {
  decodeOtlpRequest(signal: "traces" | "logs", bytes: Buffer, options: { familySchema: string }): { decision: string; record_count: number };
};
const mapper = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" });
const digest = "a".repeat(64);

function fact(eventName: ObservationEventName, identity: string, familySchema: "implementation@1" | "system-design@1", fields: Partial<Record<ObservationFieldId, ObservationScalar>>) {
  if (eventName === "sampling.decision") return createObservationSamplingFact({
    correlation: { deliveryId: "delivery-1" }, identity, familySchema, fields,
  });
  return createObservationOwnerFact({
    owner: eventName === "delivery.summary" ? "M02" : "DSH",
    phase: eventName === "delivery.summary" ? "DELIVERY_TERMINAL" : "WORKFLOW_FACT",
    correlation: { deliveryId: "delivery-1" }, identity, signal: "event", eventName, familySchema, fields,
  } as never);
}

function mappedEvent(eventName: ObservationEventName, identity: string, familySchema: "implementation@1" | "system-design@1", fields: Partial<Record<ObservationFieldId, ObservationScalar>>) {
  const result = mapper.map(fact(eventName, identity, familySchema, fields));
  if (!result.ok) throw new Error(`${result.diagnostic.code}:${eventName}`);
  return result.record;
}

describe("M03 producer-role corpus", () => {
  it("emits Delivery, Agent, model, and tool Spans with exact native identity and attribution", () => {
    const base = { startTimeUnixNano: "100", endTimeUnixNano: "200", flags: 1, status: "UNSET" as const };
    const facts = [
      createObservationOwnerFact({ owner: "M01", phase: "DELIVERY_BOUND", correlation: { deliveryId: "delivery-1", traceId: "1".repeat(32), spanId: "1".repeat(16) }, identity: "span-root", signal: "span", familySchema: "implementation@1", span: { ...base, name: "invoke_workflow delivery-1", kind: "INTERNAL" }, fields: { C01: "delivery-1", C03: "workflow-1", C04: "1.0.0", C05: "implementation-1", C06: "runtime-1", C07: digest, C08: "implementation" }, standard: {} }),
      createObservationOwnerFact({ owner: "M02", phase: "ACTIVITY", correlation: { deliveryId: "delivery-1", traceId: "1".repeat(32), spanId: "2".repeat(16) }, identity: "span-agent", signal: "span", familySchema: "implementation@1", span: { ...base, name: "invoke_agent role-1", kind: "INTERNAL", parentSpanId: "1".repeat(16) }, fields: {}, standard: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.id": "role-1" } }),
      createObservationOwnerFact({ owner: "M02", phase: "ACTIVITY", correlation: { deliveryId: "delivery-1", traceId: "1".repeat(32), spanId: "3".repeat(16) }, identity: "span-model", signal: "span", familySchema: "implementation@1", span: { ...base, name: "chat model-1", kind: "CLIENT", parentSpanId: "2".repeat(16) }, fields: { C06: "runtime-1", C30: "role-1", C57: "model-1" }, standard: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "provider-1", "gen_ai.request.model": "model-1" } }),
      createObservationOwnerFact({ owner: "M02", phase: "ACTIVITY", correlation: { deliveryId: "delivery-1", traceId: "1".repeat(32), spanId: "4".repeat(16) }, identity: "span-tool", signal: "span", familySchema: "implementation@1", span: { ...base, name: "execute_tool tool-1", kind: "INTERNAL", parentSpanId: "2".repeat(16) }, fields: {}, standard: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "tool-1", "gen_ai.tool.type": "function", "gen_ai.tool.call.id": "call-1" } }),
    ];
    const records = facts.map((input) => {
      const result = mapper.map(input);
      if (!result.ok) throw new Error(result.diagnostic.code);
      return result.record;
    });
    expect(oracle.decodeOtlpRequest("traces", Buffer.from(encodeOtlpRequest("traces", records)), { familySchema: "implementation@1" })).toMatchObject({ decision: "ACCEPT", record_count: 4 });
  });

  it("emits every EventName as official protobuf accepted by the independent shared oracle", () => {
    const implementation = [
      mappedEvent("delivery.summary", "event-delivery", "implementation@1", { C08: "implementation", C09: "event-delivery", C10: "COMPLETED", C11: "FINAL", C49: "implementation@1" }),
      mappedEvent("review.finding", "event-finding", "implementation@1", { C08: "implementation", C09: "event-finding", C12: "review-1", C13: "IMPLEMENTATION_WHITEBOX", C14: "WHOLE_SCOPE", C15: "MAJOR", C18: "finding-1", C19: "OPEN", C20: "review-1", C28: "artifact-1", C29: digest, C33: "writer", C34: "reviewer", C36: "invocation-w", C37: "invocation-r", C49: "implementation@1", C50: "Prompt handling needs an explicit lifecycle check", C51: "scope-1", C52: "ARTIFACT", C53: "artifact-1" }),
      mappedEvent("review.summary", "event-review", "implementation@1", { C08: "implementation", C09: "event-review", C11: "FINAL", C12: "review-1", C13: "IMPLEMENTATION_WHITEBOX", C14: "WHOLE_SCOPE", C28: "artifact-1", C29: digest, C33: "writer", C34: "reviewer", C36: "invocation-w", C37: "invocation-r", C49: "implementation@1" }),
      mappedEvent("test.summary", "event-test", "implementation@1", { C08: "implementation", C09: "event-test", C11: "FINAL", C28: "report-test", C29: digest, C49: "implementation@1", I01: 8, I02: 0, I03: 1 }),
      mappedEvent("implementation.summary", "event-coverage", "implementation@1", { C08: "implementation", C09: "event-coverage", C11: "FINAL", C28: "report-coverage", C29: digest, C49: "implementation@1", I05: "line", I06: 90, I07: 100, I08: "execution", I09: "vitest-4", I10: "v8" }),
      mappedEvent("role.lineage", "event-lineage", "implementation@1", { C08: "implementation", C09: "event-lineage", C30: "role-1", C31: "lineage-1", C49: "implementation@1" }),
      mappedEvent("intervention", "event-intervention", "implementation@1", { C08: "implementation", C09: "event-intervention", C39: "USER_REDIRECT", C49: "implementation@1" }),
      mappedEvent("usage", "event-usage", "implementation@1", { C08: "implementation", C09: "event-usage", C11: "FINAL", C42: "request", C43: "request", C44: "provider", C45: "provider-1", C46: 1, C49: "implementation@1" }),
      mappedEvent("sampling.decision", "event-sampling", "implementation@1", { C09: "event-sampling", C47: "RECORD_AND_SAMPLE", C48: 1 }),
    ];
    const systemDesign = [
      mappedEvent("system_design.summary", "event-verification", "system-design@1", { C08: "system-design", C09: "event-verification", C11: "FINAL", C28: "report-design", C29: digest, C49: "system-design@1", S03: "verification-1", S04: "PASS", S05: 10, S06: 0 }),
    ];
    expect(oracle.decodeOtlpRequest("logs", Buffer.from(encodeOtlpRequest("logs", implementation)), { familySchema: "implementation@1" })).toMatchObject({ decision: "ACCEPT", record_count: 9 });
    expect(oracle.decodeOtlpRequest("logs", Buffer.from(encodeOtlpRequest("logs", systemDesign)), { familySchema: "system-design@1" })).toMatchObject({ decision: "ACCEPT", record_count: 1 });
  });

  it("preserves complete Finding/Fix/Recheck and multi-target variants", async () => {
    const byName = new Map<string, ObservationFieldId>();
    for (const [id, name] of Object.entries({
      ...OBSERVATION_PROFILE_SOURCE_MATRIX.fields.common,
      ...OBSERVATION_PROFILE_SOURCE_MATRIX.fields.implementation,
      ...OBSERVATION_PROFILE_SOURCE_MATRIX.fields.systemDesign,
    })) byName.set(name.name, id as ObservationFieldId);
    const records = [];
    for (const relative of ["fixtures/positive/finding-fix-recheck.json", "fixtures/multi-target/two-sections.json"]) {
      const fixture = JSON.parse(await readFile(path.join("../system-contracts/observation", relative), "utf8"));
      for (const record of fixture.input.records) {
        const fields = Object.fromEntries(Object.entries(record.attributes).map(([name, value]) => [byName.get(name), value])) as Partial<Record<ObservationFieldId, ObservationScalar>>;
        records.push(mappedEvent(record.event_name, record.attributes["agentops.event.id"], record.attributes["agentops.family.schema"], fields));
      }
    }
    const implementation = records.filter((record) => record.family_schema === "implementation@1");
    const systemDesign = records.filter((record) => record.family_schema === "system-design@1");
    expect(oracle.decodeOtlpRequest("logs", Buffer.from(encodeOtlpRequest("logs", implementation)), { familySchema: "implementation@1" }).decision).toBe("ACCEPT");
    expect(oracle.decodeOtlpRequest("logs", Buffer.from(encodeOtlpRequest("logs", systemDesign)), { familySchema: "system-design@1" }).decision).toBe("ACCEPT");
  });

  it("rejects incomplete lifecycle variants and incomplete canonical model attribution before export", () => {
    const incompleteFix = mapper.map(fact("review.finding", "event-bad-fix", "implementation@1", {
      C08: "implementation", C09: "event-bad-fix", C12: "review-fix", C13: "IMPLEMENTATION_WHITEBOX", C14: "WHOLE_SCOPE", C15: "MAJOR", C18: "finding-1", C19: "CLOSED_FIXED", C20: "review-1", C21: "fix-1", C28: "artifact-1", C29: digest, C33: "writer", C34: "reviewer", C36: "invocation-w", C37: "invocation-r", C49: "implementation@1", C50: "bounded finding", C51: "scope-1", C52: "ARTIFACT", C53: "artifact-1",
    }));
    expect(incompleteFix).toMatchObject({ ok: false, diagnostic: { code: "OBSERVATION_SHAPE_INCOMPLETE" } });

    const incompleteModel = mapper.map(createObservationOwnerFact({
      owner: "M02", phase: "ACTIVITY", correlation: { deliveryId: "delivery-1", traceId: "1".repeat(32), spanId: "2".repeat(16) }, identity: "span-model-1", signal: "span", familySchema: "implementation@1",
      span: { name: "chat model", kind: "CLIENT", startTimeUnixNano: "1", endTimeUnixNano: "2", flags: 1, status: "UNSET" },
      fields: { C57: "model-1" }, standard: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "provider", "gen_ai.request.model": "model-1" },
    }));
    expect(incompleteModel).toMatchObject({ ok: false, diagnostic: { code: "OBSERVATION_SHAPE_INCOMPLETE" } });
  });

  it("uses Event shape rather than a Workflow-name allowlist for specialized fields and rejects malformed native Span formats", () => {
    const sibling = mapper.map(fact("review.summary", "event-sibling", "implementation@1", {
      C08: "implementation", C09: "event-sibling", C11: "FINAL", C12: "review-1", C13: "FRESH_READER", C14: "WHOLE_SCOPE", C28: "artifact-1", C29: digest, C33: "writer", C34: "reviewer", C36: "invocation-w", C37: "invocation-r", C49: "implementation@1", S01: "PASS", S02: 0,
    }));
    expect(sibling).toMatchObject({ ok: true });

    const malformed = mapper.map(createObservationOwnerFact({
      owner: "M02", phase: "ACTIVITY", correlation: { deliveryId: "delivery-1", traceId: "1".repeat(32), spanId: "2".repeat(16) }, identity: "span-malformed", signal: "span", familySchema: "implementation@1",
      span: { name: "chat model", kind: "CLIENT", startTimeUnixNano: "1", endTimeUnixNano: "2", parentSpanId: "short", flags: 300, status: "UNSET" },
      fields: { C06: "runtime-1", C30: "role-1" }, standard: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "provider", "gen_ai.request.model": "model-1", "gen_ai.usage.input_tokens": "10" },
    }));
    expect(malformed).toMatchObject({ ok: false, diagnostic: { code: "OBSERVATION_FIELD_INVALID" } });
  });
});
