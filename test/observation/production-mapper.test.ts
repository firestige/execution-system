import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DeliveryObservationMapper,
  OBSERVATION_PROFILE_SOURCE_MATRIX,
  createObservationOwnerFact,
} from "../../src/observation/index.js";
import { createTaskBindingObservationFact } from "../../src/bootstrap/index.js";
import type { DeliveryBoundOwnerFact } from "../../src/bootstrap/index.js";
import { canonicalJsonBytes } from "../../src/configuration/index.js";

const contractRoot = path.resolve("../system-contracts/observation");

function manifestProjection(deliveryId = "delivery-1", taskId = "task-1", manifestDigest = "a".repeat(64)) {
  const projection = {
    schema_version: "execution.delivery-manifest-projection@1.0.0",
    delivery_id: deliveryId,
    task_id: taskId,
    manifest_digest: manifestDigest,
    workflow: {
      package_name: "system-design",
      exact_package_version: "2.0.0",
      package_digest: `sha256:${"b".repeat(64)}`,
      workflow_id: "workflow.system-design",
      workflow_version: "2.0.0",
      snapshot_id: "snapshot.system-design.2",
      snapshot_digest: `sha256:${"c".repeat(64)}`,
    },
    repository_model_bindings: {
      document_state: "ABSENT",
      resolved_map_digest: `sha256:${createHash("sha256").update("[]").digest("hex")}`,
    },
    roles: [],
  };
  const canonical = Buffer.from(canonicalJsonBytes(projection as never)).toString("utf8");
  return { canonical, digest: createHash("sha256").update(canonical).digest("hex") };
}

const taskBindingIdentity = (deliveryId: string): string => `task-binding-${createHash("sha256").update(deliveryId).digest("hex").slice(0, 24)}`;

