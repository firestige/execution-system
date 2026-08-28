import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

import { decodeOtlpResponse, encodeOtlpRequest } from "./otlp-codec.js";
import type { ObservationRecord } from "./types.js";

export type OtlpTransportOutcome = Readonly<{ kind: "SUCCEEDED"; status: number; body: Uint8Array }> | Readonly<{ kind: "REJECTED" | "REFUSED" | "TIMEOUT" | "TAIL_LOSS" | "AMBIGUOUS_COMMIT" }>;
export interface OtlpTransport {
  send(request: Readonly<{ url: string; body: Uint8Array; timeoutMs: number }>): Promise<OtlpTransportOutcome>;
  shutdown?(): void | Promise<void>;
}
export interface OtlpTransportDiagnostic { readonly code: "OTLP_EXPORT_SUCCEEDED" | "OTLP_EXPORT_PARTIAL_SUCCESS" | "OTLP_EXPORT_REJECTED" | "OTLP_EXPORT_REFUSED" | "OTLP_EXPORT_TIMEOUT" | "OTLP_EXPORT_TAIL_LOSS" | "OTLP_EXPORT_AMBIGUOUS_COMMIT" | "OTLP_EXPORT_OVERSIZE"; readonly signal: "traces" | "logs"; readonly familySchema: string; readonly recordCount: number }
export interface OtlpObservationExporterConfig {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly maxBatchRecords: number;
  readonly maxBatchBytes: number;
  readonly diagnostic: (diagnostic: OtlpTransportDiagnostic) => void;
  readonly transport?: OtlpTransport;
}

type OfficialExportResponse =
  | Readonly<{ status: "success"; data?: Uint8Array }>
  | Readonly<{ status: "failure"; error: Error }>
  | Readonly<{ status: "retryable"; retryInMillis?: number; error?: Error }>;
interface OfficialTransport { send(data: Uint8Array, timeoutMillis: number): Promise<OfficialExportResponse>; shutdown(): void }
interface OfficialExporterInternals {
  readonly _delegate?: { readonly _transport?: OfficialTransport };
  shutdown(): Promise<void>;
}

function officialTransport(exporter: unknown): OfficialTransport {
  const candidate = (exporter as OfficialExporterInternals)._delegate?._transport;
  if (candidate === undefined || typeof candidate.send !== "function" || typeof candidate.shutdown !== "function") {
    throw new TypeError("OTLP_OFFICIAL_EXPORTER_SHAPE_UNSUPPORTED");
  }
  return candidate;
}

function isTimeout(error: Error | undefined): boolean {
  return error?.message === "Request timed out";
}

function isHttpRejection(error: Error | undefined): boolean {
  const value = error as (Error & { code?: unknown }) | undefined;
  return typeof value?.code === "number";
}

function createOfficialTransport(endpoint: string, timeoutMs: number): OtlpTransport {
  const urls = Object.freeze({
    traces: `${endpoint}/v1/traces`,
    logs: `${endpoint}/v1/logs`,
  });
  const traceExporter = new OTLPTraceExporter({ url: urls.traces, timeoutMillis: timeoutMs, concurrencyLimit: 1 });
  const logExporter = new OTLPLogExporter({ url: urls.logs, timeoutMillis: timeoutMs, concurrencyLimit: 1 });
  const transports = Object.freeze({
    [urls.traces]: officialTransport(traceExporter),
    [urls.logs]: officialTransport(logExporter),
  });
  let closed = false;
  return Object.freeze({
    async send(request: Readonly<{ url: string; body: Uint8Array; timeoutMs: number }>): Promise<OtlpTransportOutcome> {
      const transport = transports[request.url as keyof typeof transports];
      if (transport === undefined) return Object.freeze({ kind: "REFUSED" as const });
      const response = await transport.send(request.body, request.timeoutMs);
      if (response.status === "success") {
        return Object.freeze({ kind: "SUCCEEDED" as const, status: 200, body: response.data ?? new Uint8Array() });
      }
      if (isTimeout(response.error)) return Object.freeze({ kind: "TIMEOUT" as const });
      if (response.status === "retryable" && response.error === undefined) return Object.freeze({ kind: "REJECTED" as const });
      return Object.freeze({ kind: isHttpRejection(response.error) ? "REJECTED" as const : "REFUSED" as const });
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      await Promise.all([traceExporter.shutdown(), logExporter.shutdown()]);
    },
  });
}

