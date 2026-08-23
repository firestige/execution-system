export type StableId<K extends string> = string & { readonly __stableIdKind: K };
export type Sha256 = `sha256:${string}`;
export type AbsolutePath = string & { readonly __pathKind: "absolute" };
export type WorkspaceRelativePath = string & { readonly __pathKind: "workspace-relative" };
export type ContractRevision = "agentops.workflow-dsl@1.1.0";
export type Absent = Readonly<{ kind: "ABSENT" }>;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type DeepReadonly<T> = T extends JsonPrimitive
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
export type FrozenJsonValue = DeepReadonly<JsonValue>;
export type FrozenJsonObject = DeepReadonly<JsonObject>;
export type FrozenJsonSchema = FrozenJsonObject;
export type FrozenRedactedDetail = FrozenJsonObject;

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export type ActionId = StableId<"action">;
export type AgentDefinitionResourceId = StableId<"agent-definition-resource">;
export type AgentExecutorId = StableId<"agent-executor">;
export type ArtifactId = StableId<"artifact">;
export type AttemptId = StableId<"attempt">;
export type AuditCorrelationId = StableId<"audit-correlation">;
export type BranchId = StableId<"branch">;
export type CheckpointId = StableId<"checkpoint">;
export type ControlId = StableId<"control">;
export type CorrelationId = StableId<"correlation">;
export type DecisionId = StableId<"decision">;
export type DeliveryId = StableId<"delivery">;
export type DriverResourceId = StableId<"driver-resource">;
export type GitTreeId = StableId<"git-tree">;
export type HandleId = StableId<"handle">;
export type HostOperationContractId = StableId<"host-operation-contract">;
export type HostOperationId = StableId<"host-operation">;
export type ImplementationId = StableId<"implementation">;
export type InstructionResourceId = StableId<"instruction-resource">;
export type InteractionRequestId = StableId<"interaction-request">;
export type InteractionReceiptId = StableId<"interaction-receipt">;
export type InterventionId = StableId<"intervention">;
export type InvocationId = StableId<"invocation">;
export type InvocationJournalId = StableId<"invocation-journal">;
export type ModelResourceId = StableId<"model-resource">;
export type NodeId = StableId<"node">;
export type PackageId = StableId<"package">;
export type PreservedResultId = StableId<"preserved-result">;
export type PublicationGuardId = StableId<"publication-guard">;
export type PublicationId = StableId<"publication">;
export type PublicationTargetId = StableId<"publication-target">;
export type ProviderModelId = StableId<"provider-model">;
export type ReadViewId = StableId<"read-view">;
export type ResourceId = StableId<"resource">;
export type RetirementAuthorizationId = StableId<"retirement-authorization">;
export type RoleId = StableId<"role">;
export type RouteId = StableId<"route">;
export type RuntimeProfileId = StableId<"runtime-profile">;
export type SavepointId = StableId<"savepoint">;
export type SessionAffinityId = StableId<"session-affinity">;
export type SessionBindingId = StableId<"session-binding">;
export type SessionPolicyId = StableId<"session-policy">;
export type SettlementId = StableId<"settlement">;
export type SnapshotId = StableId<"snapshot">;
export type TaskId = StableId<"task">;
export type TerminalId = StableId<"terminal">;
export type ThreadId = StableId<"thread">;
export type WorkflowId = StableId<"workflow">;
export type WorkflowResultId = StableId<"workflow-result">;
export type WorkspaceId = StableId<"workspace">;

export type ExecutionSiteRef =
  | Readonly<{ kind: "node"; nodeIdentity: NodeId }>
  | Readonly<{ kind: "parallel-branch"; nodeIdentity: NodeId; branchIdentity: BranchId }>
  | Readonly<{ kind: "parallel-join"; nodeIdentity: NodeId }>;
export type CanonicalExecutionSiteKey =
  | `node:${NodeId}`
  | `parallel-branch:${NodeId}:${BranchId}`
  | `parallel-join:${NodeId}`;

export interface DeliveryRef {
  readonly deliveryIdentity: DeliveryId;
  readonly manifestBindingIdentity: Sha256;
  readonly activationBindingIdentity: Sha256;
}
export interface ThreadRef { readonly delivery: DeliveryRef; readonly threadIdentity: ThreadId }
export interface EpisodeRef {
  readonly thread: ThreadRef;
  readonly site: ExecutionSiteRef;
  readonly invocationIdentity: InvocationId;
  readonly attemptIdentity: AttemptId;
}
export type Knowledge<T> = Readonly<{ state: "known"; value: T }> | UnknownState;
export interface UnknownState {
  readonly state: "unknown";
  readonly owner: "coordinator" | "host" | "invocation" | "custody";
  readonly reason: "CALL_INTERRUPTED" | "CHILD_UNREACHABLE" | "PROCESS_EXIT_UNOBSERVED" | "CHECKPOINT_DISPOSITION_UNOBSERVED" | "PUBLICATION_DISPOSITION_UNOBSERVED" | "CLEANUP_DISPOSITION_UNOBSERVED";
}
export interface RetirementAuthorizationRef { readonly identity: RetirementAuthorizationId; readonly delivery: DeliveryRef }
