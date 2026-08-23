import { OtlpObservationExporter, type OtlpTransport, type OtlpTransportDiagnostic } from "./exporter.js";
import { DeliveryObservationMapper, type ObservationMapperConfig } from "./mapper.js";
import type { ObservationDiagnostic, ObservationInputFact, ObservationRecord } from "./types.js";
import type { ExecutionInstallationConfig } from "../configuration/index.js";

export type DeliveryObservationEmitterDiagnostic = ObservationDiagnostic | OtlpTransportDiagnostic;
export type DeliveryObservationEmitterConfig = ExecutionInstallationConfig["observation"];
export interface DeliveryObservationEmitter {
  readonly kind: "disabled" | "enabled";
  emit(fact: ObservationInputFact): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
export interface DeliveryObservationEmitterOptions {
  readonly config: DeliveryObservationEmitterConfig;
  readonly serviceVersion: string;
  readonly diagnostic: (diagnostic: DeliveryObservationEmitterDiagnostic) => void;
  readonly transportFactory?: () => OtlpTransport;
}

const DISABLED: DeliveryObservationEmitter = Object.freeze({
  kind: "disabled",
  emit(): void {},
  async flush(): Promise<void> {},
  async close(): Promise<void> {},
});

export function createDeliveryObservationEmitter(options: DeliveryObservationEmitterOptions): DeliveryObservationEmitter {
  if (!Object.isFrozen(options.config)) throw new TypeError("OBSERVATION_EMITTER_CONFIG_NOT_CANONICAL");
  if (!options.config.enabled) return DISABLED;
  if (options.config.endpoint === undefined) throw new TypeError("OBSERVATION_EMITTER_CONFIG_NOT_CANONICAL");
  const mapperConfig: ObservationMapperConfig = { serviceName: options.config.serviceName, serviceVersion: options.serviceVersion };
  const mapper = new DeliveryObservationMapper(mapperConfig);
  const transport = options.transportFactory?.();
  const exporter = new OtlpObservationExporter({
    endpoint: options.config.endpoint,
    timeoutMs: options.config.timeoutMs,
    maxBatchRecords: options.config.maxBatchRecords,
    maxBatchBytes: options.config.maxBatchBytes,
    diagnostic: options.diagnostic,
    ...(transport === undefined ? {} : { transport }),
  });
  let queue: ObservationRecord[] = [];
  let closed = false;
  let flushing = Promise.resolve();
  const emitDiagnostic = (diagnostic: DeliveryObservationEmitterDiagnostic): void => {
    try { options.diagnostic(diagnostic); } catch { /* diagnostic is non-controlling */ }
  };
  const emitter: DeliveryObservationEmitter = {
    kind: "enabled",
    emit(fact): void {
      if (closed) return;
      try {
        if (fact.signal === "runner-settlement") {
          emitDiagnostic(Object.freeze({ code: "OBSERVATION_SHAPE_INCOMPLETE", owner: fact.owner, phase: fact.phase, identity: fact.identity }));
          return;
        }
        const mapped = mapper.map(fact);
        if (mapped.ok) queue.push(mapped.record);
        else emitDiagnostic(mapped.diagnostic);
      } catch { emitDiagnostic(Object.freeze({ code: "OBSERVATION_OWNER_FACT_INVALID" })); }
    },
    async flush(): Promise<void> {
      const records = queue;
      queue = [];
      flushing = flushing.then(() => exporter.export(records)).catch(() => undefined);
      await flushing;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await emitter.flush();
      await exporter.close();
    },
  };
  return Object.freeze(emitter);
}