export class OtlpObservationExporter {
  readonly #config: OtlpObservationExporterConfig;
  readonly #transport: OtlpTransport;
  readonly #endpoint: string;
  #closed = false;
  constructor(config: OtlpObservationExporterConfig) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname)
      || endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== ""
      || !Number.isSafeInteger(config.maxBatchRecords) || config.maxBatchRecords < 1 || config.maxBatchRecords > 512
      || !Number.isSafeInteger(config.maxBatchBytes) || config.maxBatchBytes < 1 || config.maxBatchBytes > 4_194_304
      || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) throw new TypeError("OTLP_EXPORTER_CONFIG_INVALID");
    this.#config = config;
    this.#endpoint = endpoint.origin;
    this.#transport = config.transport ?? createOfficialTransport(this.#endpoint, config.timeoutMs);
  }

  async export(records: readonly ObservationRecord[]): Promise<void> {
    if (this.#closed) return;
    const groups = new Map<string, ObservationRecord[]>();
    for (const record of records) {
      const signal = record.record_type === "span" ? "traces" : "logs";
      const key = `${signal}:${record.profile_version}:${record.family_schema}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const [signal, _profileVersion, familySchema] = key.split(":") as ["traces" | "logs", string, string];
      let batch: ObservationRecord[] = [];
      for (const record of group) {
        const candidate = [...batch, record];
        const candidateBytes = encodeOtlpRequest(signal, candidate);
        if (batch.length > 0 && (candidate.length > this.#config.maxBatchRecords || candidateBytes.byteLength > this.#config.maxBatchBytes)) {
          await this.#exportBatch(signal, familySchema, batch);
          batch = [record];
        } else batch = candidate;
        if (batch.length === 1 && encodeOtlpRequest(signal, batch).byteLength > this.#config.maxBatchBytes) {
          this.#emit("OTLP_EXPORT_OVERSIZE", signal, familySchema, 1);
          batch = [];
        }
      }
      if (batch.length > 0) await this.#exportBatch(signal, familySchema, batch);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#transport.shutdown?.(); } catch { /* observation shutdown is non-controlling */ }
  }

  async #exportBatch(signal: "traces" | "logs", familySchema: string, batch: readonly ObservationRecord[]): Promise<void> {
    const bytes = encodeOtlpRequest(signal, batch);
    const outcome = await this.#transport.send({ url: `${this.#endpoint}${signal === "traces" ? "/v1/traces" : "/v1/logs"}`, body: bytes, timeoutMs: this.#config.timeoutMs }).catch(() => ({ kind: "REFUSED" as const }));
    if (outcome.kind === "SUCCEEDED") {
      let rejected = 0;
      try { rejected = decodeOtlpResponse(signal, outcome.body); }
      catch { this.#emit("OTLP_EXPORT_REJECTED", signal, familySchema, batch.length); return; }
      this.#emit(rejected === 0 ? "OTLP_EXPORT_SUCCEEDED" : "OTLP_EXPORT_PARTIAL_SUCCESS", signal, familySchema, batch.length);
    } else this.#emit(`OTLP_EXPORT_${outcome.kind}` as OtlpTransportDiagnostic["code"], signal, familySchema, batch.length);
  }

  #emit(code: OtlpTransportDiagnostic["code"], signal: "traces" | "logs", familySchema: string, recordCount: number): void {
    try { this.#config.diagnostic(Object.freeze({ code, signal, familySchema, recordCount })); } catch { /* diagnostic is non-controlling */ }
  }
}
