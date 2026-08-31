import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeliveryObservationMapper,
  OtlpObservationExporter,
  createDeliveryObservationEmitter,
  createRunnerOwnerFactPort,
  createObservationOwnerFact,
  type OtlpTransportDiagnostic,
} from "../../src/observation/index.js";
import { canonicalJsonBytes } from "../../src/configuration/index.js";

const require = createRequire(import.meta.url);
const oracle = require("../../../system-contracts/observation/tools/validator.cjs") as {
  decodeOtlpRequest(signal: "traces" | "logs", bytes: Buffer, options: { familySchema: string }): { decision: string; record_count: number };
};
const servers: Array<ReturnType<typeof createServer>> = [];

function observationConfig(enabled: boolean, endpoint?: string) {
  return Object.freeze({
    enabled,
    ...(endpoint === undefined ? {} : { endpoint }),
    timeoutMs: 100,
    maxBatchRecords: 512,
    maxBatchBytes: 4_194_304,
    flushIntervalMs: 1_000,
    shutdownFlushMs: 1_000,
    serviceName: "execution",
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function terminalFact(identity: string) {
  return createObservationOwnerFact({
    owner: "M02",
    phase: "DELIVERY_TERMINAL",
    correlation: { deliveryId: "delivery-1" },
    identity,
    signal: "event",
    eventName: "delivery.summary",
    familySchema: "implementation@1",
    fields: { C08: "implementation", C09: identity, C10: "COMPLETED", C11: "FINAL", C49: "implementation@1" },
  });
}

function taskBindingFact() {
  const resolvedMapDigest = `sha256:${createHash("sha256").update("[]").digest("hex")}`;
  const projection = Buffer.from(canonicalJsonBytes({
    schema_version: "execution.delivery-manifest-projection@1.0.0",
    delivery_id: "delivery-1",
    task_id: "task-1",
    manifest_digest: "a".repeat(64),
    workflow: { package_name: "system-design", exact_package_version: "2.0.0", package_digest: `sha256:${"b".repeat(64)}`, workflow_id: "workflow.system-design", workflow_version: "2.0.0", snapshot_id: "snapshot.system-design.2", snapshot_digest: `sha256:${"c".repeat(64)}` },
    repository_model_bindings: { document_state: "ABSENT", resolved_map_digest: resolvedMapDigest },
    roles: [],
  } as never)).toString("utf8");
  const identity = `task-binding-${createHash("sha256").update("delivery-1").digest("hex").slice(0, 24)}`;
  return createObservationOwnerFact({
    owner: "M01",
    phase: "DELIVERY_BOUND",
    correlation: { deliveryId: "delivery-1" },
    identity,
    signal: "event",
    eventName: "task.binding",
    familySchema: "workflow.system-design@1",
    fields: {
      C01: "delivery-1",
      C02: "task-1",
      C07: "a".repeat(64),
      C08: "workflow.system-design",
      C09: identity,
      C49: "workflow.system-design@1",
      C59: projection,
      C60: createHash("sha256").update(projection).digest("hex"),
    },
  });
}

describe("M03 official OTLP/protobuf exporter", () => {
  it("never batches different exact Observation profiles under the first record scope", async () => {
    const mapper = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" });
    const legacy = mapper.map(terminalFact("event-profile-1"));
    const task = mapper.map(taskBindingFact());
    if (!legacy.ok || !task.ok) throw new Error("mapping failed");
    const requests: Uint8Array[] = [];
    const exporter = new OtlpObservationExporter({
      endpoint: "http://127.0.0.1:4318",
      timeoutMs: 100,
      maxBatchRecords: 512,
      maxBatchBytes: 4_194_304,
      diagnostic() {},
      transport: {
        send: async ({ body }) => {
          requests.push(body);
          return { kind: "SUCCEEDED", status: 200, body: new Uint8Array() };
        },
      },
    });

    await exporter.export([legacy.record, task.record]);

    expect(requests).toHaveLength(2);
  });

  it("posts exact protobuf bytes to the fixed log path and passes the shared producer oracle", async () => {
    const received: Array<{ url: string; type: string | undefined; bytes: Buffer }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push({ url: request.url ?? "", type: request.headers["content-type"], bytes: Buffer.concat(chunks) });
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listener unavailable");

    const diagnostics: OtlpTransportDiagnostic[] = [];
    const mapper = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" });
    const mapped = mapper.map(terminalFact("event-export-1"));
    if (!mapped.ok) throw new Error(mapped.diagnostic.code);
    const exporter = new OtlpObservationExporter({
      endpoint: `http://127.0.0.1:${address.port}`,
      timeoutMs: 1_000,
      maxBatchRecords: 512,
      maxBatchBytes: 4_194_304,
      diagnostic: (value) => diagnostics.push(value),
    });

    await exporter.export([mapped.record]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ url: "/v1/logs", type: "application/x-protobuf" });
    expect(oracle.decodeOtlpRequest("logs", received[0]!.bytes, { familySchema: "implementation@1" })).toMatchObject({ decision: "ACCEPT", record_count: 1 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "OTLP_EXPORT_SUCCEEDED" }));
    await exporter.close();
    await exporter.close();
    await exporter.export([mapped.record]);
    expect(received).toHaveLength(1);
  });

  it("classifies rejection, refusal, timeout, tail loss, and ambiguous commit as bounded diagnostics", async () => {
    const diagnostics: OtlpTransportDiagnostic[] = [];
    const mapper = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" });
    const mapped = mapper.map(terminalFact("event-export-2"));
    if (!mapped.ok) throw new Error(mapped.diagnostic.code);
    const outcomes = ["REJECTED", "REFUSED", "TIMEOUT", "TAIL_LOSS", "AMBIGUOUS_COMMIT"] as const;
    for (const outcome of outcomes) {
      const exporter = new OtlpObservationExporter({
        endpoint: "http://127.0.0.1:4318",
        timeoutMs: 100,
        maxBatchRecords: 512,
        maxBatchBytes: 4_194_304,
        diagnostic: (value) => diagnostics.push(value),
        transport: { send: async () => ({ kind: outcome }) },
      });
      await exporter.export([mapped.record]);
    }
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "OTLP_EXPORT_REJECTED", "OTLP_EXPORT_REFUSED", "OTLP_EXPORT_TIMEOUT", "OTLP_EXPORT_TAIL_LOSS", "OTLP_EXPORT_AMBIGUOUS_COMMIT",
    ]);
  });

  it("decodes a signal-specific OTLP partial-success response", async () => {
    const diagnostics: OtlpTransportDiagnostic[] = [];
    const mapped = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" }).map(terminalFact("event-partial"));
    if (!mapped.ok) throw new Error(mapped.diagnostic.code);
    const exporter = new OtlpObservationExporter({
      endpoint: "http://127.0.0.1:4318/", timeoutMs: 100, maxBatchRecords: 512, maxBatchBytes: 4_194_304,
      diagnostic: (value) => diagnostics.push(value),
      transport: { send: async ({ url }) => {
        expect(url).toBe("http://127.0.0.1:4318/v1/logs");
        return { kind: "SUCCEEDED", status: 200, body: Uint8Array.from([0x0a, 0x02, 0x08, 0x01]) };
      } },
    });
    await exporter.export([mapped.record, { ...mapped.record, attributes: { ...mapped.record.attributes, "agentops.event.id": "event-partial-2" } }]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "OTLP_EXPORT_PARTIAL_SUCCESS", signal: "logs", recordCount: 2 }));
  });

  it("shuts down its transport exactly once", async () => {
    let shutdowns = 0;
    const exporter = new OtlpObservationExporter({
      endpoint: "http://127.0.0.1:4318",
      timeoutMs: 100,
      maxBatchRecords: 512,
      maxBatchBytes: 4_194_304,
      diagnostic() {},
      transport: {
        async send() { return { kind: "SUCCEEDED", status: 200, body: new Uint8Array() }; },
        async shutdown() { shutdowns += 1; },
      },
    });

    await exporter.close();
    await exporter.close();
    expect(shutdowns).toBe(1);
  });

  it("splits a homogeneous family batch before the protobuf byte limit", async () => {
    const mapper = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" });
    const first = mapper.map(terminalFact("event-byte-1"));
    const second = mapper.map(terminalFact("event-byte-2"));
    if (!first.ok || !second.ok) throw new Error("mapping failed");
    const singleBytes = (await import("../../src/observation/index.js")).encodeOtlpRequest("logs", [first.record]).byteLength;
    const requests: Uint8Array[] = [];
    const exporter = new OtlpObservationExporter({
      endpoint: "http://127.0.0.1:4318",
      timeoutMs: 100,
      maxBatchRecords: 512,
      maxBatchBytes: singleBytes + 1,
      diagnostic() {},
      transport: { send: async ({ body }) => { requests.push(body); return { kind: "SUCCEEDED", status: 200, body: new Uint8Array() }; } },
    });
    await exporter.export([first.record, second.record]);
    expect(requests).toHaveLength(2);
    expect(requests.every((bytes) => bytes.byteLength <= singleBytes + 1)).toBe(true);
  });

  it("uses a zero-resource disabled sink and contains enabled transport failure", async () => {
    let transportCreations = 0;
    const diagnostics: string[] = [];
    const disabled = createDeliveryObservationEmitter({
      config: observationConfig(false),
      serviceVersion: "0.1.0",
      diagnostic: ({ code }) => diagnostics.push(code),
      transportFactory: () => { transportCreations += 1; throw new Error("disabled must not create transport"); },
    });
    disabled.emit(terminalFact("event-disabled"));
    await disabled.flush();
    await disabled.close();
    expect(transportCreations).toBe(0);
    expect(disabled.kind).toBe("disabled");
    expect(() => createDeliveryObservationEmitter({
      config: { ...observationConfig(false) }, serviceVersion: "0.1.0", diagnostic() {},
    })).toThrowError("OBSERVATION_EMITTER_CONFIG_NOT_CANONICAL");

    const enabled = createDeliveryObservationEmitter({
      config: observationConfig(true, "http://127.0.0.1:4318"),
      serviceVersion: "0.1.0",
      diagnostic: ({ code }) => diagnostics.push(code),
      transportFactory: () => { transportCreations += 1; return { send: async () => { throw new Error("contained"); } }; },
    });
    expect(() => enabled.emit(terminalFact("event-enabled"))).not.toThrow();
    await expect(enabled.flush()).resolves.toBeUndefined();
    expect(transportCreations).toBe(1);
    expect(diagnostics).toContain("OTLP_EXPORT_REFUSED");
  });

  it("flushes on the configured interval and bounds shutdown when transport never settles", async () => {
    let sends = 0;
    const emitter = createDeliveryObservationEmitter({
      config: Object.freeze({ ...observationConfig(true, "http://127.0.0.1:4318"), flushIntervalMs: 100, shutdownFlushMs: 100 }),
      serviceVersion: "0.1.0",
      diagnostic() {},
      transportFactory: () => ({
        send: async () => { sends += 1; return new Promise<never>(() => {}); },
        shutdown: async () => new Promise<never>(() => {}),
      }),
    });
    emitter.emit(terminalFact("event-bounded-close"));

    await expect.poll(() => sends, { timeout: 300 }).toBe(1);
    const disposition = await Promise.race([
      emitter.close().then(() => "closed" as const),
      new Promise<"unbounded">((resolve) => setTimeout(() => resolve("unbounded"), 300)),
    ]);

    expect(disposition).toBe("closed");
  });

  it("contains incomplete/invalid owner facts and makes close idempotent", async () => {
    const diagnostics: string[] = [];
    const emitter = createDeliveryObservationEmitter({
      config: observationConfig(true, "http://127.0.0.1:4318"),
      serviceVersion: "0.1.0",
      diagnostic: ({ code }) => diagnostics.push(code),
      transportFactory: () => ({ send: async () => ({ kind: "SUCCEEDED", status: 200, body: new Uint8Array() }) }),
    });
    let settlement: any;
    await createRunnerOwnerFactPort({ emit: (fact) => { settlement = fact; } }).observe({
      kind: "runner-terminal-settled",
      delivery: { deliveryIdentity: "delivery-1", manifestBindingIdentity: `sha256:${"a".repeat(64)}`, activationBindingIdentity: `sha256:${"b".repeat(64)}` },
      settlementIdentity: "settlement-1",
    } as never);
    emitter.emit(settlement);
    emitter.emit({ ...terminalFact("event-forged"), contentIdentity: `sha256:${"0".repeat(64)}` });
    emitter.emit(null as never);
    await emitter.close();
    await emitter.close();
    emitter.emit(terminalFact("event-after-close"));
    expect(diagnostics).toEqual(["OBSERVATION_SHAPE_INCOMPLETE", "OBSERVATION_OWNER_FACT_INVALID", "OBSERVATION_OWNER_FACT_INVALID"]);

    const throwingDiagnostic = createDeliveryObservationEmitter({
      config: observationConfig(true, "http://127.0.0.1:4318"),
      serviceVersion: "0.1.0", diagnostic: () => { throw new Error("contained diagnostic"); },
      transportFactory: () => ({ send: async () => ({ kind: "SUCCEEDED", status: 200, body: new Uint8Array() }) }),
    });
    expect(() => throwingDiagnostic.emit(settlement)).not.toThrow();
  });

  it("contains single-record oversize, malformed success body, and HTTP refusal", async () => {
    const mapped = new DeliveryObservationMapper({ serviceName: "execution", serviceVersion: "0.1.0" }).map(terminalFact("event-boundaries"));
    if (!mapped.ok) throw new Error(mapped.diagnostic.code);
    const diagnostics: string[] = [];
    const oversize = new OtlpObservationExporter({ endpoint: "http://127.0.0.1:4318", timeoutMs: 100, maxBatchRecords: 512, maxBatchBytes: 1, diagnostic: ({ code }) => diagnostics.push(code), transport: { send: async () => { throw new Error("not called"); } } });
    await oversize.export([mapped.record]);
    const malformed = new OtlpObservationExporter({ endpoint: "http://127.0.0.1:4318", timeoutMs: 100, maxBatchRecords: 512, maxBatchBytes: 4_194_304, diagnostic: ({ code }) => diagnostics.push(code), transport: { send: async () => ({ kind: "SUCCEEDED", status: 200, body: Uint8Array.from([0xff]) }) } });
    await malformed.export([mapped.record]);

    const server = createServer((_request, response) => { response.writeHead(503); response.end(); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listener unavailable");
    const rejected = new OtlpObservationExporter({ endpoint: `http://127.0.0.1:${address.port}`, timeoutMs: 100, maxBatchRecords: 512, maxBatchBytes: 4_194_304, diagnostic: ({ code }) => diagnostics.push(code) });
    await rejected.export([mapped.record]);
    expect(diagnostics).toEqual(["OTLP_EXPORT_OVERSIZE", "OTLP_EXPORT_REJECTED", "OTLP_EXPORT_REJECTED"]);
  });
});
