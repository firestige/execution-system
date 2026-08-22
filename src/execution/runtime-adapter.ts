import type { DeliveryRef, FrozenRedactedDetail, Knowledge, Result } from "../contracts/primitives.js";
import type { RunnerActivationContext } from "../contracts/runner-activation.js";
import type { PreservedResultRef, RuntimeTerminalOutcome, TerminalSettlementRecord } from "../contracts/lifecycle-records.js";

export const EXECUTION_RUNTIME_ADAPTER_VERSION = "execution.runtime-adapter@1.0.0" as const;

export interface ExecutionRuntimeExecuteRequest { readonly interfaceVersion: typeof EXECUTION_RUNTIME_ADAPTER_VERSION; readonly activation: RunnerActivationContext }
export type ExecutionRuntimeResult = Readonly<{ kind: "terminal"; outcome: RuntimeTerminalOutcome; settlement: TerminalSettlementRecord; result: Knowledge<PreservedResultRef> }> | Readonly<{ kind: "start-failed"; code: "START_FAILED"; detail: FrozenRedactedDetail }> | Readonly<{ kind: "unknown"; delivery: DeliveryRef; detail: FrozenRedactedDetail }>;
export interface ExecutionRuntimeInspection { readonly delivery: DeliveryRef; readonly state: "running" | "stable" | "terminal" | "unknown"; readonly result: Knowledge<ExecutionRuntimeResult> }
export interface ExecutionRuntimeCancellation { readonly delivery: DeliveryRef; readonly state: Knowledge<"accepted" | "already-stable"> }
export type ExecutionRuntimeAdapterError = Readonly<{ code: "ACTIVATION_REJECTED" | "CORRELATION_MISMATCH" | "ADAPTER_UNAVAILABLE" }>;

/** Execution-owned public seam. Resume/recovery remain Runner-private and are intentionally absent. */
export interface ExecutionRuntimeAdapter {
  execute(request: ExecutionRuntimeExecuteRequest): Promise<Result<ExecutionRuntimeResult, ExecutionRuntimeAdapterError>>;
  inspect(delivery: DeliveryRef): Promise<Result<ExecutionRuntimeInspection, ExecutionRuntimeAdapterError>>;
  cancel(delivery: DeliveryRef): Promise<Result<ExecutionRuntimeCancellation, ExecutionRuntimeAdapterError>>;
}
