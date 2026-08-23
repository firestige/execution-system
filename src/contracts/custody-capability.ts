import type { DeliveryRef, EpisodeRef, GitTreeId, HandleId, Knowledge, ReadViewId, Result, RetirementAuthorizationRef, Sha256 } from "./primitives.js";
import type { AdmittedWorkspace, ResolvedAccessRule } from "./runner-activation.js";
import type { BoundedWorkflowResult, CheckpointRef, OwnerRetirementDisposition, PreservedResultRef, PublicationDisposition, PublicationGuardRef, PublicationTargetRef, SavepointRef } from "./lifecycle-records.js";

export interface AuthorizedInvocationHandle { readonly handleIdentity: HandleId; readonly episode: EpisodeRef; readonly savepoint: SavepointRef; readonly accessDigest: Sha256 }
export interface AuthorizedReadView { readonly viewIdentity: ReadViewId; readonly episode: EpisodeRef; readonly source: SavepointRef; readonly accessDigest: Sha256 }
export type AuthorizedWorkspaceCapability = Readonly<{ kind: "write"; handle: AuthorizedInvocationHandle }> | Readonly<{ kind: "read"; view: AuthorizedReadView }> | Readonly<{ kind: "none" }>;
export interface HostCustody {
  establishBaseline(request: Readonly<{ delivery: DeliveryRef; workspace: AdmittedWorkspace }>): Promise<Result<SavepointRef, CustodyError>>;
  acquireWriteHandle(request: Readonly<{ episode: EpisodeRef; savepoint: SavepointRef; access: readonly ResolvedAccessRule[] }>): Promise<Result<AuthorizedInvocationHandle, CustodyError>>;
  openReadView(request: Readonly<{ episode: EpisodeRef; source: SavepointRef; access: readonly ResolvedAccessRule[] }>): Promise<Result<AuthorizedReadView, CustodyError>>;
  settleWorkspaceAttempt(request: Readonly<{ episode: EpisodeRef; workspace: AuthorizedWorkspaceCapability; hostDecision: "accept" | "reject" }>): Promise<Result<CustodyAttemptDisposition, CustodyError>>;
  validateReadView(view: AuthorizedReadView): Promise<Result<ReadViewDisposition, CustodyError>>;
}
export interface CoordinatorCustody {
  preserveResult(request: Readonly<{ checkpoint: CheckpointRef; result: BoundedWorkflowResult }>): Promise<Result<PreservedResultRef, CustodyError>>;
  publish(request: Readonly<{ result: PreservedResultRef; target: PublicationTargetRef; guard: PublicationGuardRef }>): Promise<Result<PublicationDisposition, CustodyError>>;
  inspect(delivery: DeliveryRef): Promise<Result<CustodyInspection, CustodyError>>;
  recover(request: Readonly<{ delivery: DeliveryRef; directive: "continue" | "restore-from-savepoint" | "intervene"; savepoint: Knowledge<SavepointRef> }>): Promise<Result<CustodyRecoveryDisposition, CustodyError>>;
  retire(authorization: RetirementAuthorizationRef): Promise<Result<OwnerRetirementDisposition, CustodyError>>;
}
export type CustodyAttemptDisposition = Readonly<{ kind: "accepted"; nextSavepoint: Knowledge<SavepointRef | import("./primitives.js").Absent> }> | Readonly<{ kind: "scope-violation-restored" | "host-rejected-restored"; restoredSavepoint: SavepointRef }> | Readonly<{ kind: "restore-failed"; state: Knowledge<SavepointRef> }>;
export type ReadViewDisposition = Readonly<{ kind: "current"; view: AuthorizedReadView }> | Readonly<{ kind: "source-changed"; observed: Knowledge<GitTreeId> }> | Readonly<{ kind: "mutation-detected"; restored: Knowledge<SavepointRef> }>;
export interface CustodyInspection { readonly delivery: DeliveryRef; readonly currentSavepoint: Knowledge<SavepointRef>; readonly preservedResult: Knowledge<PreservedResultRef>; readonly publication: Knowledge<PublicationDisposition> }
export type CustodyRecoveryDisposition = Readonly<{ kind: "continued" | "restored"; savepoint: SavepointRef }> | Readonly<{ kind: "intervention-required"; state: Knowledge<SavepointRef> }>;
export type CustodyError = Readonly<{ code: "CORRELATION_MISMATCH" | "BASELINE_MISSING" | "GIT_STATE_MISMATCH" | "READ_VIEW_INVALID" | "PUBLICATION_GUARD_INVALID" | "RETIREMENT_NOT_AUTHORIZED" }>;
