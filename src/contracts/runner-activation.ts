import type {
  ContractControlNode,
  ContractCorrelationRule,
  ContractDeliveryContextField,
  ContractEventSuccessors,
  ContractEventTransition,
  ContractExpiryPolicy,
  ContractGate,
  ContractHostCapability,
  ContractOrdinaryTransition,
  ContractProviderCapability,
  ContractSourcePortRef,
  ContractStateField,
  ContractTarget,
  ContractTargetPortRef,
  ContractTerminal,
  ContractValueSlot,
} from "./generated/workflow-contract.js";
import type {
  Absent, AbsolutePath, ActionId, AgentDefinitionResourceId, AgentExecutorId, ArtifactId,
  BranchId, ContractRevision, ControlId, DecisionId, DeliveryId, DriverResourceId,
  ExecutionSiteRef, FrozenJsonObject, FrozenJsonSchema, HostOperationContractId,
  HostOperationId, InstructionResourceId, ModelResourceId, PackageId, ProviderModelId,
  ResourceId, RoleId, RouteId, RuntimeProfileId, SessionPolicyId, Sha256, SnapshotId,
  TaskId, WorkspaceId, WorkspaceRelativePath, GitTreeId,
} from "./primitives.js";

export type AdmittedControlNode = ContractControlNode;
export type AdmittedOrdinaryTransition = ContractOrdinaryTransition;
export type AdmittedEventTransition = ContractEventTransition;
export type AdmittedTerminal = ContractTerminal;
export type AdmittedGate = ContractGate;
export type AdmittedExpiryPolicy = ContractExpiryPolicy;
export type ClosedCorrelationRule = ContractCorrelationRule;
export type Target = ContractTarget;
export type AdmittedEventSuccessors = ContractEventSuccessors;
export type DeliveryContextField = ContractDeliveryContextField;
export type StateField = ContractStateField;
export type ProviderCapability = ContractProviderCapability;
export type HostCapability = ContractHostCapability;
export type SourcePortRef = ContractSourcePortRef;
export type TargetPortRef = ContractTargetPortRef;
export type ValueSlot = ContractValueSlot;

export interface DeliveryCorrelation {
  readonly deliveryIdentity: DeliveryId;
  readonly taskIdentity: TaskId;
  readonly manifestBindingIdentity: Sha256;
  readonly packageIdentity: PackageId;
  readonly packageDigest: Sha256;
  readonly snapshotIdentity: SnapshotId;
  readonly snapshotDigest: Sha256;
  readonly workflowIdentity: import("./primitives.js").WorkflowId;
  readonly runtimeProfileIdentity: RuntimeProfileId;
}
export interface FrozenWorkflowState { readonly identity: Sha256; readonly values: FrozenJsonObject }
export interface AdmittedArtifactVersionRef { readonly artifactIdentity: ArtifactId; readonly versionIdentity: import("./primitives.js").StableId<"artifact-version">; readonly contentIdentity: Sha256 }
export interface AdmittedArtifactManifest { readonly identity: Sha256; readonly versions: Readonly<Record<ArtifactId, AdmittedArtifactVersionRef | Absent>> }
export interface AdmittedWorkspace { readonly identity: WorkspaceId; readonly canonicalWorktreePath: AbsolutePath; readonly admittedGitTree: GitTreeId }
export interface AdmittedInitialData { readonly state: FrozenWorkflowState; readonly artifacts: AdmittedArtifactManifest; readonly workspace: AdmittedWorkspace }
export interface AdmissionBinding { readonly contractRevision: ContractRevision; readonly authorityMergeIdentity: Sha256; readonly deliveryAdmissionContractIdentity: "agentops.delivery-admission@1.0.0" | "agentops.delivery-admission@2.0.0" }

export interface AdmittedControlGraph {
  readonly entryNode: import("./primitives.js").NodeId;
  readonly nodes: readonly AdmittedControlNode[];
  readonly ordinarySuccessor: readonly AdmittedOrdinaryTransition[];
  readonly eventSuccessor: readonly AdmittedEventTransition[];
  readonly decisions: readonly AdmittedDecision[];
  readonly controls: readonly ResolvedControlBinding[];
  readonly terminals: readonly AdmittedTerminal[];
}
export interface CaseMapSelector { readonly kind: "case-map"; readonly cases: readonly { readonly value: boolean | string; readonly target: Target }[] }
export interface HostOperationSelector { readonly kind: "host-operation"; readonly operationIdentity: HostOperationId; readonly allowedTargets: readonly Target[] }
export interface SingleTargetDecision { readonly identity: DecisionId; readonly source: SourcePortRef; readonly selector: CaseMapSelector | HostOperationSelector }
export interface BranchSubsetDecision { readonly identity: DecisionId; readonly source: SourcePortRef }
export type AdmittedDecision = SingleTargetDecision | BranchSubsetDecision;

