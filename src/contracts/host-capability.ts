import type { Absent, DeliveryRef, EpisodeRef, InterventionId, Knowledge, Result, RetirementAuthorizationRef, ThreadRef } from "./primitives.js";
import type { CompiledGraphActivation } from "./compiled-activation.js";
import type { BoundedWorkflowResult, CheckpointRef, OwnerRetirementDisposition, SavepointRef, TerminalReason } from "./lifecycle-records.js";
import type { ActionInputRequest, ActionInputResponse, ActionOutputSink } from "./invocation-capability.js";
import type { AdmittedControlResult, ExternalControlRequest } from "./interaction-capability.js";
import type { ExecutionSiteRef } from "./primitives.js";

export interface WorkflowWaitSuspension { readonly checkpoint: CheckpointRef; readonly request: ExternalControlRequest }
export interface ActionInputSuspension { readonly checkpoint: CheckpointRef; readonly episode: EpisodeRef; readonly request: ActionInputRequest }
export interface TerminalProposal { readonly thread: ThreadRef; readonly checkpoint: CheckpointRef; readonly proposedOutcome: "COMPLETED" | "INCOMPLETE" | "FAILED" | "CANCELLED"; readonly reason: TerminalReason; readonly result: Knowledge<BoundedWorkflowResult> }
export interface HostInterventionRef { readonly identity: InterventionId; readonly thread: ThreadRef; readonly reason: TerminalReason; readonly checkpoint: Knowledge<CheckpointRef> }
export type HostDisposition = Readonly<{ kind: "workflow-wait"; wait: WorkflowWaitSuspension }> | Readonly<{ kind: "action-input"; wait: ActionInputSuspension }> | Readonly<{ kind: "intervention"; intervention: HostInterventionRef }> | Readonly<{ kind: "terminal-proposal"; proposal: TerminalProposal }>;
export interface CoordinatorHost {
  start(compiled: CompiledGraphActivation, output: ActionOutputSink): Promise<Result<HostDisposition, HostError>>;
  resumeWorkflow(request: Readonly<{ thread: ThreadRef; result: AdmittedControlResult }>, output: ActionOutputSink): Promise<Result<HostDisposition, HostError>>;
  resumeAction(request: Readonly<{ thread: ThreadRef; episode: EpisodeRef; response: ActionInputResponse }>, output: ActionOutputSink): Promise<Result<HostDisposition, HostError>>;
  stop(request: Readonly<{ thread: ThreadRef; reason: "CANCEL" | "RECOVERY" | "RETIREMENT" }>): Promise<Result<HostStopFact, HostError>>;
  inspect(thread: ThreadRef): Promise<Result<HostInspection, HostError>>;
  recover(request: Readonly<{ thread: ThreadRef; directive: "continue" | "restart-from-savepoint" | "intervene"; checkpoint: Knowledge<CheckpointRef>; savepoint: Knowledge<SavepointRef> }>): Promise<Result<HostDisposition, HostError>>;
  retire(request: Readonly<{ thread: ThreadRef; authorization: RetirementAuthorizationRef }>): Promise<Result<OwnerRetirementDisposition, HostError>>;
}
export interface HostStopFact { readonly thread: ThreadRef; readonly state: Knowledge<"stopped" | "already-stable">; readonly checkpoint: Knowledge<CheckpointRef> }
export interface HostInspection { readonly thread: ThreadRef; readonly checkpoint: Knowledge<CheckpointRef>; readonly pendingSite: Knowledge<ExecutionSiteRef | Absent>; readonly disposition: Knowledge<HostDisposition | Absent> }
export type HostError = Readonly<{ code: "ACTIVATION_MISMATCH" | "ILLEGAL_SUCCESSOR" | "DATAFLOW_BINDING_INVALID" | "CHECKPOINT_ORDER_VIOLATION" | "CONTROL_MISMATCH" | "ACTION_INPUT_MISMATCH" | "RECOVERY_NOT_ADMITTED" | "RETIREMENT_NOT_AUTHORIZED" }>;
