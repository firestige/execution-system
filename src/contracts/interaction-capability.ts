import type { ControlId, CorrelationId, FrozenJsonValue, Result, Sha256 } from "./primitives.js";
import type { ActionInputRequest, ActionInputResponse, ActionOutputSink, InteractionError } from "./invocation-capability.js";

export interface ExternalControlRequest { readonly controlIdentity: ControlId; readonly correlationIdentity: CorrelationId; readonly kind: "user" | "external-workflow"; readonly content: FrozenJsonValue; readonly contentIdentity: Sha256 }
export interface AdmittedControlResult { readonly controlIdentity: ControlId; readonly correlationIdentity: CorrelationId; readonly content: FrozenJsonValue; readonly contentIdentity: Sha256 }
export interface ActionInteractionBridge extends ActionOutputSink { requestInput(request: ActionInputRequest): Promise<Result<ActionInputResponse, InteractionError>> }
export interface WorkflowControlBridge { request(request: ExternalControlRequest): Promise<Result<AdmittedControlResult, ControlBridgeError>> }
export type ControlBridgeError = Readonly<{ code: "CONTROL_UNAVAILABLE" | "CONTROL_CANCELLED" | "CONTROL_CORRELATION_MISMATCH" }>;