export interface AdmittedActionTemplate { readonly identity: ActionId; readonly purpose: string; readonly inputSchema: FrozenJsonSchema | Absent; readonly resultSchema: FrozenJsonSchema; readonly gate: AdmittedGate }
export interface ResolvedExecutionSite {
  readonly site: ExecutionSiteRef;
  readonly actionIdentity: ActionId;
  readonly executor: Readonly<{ kind: "agent"; identity: AgentExecutorId; requiredCapabilities: readonly ProviderCapability[] }> | Readonly<{ kind: "host-operation"; identity: HostOperationId }>;
}
export interface ResolvedAgentBinding { readonly resourceIdentity: AgentDefinitionResourceId; readonly contentIdentity: Sha256; readonly projectionIdentity: Sha256; readonly localReadOnlyPath: AbsolutePath }
export interface ResolvedModelBinding { readonly resourceIdentity: ModelResourceId; readonly contentIdentity: Sha256; readonly projectionIdentity: Sha256; readonly providerModelIdentity: ProviderModelId; readonly configuration: FrozenJsonObject }
export interface ResolvedDriverProjection { readonly resourceIdentity: DriverResourceId; readonly projectionIdentity: Sha256; readonly providerIdentity: "dsh-headless" | "copilot-sdk" | "codex-cli"; readonly configuration: FrozenJsonObject }
export interface ResolvedInstructionProjection { readonly resourceIdentity: InstructionResourceId; readonly contentIdentity: Sha256; readonly localReadOnlyPath: AbsolutePath }
export interface ResolvedResourceProjection { readonly resourceIdentity: ResourceId; readonly contentIdentity: Sha256; readonly localReadOnlyPath: AbsolutePath | Absent; readonly configuration: FrozenJsonObject | Absent }
export interface ResolvedSessionPolicy { readonly identity: SessionPolicyId; readonly scope: Readonly<{ kind: "episode" }> | Readonly<{ kind: "data-bound"; source: SourcePortRef }>; readonly isolation: "shared" | "isolated" }
export interface ResolvedAccessRule { readonly mode: "read" | "write"; readonly path: WorkspaceRelativePath }
export interface ResolvedAgentSessionBinding { readonly roleIdentity: RoleId; readonly routeIdentity: RouteId; readonly agent: ResolvedAgentBinding; readonly model: ResolvedModelBinding; readonly driver: ResolvedDriverProjection; readonly instructions: ResolvedInstructionProjection; readonly tools: readonly ResolvedResourceProjection[]; readonly providedCapabilities: readonly ProviderCapability[]; readonly policy: ResolvedSessionPolicy }
export interface ResolvedAgentTurnBinding { readonly access: readonly ResolvedAccessRule[] }
export interface ResolvedAgentExecutor { readonly identity: AgentExecutorId; readonly bindingIdentity: Sha256; readonly sessionCompatibilityIdentity: Sha256; readonly session: ResolvedAgentSessionBinding; readonly turn: ResolvedAgentTurnBinding }
export interface ResolvedHostOperation { readonly identity: HostOperationId; readonly contractIdentity: HostOperationContractId; readonly configuration: FrozenJsonObject; readonly requiredCapabilities: readonly HostCapability[] }
export interface ResolvedExecutionCatalog { readonly actions: Readonly<Record<ActionId, AdmittedActionTemplate>>; readonly sites: readonly ResolvedExecutionSite[]; readonly agents: Readonly<Record<AgentExecutorId, ResolvedAgentExecutor>>; readonly hostOperations: Readonly<Record<HostOperationId, ResolvedHostOperation>> }
export interface ResolvedDataEdge { readonly source: SourcePortRef; readonly target: TargetPortRef }
export interface ResolvedDataflowPlan { readonly edges: readonly ResolvedDataEdge[] }
export interface ResolvedControlBinding { readonly identity: ControlId; readonly nodeIdentity: import("./primitives.js").NodeId; readonly kind: "user" | "external-workflow"; readonly resultSchema: FrozenJsonSchema; readonly correlation: ClosedCorrelationRule; readonly expiry: AdmittedExpiryPolicy; readonly resumeDecision: DecisionId }
export interface AdmittedRunnerProgram { readonly control: AdmittedControlGraph; readonly execution: ResolvedExecutionCatalog; readonly dataflow: ResolvedDataflowPlan }
export interface RunnerActivationContext { readonly schemaVersion: "runner.activation@1.0.0"; readonly bindingIdentity: Sha256; readonly correlation: DeliveryCorrelation; readonly program: AdmittedRunnerProgram; readonly initial: AdmittedInitialData; readonly admission: AdmissionBinding }
