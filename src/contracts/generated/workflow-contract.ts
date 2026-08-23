// GENERATED from agentops.workflow-dsl@1.1.0. Do not edit by hand.
import type { ArtifactId, BranchId, ControlId, DeepReadonly, ExecutionSiteRef, FrozenJsonObject, FrozenJsonSchema, HostOperationContractId, HostOperationId, NodeId, Sha256, StableId, TerminalId } from "../primitives.js";

export type ContractDeliveryContextField = "deliveryIdentity" | "taskIdentity" | "workflowIdentity" | "snapshotIdentity";
export type ContractStateField = string;
export type ContractProviderCapability = "structured-completion" | "action-interaction";
export type ContractHostCapability = "deterministic-validation" | "deterministic-selection" | "deterministic-transformation";
export type ContractTarget = string;
export interface ContractCorrelationRule { readonly identitySource: string; readonly staleRejected: true; readonly duplicateRejected: true }
export interface ContractExpiryPolicy { readonly mode: "renew" | "incomplete"; readonly maxRenewals: number }
export interface ContractGate { readonly deterministic?: readonly string[]; readonly freeTextBypass: "prohibited" }
export type ContractControlNode =
  | Readonly<{ id: NodeId; kind: "action"; action: string; routing?: unknown }>
  | Readonly<{ id: NodeId; kind: "parallel"; branches: readonly { id: BranchId; action: string; required: true }[]; maxConcurrency: number; selection?: { readonly source: ContractSourcePortRef }; join: unknown; routing?: unknown }>
  | Readonly<{ id: NodeId; kind: "wait"; wait: string; continuationSource: true }>
  | Readonly<{ id: NodeId; kind: "wait-renewal"; wait: string; maxRenewals: number }>
  | Readonly<{ id: NodeId; kind: "recovery"; recovery: string; action?: string; continuationSource: true }>
  | Readonly<{ id: NodeId; kind: "cleanup"; disposition: "cancellation" | "failure" | "continuation"; action: string }>;
export interface ContractOrdinaryTransition { readonly id: string; readonly from: NodeId; readonly to: ContractTarget }
export interface ContractEventTransition { readonly id: string; readonly from: NodeId; readonly event: "budget-exhausted" | "wait-expired" | "cancelled" | "nonretryable-failure" | "continuation-invalid"; readonly to: ContractTarget }
export interface ContractTerminal { readonly id: TerminalId; readonly kind: "success" | "failure" | "incomplete" | "cancelled" | "custom"; readonly meaning: string }
export type ContractEventSuccessors = Readonly<Partial<Record<ContractEventTransition["event"], ContractTarget>>>;
export type ContractValueSlot = Readonly<{ kind: "whole" }> | Readonly<{ kind: "property"; name: string }>;
export type ContractSourcePortRef =
  | Readonly<{ kind: "context"; field: ContractDeliveryContextField }>
  | Readonly<{ kind: "state"; field: ContractStateField }>
  | Readonly<{ kind: "artifact"; artifactIdentity: ArtifactId }>
  | Readonly<{ kind: "site-result"; site: ExecutionSiteRef; slot: ContractValueSlot }>
  | Readonly<{ kind: "control-result"; controlIdentity: ControlId; slot: ContractValueSlot }>;
export type ContractTargetPortRef =
  | Readonly<{ kind: "site-input"; site: ExecutionSiteRef; slot: ContractValueSlot }>
  | Readonly<{ kind: "control-input"; controlIdentity: ControlId; slot: ContractValueSlot }>
  | Readonly<{ kind: "state"; field: ContractStateField }>
  | Readonly<{ kind: "artifact"; artifactIdentity: ArtifactId }>;
export interface ContractHostOperation { readonly identity: HostOperationId; readonly contractIdentity: HostOperationContractId; readonly configuration: FrozenJsonObject; readonly requiredCapabilities: readonly ContractHostCapability[] }
export type ContractSchema = DeepReadonly<FrozenJsonSchema>;
export type ContractContentIdentity = Sha256;
export type ContractIdentity = StableId<string>;
