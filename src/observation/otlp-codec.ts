import { SpanKind, SpanStatusCode, type HrTime, type SpanContext } from "@opentelemetry/api";
import { ProtobufLogsSerializer, ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import type { ObservationRecord, ObservationSpanRecord } from "./types.js";

function hrTime(unixNano: string): HrTime {
  const value = BigInt(unixNano);
  const seconds = value / 1_000_000_000n;
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("OBSERVATION_TIME_OUT_OF_RANGE");
  return [Number(seconds), Number(value % 1_000_000_000n)];
}

function spanContext(record: ObservationSpanRecord, spanId = record.span_id): SpanContext {
  return Object.freeze({ traceId: record.trace_id, spanId, traceFlags: record.span_flags });
}

function sdkRecords(signal: "traces" | "logs", records: readonly ObservationRecord[]): ReadableSpan[] | ReadableLogRecord[] {
  const first = records[0];
  if (first === undefined) return [];
  const resource = resourceFromAttributes({ ...first.resource });
  const scope = Object.freeze({ name: first.scope.name, version: first.scope.version, schemaUrl: first.scope.schema_url });
  if (signal === "logs") return records.map((record): ReadableLogRecord => {
    if (record.record_type !== "event") throw new TypeError("OBSERVATION_SIGNAL_MISMATCH");
    return Object.freeze({
      hrTime: [0, 0] as HrTime, hrTimeObserved: [0, 0] as HrTime, eventName: record.event_name,
      resource, instrumentationScope: scope, attributes: record.attributes, droppedAttributesCount: 0,
    });
  });
  return records.map((record): ReadableSpan => {
    if (record.record_type !== "span") throw new TypeError("OBSERVATION_SIGNAL_MISMATCH");
    const startTime = hrTime(record.start_time_unix_nano);
    const endTime = hrTime(record.end_time_unix_nano);
    const duration = hrTime((BigInt(record.end_time_unix_nano) - BigInt(record.start_time_unix_nano)).toString());
    return Object.freeze({
      name: record.span_name,
      kind: record.span_kind === "INTERNAL" ? SpanKind.INTERNAL : SpanKind.CLIENT,
      spanContext: () => spanContext(record),
      ...(record.parent_span_id === undefined ? {} : { parentSpanContext: spanContext(record, record.parent_span_id) }),
      startTime, endTime, duration,
      status: Object.freeze({ code: record.span_status === "UNSET" ? SpanStatusCode.UNSET : record.span_status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR }),
      attributes: record.attributes, links: [], events: [], ended: true, resource, instrumentationScope: scope,
      droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
    });
  });
}

export function encodeOtlpRequest(signal: "traces" | "logs", records: readonly ObservationRecord[]): Uint8Array {
  const encoded = signal === "traces"
    ? ProtobufTraceSerializer.serializeRequest(sdkRecords(signal, records) as ReadableSpan[])
    : ProtobufLogsSerializer.serializeRequest(sdkRecords(signal, records) as ReadableLogRecord[]);
  if (encoded === undefined) throw new TypeError("OBSERVATION_OTLP_SERIALIZATION_FAILED");
  return encoded;
}

export function decodeOtlpResponse(signal: "traces" | "logs", bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  if (signal === "traces") return Number(ProtobufTraceSerializer.deserializeResponse(bytes).partialSuccess?.rejectedSpans ?? 0);
  return Number(ProtobufLogsSerializer.deserializeResponse(bytes).partialSuccess?.rejectedLogRecords ?? 0);
}
