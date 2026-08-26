import { realpath } from "node:fs/promises";

import type {
  ExecutionContended,
  ExecutionFailure,
  ExecutionPreDeliveryCancelled,
  ExecutionRecovery,
} from "../application/execution-application.js";
import type { DeliveryAdmissionHolder, DeliveryAdmissionService } from "../delivery/index.js";
import { CoreRequestError, admitConversationWorkspaceAuthorization, captureRequestWorktree, createPrebindingCommand, type ConversationWorkspaceAuthorization, type ExecutionEnvironment, type ExecutionPrebindingCommand } from "./request.js";
import { WorktreeAdmissionError, canonicalizeWorktree } from "./worktree.js";

export interface ExecutionPrebindingReady {
  readonly kind: "NEW";
  readonly command: ExecutionPrebindingCommand;
  readonly holder: DeliveryAdmissionHolder;
}

export type CoreAdmissionResult = ExecutionPrebindingReady | ExecutionContended | ExecutionRecovery | ExecutionFailure;

function failure(code: ExecutionFailure["code"]): ExecutionFailure {
  return Object.freeze({ kind: "ERROR", code, message: code });
}

export class ExecutionCoreAdmission {
  constructor(readonly environment: ExecutionEnvironment, readonly admission: DeliveryAdmissionService) {}

  async begin(candidate: unknown, authority?: ConversationWorkspaceAuthorization): Promise<CoreAdmissionResult> {
    let requestedWorktree: string;
    try { requestedWorktree = captureRequestWorktree(candidate); }
    catch { return failure("INVALID_EXECUTION_REQUEST"); }
    let canonicalWorktree: string;
    try {
      let allowedRoots = this.environment.allowedWorktreeRoots;
      if (authority !== undefined) {
        let admitted: ConversationWorkspaceAuthorization;
        try { admitted = admitConversationWorkspaceAuthorization(authority); }
        catch { throw new WorktreeAdmissionError("WORKTREE_OUT_OF_SCOPE"); }
        const [requested, exactRoot] = await Promise.all([realpath(requestedWorktree), realpath(admitted.path)]);
        if (requested !== exactRoot) throw new WorktreeAdmissionError("WORKTREE_OUT_OF_SCOPE");
        allowedRoots = [exactRoot];
      }
      canonicalWorktree = await canonicalizeWorktree(requestedWorktree, allowedRoots);
    }
    catch (cause) {
      return failure(cause instanceof WorktreeAdmissionError ? cause.code : "INVALID_WORKTREE");
    }
    const disposition = await this.admission.admit(canonicalWorktree);
    if (disposition.kind === "CONTENDED") return Object.freeze(disposition);
    if (disposition.kind === "RECOVERY") {
      return Object.freeze({ kind: "RECOVERY", worktree: disposition.worktree, deliveryId: disposition.deliveryId, state: disposition.state });
    }
    if (disposition.kind === "BUSY") return failure("EXECUTION_BUSY");
    try {
      return Object.freeze({
        kind: "NEW",
        command: createPrebindingCommand(candidate, canonicalWorktree, disposition.holder.admissionId, this.environment),
        holder: disposition.holder,
      });
    } catch (cause) {
      await disposition.holder.release();
      return failure(cause instanceof CoreRequestError ? cause.code : "INVALID_EXECUTION_REQUEST");
    }
  }

  async cancelPreDelivery(admissionId: string): Promise<ExecutionPreDeliveryCancelled> {
    return this.admission.cancelPreDelivery(admissionId);
  }
}