describe("M03 production owner-fact mapper", () => {
  it("preserves exact Event Trace/Span correlation for the native LogRecord context", () => {
    const mapped = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" })
      .map(createObservationOwnerFact({
        owner: "M02",
        phase: "DELIVERY_TERMINAL",
        correlation: {
          deliveryId: "delivery-1",
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
        },
        identity: "delivery-summary-1",
        signal: "event",
        eventName: "delivery.summary",
        familySchema: "implementation@1",
        fields: {
          C08: "implementation",
          C09: "delivery-summary-1",
          C10: "COMPLETED",
          C11: "FINAL",
          C49: "implementation@1",
        },
      }));

    expect(mapped).toMatchObject({
      ok: true,
      record: { trace_id: "1".repeat(32), span_id: "2".repeat(16) },
    });
  });

  it("maps admission-time Task binding with display metadata outside identity", () => {
    const portable = manifestProjection();
    const mapped = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" })
      .map(createObservationOwnerFact({
        owner: "M01",
        phase: "DELIVERY_BOUND",
        correlation: { deliveryId: "delivery-1" },
        identity: taskBindingIdentity("delivery-1"),
        signal: "event",
        eventName: "task.binding",
        familySchema: "implementation@1",
        fields: {
          C01: "delivery-1",
          C02: "task-1",
          C07: "a".repeat(64),
          C09: taskBindingIdentity("delivery-1"),
          C58: "Token tuning",
          C59: portable.canonical,
          C60: portable.digest,
        },
      }));

    expect(mapped).toMatchObject({
      ok: true,
      record: {
        profile_version: "2.0.0",
        scope: { version: "2.0.0" },
        event_name: "task.binding",
        attributes: {
          "agentops.delivery.id": "delivery-1",
          "agentops.task.id": "task-1",
          "agentops.task.display_name": "Token tuning",
          "agentops.delivery.manifest_projection": portable.canonical,
          "agentops.delivery.manifest_projection_digest": portable.digest,
        },
      },
    });

    const invalid = createObservationOwnerFact({
      owner: "M01",
      phase: "DELIVERY_BOUND",
      correlation: { deliveryId: "delivery-1" },
      identity: taskBindingIdentity("delivery-1"),
      signal: "event",
      eventName: "task.binding",
      familySchema: "implementation@1",
      fields: {
        C01: "delivery-1",
        C02: "task id with spaces",
        C07: "a".repeat(64),
        C09: taskBindingIdentity("delivery-1"),
        C59: portable.canonical,
        C60: portable.digest,
      },
    });
    expect(new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" })
      .map(invalid)).toMatchObject({ ok: false, diagnostic: { code: "OBSERVATION_FIELD_INVALID" } });
  });

  it("creates one stable Task binding owner fact from the persisted Manifest", () => {
    const portable = manifestProjection();
    const fact: DeliveryBoundOwnerFact = {
      owner: "M01",
      name: "delivery-bound",
      occurredAt: 10,
      deliveryId: "delivery-1",
      taskId: "task-1",
      taskDisplayName: "Token tuning",
      deliveryBindingIdentity: `sha256:${"a".repeat(64)}`,
      workflowIdentity: "implementation-workflow@0.3.0",
      manifestProjection: portable.canonical,
      manifestProjectionDigest: portable.digest,
    };

    const first = createTaskBindingObservationFact(fact);
    const replay = createTaskBindingObservationFact(fact);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      owner: "M01",
      phase: "DELIVERY_BOUND",
      eventName: "task.binding",
      fields: {
        C01: "delivery-1",
        C02: "task-1",
        C07: "a".repeat(64),
        C58: "Token tuning",
        C59: portable.canonical,
        C60: portable.digest,
      },
    });
  });

  it("rejects noncanonical, digest-mismatched, identity-mismatched, or incomplete Manifest projections", () => {
    const portable = manifestProjection();
    const base = {
      owner: "M01" as const,
      phase: "DELIVERY_BOUND" as const,
      correlation: { deliveryId: "delivery-1" },
      identity: taskBindingIdentity("delivery-1"),
      signal: "event" as const,
      eventName: "task.binding" as const,
      familySchema: "implementation@1" as const,
      fields: { C01: "delivery-1", C02: "task-1", C07: "a".repeat(64), C09: taskBindingIdentity("delivery-1"), C59: portable.canonical, C60: portable.digest },
    };
    const cases = [
      { ...base, fields: { ...base.fields, C60: "d".repeat(64) } },
      { ...base, fields: { ...base.fields, C59: ` ${portable.canonical}` } },
      { ...base, fields: { ...base.fields, C01: "delivery-other" } },
      { ...base, fields: (({ C59: _removed, ...rest }) => rest)(base.fields) },
    ];
    const mapper = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" });
    for (const candidate of cases) {
      expect(mapper.map(createObservationOwnerFact(candidate as never))).toMatchObject({ ok: false });
    }
  });

  it("accepts the canonical bounded OTel service strings without inventing a stricter identifier grammar", () => {
    expect(() => new DeliveryObservationMapper({ serviceName: "execution service", serviceVersion: "0.1.0+preview" })).not.toThrow();
  });

  it("pins the complete 1.0.0 source matrix without sibling-family fields", async () => {
    const registry = JSON.parse(await readFile(path.join(contractRoot, "registries/observation-profile-1.0.0.json"), "utf8"));
    expect(OBSERVATION_PROFILE_SOURCE_MATRIX.profileVersion).toBe("1.0.0");
    expect(OBSERVATION_PROFILE_SOURCE_MATRIX.eventNames).toEqual(registry.event_names);
    expect(Object.keys(OBSERVATION_PROFILE_SOURCE_MATRIX.fields.common)).toHaveLength(57);
    expect(Object.keys(OBSERVATION_PROFILE_SOURCE_MATRIX.fields.implementation)).toHaveLength(10);
    expect(Object.keys(OBSERVATION_PROFILE_SOURCE_MATRIX.fields.systemDesign)).toHaveLength(6);
    expect(new Set(Object.values(OBSERVATION_PROFILE_SOURCE_MATRIX.fields).flatMap(Object.keys))).toHaveProperty("size", 73);
    for (const family of ["common", "implementation", "systemDesign"] as const) {
      for (const [id, source] of Object.entries(OBSERVATION_PROFILE_SOURCE_MATRIX.fields[family])) {
        const contract = Object.values(registry.fields).flat().find((field: any) => field.id === id) as any;
        expect(source).toMatchObject({ name: contract.name, type: contract.type, source: expect.stringMatching(/^(M01|M02|M03|DSH|FACT_OWNER)$/) });
      }
    }
    expect(OBSERVATION_PROFILE_SOURCE_MATRIX.fields.common.C55!.source).toBe("M02");
    expect(OBSERVATION_PROFILE_SOURCE_MATRIX.fields.common.C56!.source).toBe("DSH");
    expect(OBSERVATION_PROFILE_SOURCE_MATRIX.fields.common.C57!.source).toBe("M02");
  });

  it("maps owner-supplied delivery facts and copies optional C55/C56 without deriving absent values", () => {
    const mapper = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" });
    const fact = createObservationOwnerFact({
      owner: "M02",
      phase: "DELIVERY_TERMINAL",
      correlation: { deliveryId: "delivery-1" },
      identity: "event-delivery-1",
      signal: "event",
      eventName: "delivery.summary",
      familySchema: "implementation@1",
      fields: {
        C08: "implementation", C09: "event-delivery-1", C10: "COMPLETED", C11: "FINAL", C49: "implementation@1",
        C55: 812.5, C56: "review",
      },
    });

    const mapped = mapper.map(fact);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.record.attributes).toMatchObject({
      "agentops.delivery.elapsed_time_ms": 812.5,
      "agentops.delivery.stage.reached": "review",
    });

    const absent = mapper.map(createObservationOwnerFact({
      owner: "M02",
      phase: "DELIVERY_TERMINAL",
      correlation: { deliveryId: "delivery-2" },
      identity: "event-delivery-2",
      signal: "event",
      eventName: "delivery.summary",
      familySchema: "implementation@1",
      fields: { C08: "implementation", C09: "event-delivery-2", C10: "FAILED", C11: "FINAL", C49: "implementation@1" },
    }));
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.record.attributes).not.toHaveProperty("agentops.delivery.elapsed_time_ms");
      expect(absent.record.attributes).not.toHaveProperty("agentops.delivery.stage.reached");
    }
  });

  it("emits no fragment for an incomplete shape or structurally prohibited marker", () => {
    const mapper = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" });
    const incomplete = mapper.map(createObservationOwnerFact({
      owner: "DSH",
      phase: "WORKFLOW_FACT",
      correlation: { deliveryId: "delivery-1" },
      identity: "event-incomplete",
      signal: "event",
      eventName: "review.finding",
      familySchema: "implementation@1",
      fields: { C08: "implementation", C09: "event-incomplete", C49: "implementation@1" },
    }));
    expect(incomplete).toMatchObject({ ok: false, diagnostic: { code: "OBSERVATION_SHAPE_INCOMPLETE" } });

    expect(() => createObservationOwnerFact({
      owner: "DSH",
      phase: "WORKFLOW_FACT",
      correlation: { deliveryId: "delivery-1" },
      identity: "event-prohibited",
      signal: "event",
      eventName: "delivery.summary",
      familySchema: "implementation@1",
      fields: { C08: "implementation", C09: "event-prohibited", C10: "FAILED", C11: "FINAL", C49: "implementation@1" },
      extensions: { prompt: "not admitted" },
    } as never)).toThrowError("OBSERVATION_OWNER_FACT_INVALID");
  });

  it("rejects owner/phase/signal combinations outside the closed M01/M02/DSH union", () => {
    expect(() => createObservationOwnerFact({
      owner: "M01", phase: "WORKFLOW_FACT", correlation: { deliveryId: "delivery-1" }, identity: "event-wrong-owner",
      signal: "event", eventName: "delivery.summary", familySchema: "implementation@1",
      fields: { C08: "implementation", C09: "event-wrong-owner", C10: "FAILED", C11: "FINAL", C49: "implementation@1" },
    } as never)).toThrowError("OBSERVATION_OWNER_FACT_INVALID");
    expect(() => createObservationOwnerFact({
      owner: "M02", phase: "DELIVERY_TERMINAL", correlation: { deliveryId: "delivery-1", ambient: "not-closed" }, identity: "event-extra-correlation",
      signal: "event", eventName: "delivery.summary", familySchema: "implementation@1",
      fields: { C08: "implementation", C09: "event-extra-correlation", C10: "FAILED", C11: "FINAL", C49: "implementation@1" },
    } as never)).toThrowError("OBSERVATION_OWNER_FACT_INVALID");
  });
});
