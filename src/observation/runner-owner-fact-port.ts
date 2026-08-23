import { canonicalDigest } from "../contracts/index.js";
import type { RunnerObservationPort } from "../coordinator/runner-coordinator.js";
import type { RunnerSettlementOwnerFact } from "./types.js";

export type { RunnerSettlementOwnerFact } from "./types.js";

export interface RunnerSettlementOwnerFactIngress { emit(fact: RunnerSettlementOwnerFact): void }

export function createRunnerOwnerFactPort(ingress: RunnerSettlementOwnerFactIngress): RunnerObservationPort {
  return Object.freeze({
    async observe(event: Parameters<RunnerObservationPort["observe"]>[0]): Promise<void> {
      const content = Object.freeze({
        schemaVersion: "execution.observation-owner-fact@1.0.0" as const,
        owner: "M02" as const,
        phase: "RUNNER_TERMINAL_SETTLED" as const,
        signal: "runner-settlement" as const,
        identity: event.settlementIdentity as string,
        correlation: Object.freeze({
          deliveryId: event.delivery.deliveryIdentity as string,
          manifestBindingIdentity: event.delivery.manifestBindingIdentity as string,
          activationBindingIdentity: event.delivery.activationBindingIdentity as string,
        }),
      });
      try { ingress.emit(Object.freeze({ ...content, contentIdentity: canonicalDigest(content as never) })); }
      catch { /* M02 Observation remains one-way and non-controlling. */ }
    },
  });
}
