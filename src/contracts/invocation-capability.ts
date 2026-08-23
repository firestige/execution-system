import type { DeliveryRef, EpisodeRef, FrozenJsonSchema, FrozenJsonValue, FrozenRedactedDetail, InteractionReceiptId, Knowledge, Result, RetirementAuthorizationRef, SessionAffinityId, SessionBindingId, Sha256 } from "./primitives.js";
import type { CompiledInvocationPlan } from "./compiled-activation.js";
import type { AdmittedActionTemplate, ResolvedAgentExecutor } from "./runner-activation.js";
import type { AuthorizedWorkspaceCapability } from "./custody-capability.js";
import type { OwnerRetirementDisposition } from "./lifecycle-records.js";

export interface SessionAffinityRef { readonly identity: SessionAffinityId; readonly delivery: DeliveryRef; readonly sessionCompatibilityIdentity: Sha256; readonly scopeValueIdentity: Sha256; readonly isolation: "shared" | "isolated" }
export interface ManagedSessionRef { readonly bindingIdentity: SessionBindingId; readonly affinity: SessionAffinityRef; readonly generation: number }
export interface InvocationDispatch { readonly episode: EpisodeRef; readonly plan: CompiledInvocationPlan; readonly action: AdmittedActionTemplate; readonly executor: ResolvedAgentExecutor; readonly input: FrozenJsonValue; readonly workspace: AuthorizedWorkspaceCapability; readonly session: SessionAffinityRef }
export interface AgentOutputFrame { readonly episode: EpisodeRef; readonly sequence: number; readonly content: FrozenJsonValue }
export interface ActionOutputSink { publish(frame: AgentOutputFrame): Promise<Result<void, InteractionError>> }
export interface ActionInputRequest { readonly identity: import("./primitives.js").InteractionRequestId; readonly episode: EpisodeRef; readonly prompt: FrozenJsonValue; readonly responseSchema: FrozenJsonSchema }
export type ActionInputResponse = Readonly<{
  readonly kind: "ANSWER" | "ACTION_FINISH_REQUESTED";
  readonly requestIdentity: import("./primitives.js").InteractionRequestId;
  readonly content: FrozenJsonValue;
  readonly contentIdentity: Sha256;
}>;
export interface ContinueInvocationRequest { readonly episode: EpisodeRef; readonly response: ActionInputResponse }
export interface InteractionReceiptRef { readonly identity: InteractionReceiptId; readonly requestIdentity: import("./primitives.js").InteractionRequestId; readonly responseIdentity: Sha256 }
export interface InvocationJournalRef { readonly identity: import("./primitives.js").InvocationJournalId; readonly episode: EpisodeRef }
export type InvocationDisposition = Readonly<{ kind: "completed"; episode: EpisodeRef; result: FrozenJsonValue; session: ManagedSessionRef; interactionReceipts: readonly InteractionReceiptRef[]; journal: InvocationJournalRef }> | Readonly<{ kind: "awaiting-input"; episode: EpisodeRef; request: ActionInputRequest; session: ManagedSessionRef; journal: InvocationJournalRef }> | Readonly<{ kind: "failed"; episode: EpisodeRef; failure: ManagedInvocationFailure; session: Knowledge<ManagedSessionRef>; journal: InvocationJournalRef }> | Readonly<{ kind: "invalid"; episode: EpisodeRef; violation: InvocationResultViolation; session: ManagedSessionRef; journal: InvocationJournalRef }> | Readonly<{ kind: "unknown"; episode: EpisodeRef; uncertainty: import("./primitives.js").UnknownState; session: Knowledge<ManagedSessionRef>; journal: Knowledge<InvocationJournalRef> }>;
export interface ManagedInvocationFailure { readonly code: "PROVIDER_EXITED" | "PROVIDER_TIMED_OUT" | "PROVIDER_CANCELLED" | "PROVIDER_PROTOCOL_ERROR" | "ACTION_INTERACTION_UNAVAILABLE" | "ACTION_INTERACTION_CANCELLED" | "CREDENTIAL_UNAVAILABLE"; readonly retry: "never" | "same-episode" | "new-attempt"; readonly detail: FrozenRedactedDetail }
export interface InvocationResultViolation { readonly code: "RESULT_SCHEMA_INVALID" | "RESULT_CORRELATION_INVALID" | "TURN_ENDED_WITHOUT_DISPOSITION" | "INTERACTION_CORRELATION_INVALID" | "PENDING_INPUT_AT_COMPLETION" | "DUPLICATE_COMPLETION"; readonly detail: FrozenRedactedDetail }
export interface HostInvocation { start(dispatch: InvocationDispatch, output: ActionOutputSink): Promise<Result<InvocationDisposition, InvocationCallError>>; continueWithInput(request: ContinueInvocationRequest, output: ActionOutputSink): Promise<Result<InvocationDisposition, InvocationCallError>> }
export interface CoordinatorInvocationControl { cancel(request: Readonly<{ delivery: DeliveryRef; reason: "DELIVERY_CANCELLED" | "TIMEOUT" | "COORDINATOR_STOP" }>): Promise<Result<InvocationControlFact, InvocationCallError>>; inspect(delivery: DeliveryRef): Promise<Result<InvocationControlFact, InvocationCallError>>; retire(authorization: RetirementAuthorizationRef): Promise<Result<OwnerRetirementDisposition, InvocationCallError>> }
export interface InvocationControlFact { readonly delivery: DeliveryRef; readonly process: Knowledge<"running" | "stopped" | "terminal">; readonly sessions: Knowledge<readonly ManagedSessionRef[]>; readonly journals: Knowledge<readonly InvocationJournalRef[]> }
export type InvocationCallError = Readonly<{ code: "CORRELATION_MISMATCH" | "EXECUTOR_BINDING_MISMATCH" | "MODEL_BINDING_MISMATCH" | "SESSION_AFFINITY_MISMATCH" | "SESSION_STATE_UNKNOWN" | "CAPABILITY_MISMATCH" | "PROVIDER_NOT_IMPLEMENTED" | "MANAGED_PATH_BYPASS" | "CREDENTIAL_ACQUISITION_FAILED" | "RETIREMENT_NOT_AUTHORIZED" }>;
export type InteractionError = Readonly<{ code: "INTERACTION_UNAVAILABLE" | "INTERACTION_CANCELLED" | "INTERACTION_CORRELATION_MISMATCH" }>;
