import type { WorkflowPackageSource } from "../bootstrap/index.js";
import { parseWorkflowSelector, WorkflowSelectorError } from "./selector.js";
import type { ResolvedWorkflowPackage, WorkflowPackageStaging } from "./workflow-package-store.js";
import { WorkflowPackageStore, WorkflowPackageStoreError } from "./workflow-package-store.js";
import type { ValidatedWorkflowPackage } from "./workflow-package-store.js";

export type WorkflowPackageResolutionErrorCode =
  | "INVALID_WORKFLOW_SELECTOR"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_FETCH_FAILED"
  | "WORKFLOW_PACKAGE_INVALID"
  | "WORKFLOW_VERSION_MISMATCH"
  | "WORKFLOW_DIGEST_MISMATCH"
  | "WORKFLOW_DSH_INCOMPATIBLE"
  | "WORKFLOW_CACHE_PUBLISH_FAILED";

export type WorkflowPackageResolutionResult =
  | Readonly<{ ok: true; value: ResolvedWorkflowPackage }>
  | Readonly<{ ok: false; error: Readonly<{ code: WorkflowPackageResolutionErrorCode }> }>;

function failure(code: WorkflowPackageResolutionErrorCode): WorkflowPackageResolutionResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

export class WorkflowPackageResolver {
  constructor(
    readonly store: WorkflowPackageStore,
    readonly source: WorkflowPackageSource,
    readonly validator: Readonly<{ validate(staging: WorkflowPackageStaging): Promise<ValidatedWorkflowPackage> }>,
  ) {}

  async resolve(selector: string, refresh = false): Promise<WorkflowPackageResolutionResult> {
    let request;
    try { request = parseWorkflowSelector(selector); }
    catch (cause) { return failure(cause instanceof WorkflowSelectorError ? cause.code : "INVALID_WORKFLOW_SELECTOR"); }
    try {
      const local = await this.store.lookupExact(request.name, request.version.value);
      if (local !== undefined && !refresh) return Object.freeze({ ok: true, value: local });
    } catch (cause) {
      return failure(cause instanceof WorkflowPackageStoreError ? cause.code : "WORKFLOW_PACKAGE_INVALID");
    }
    let sourced;
    try { sourced = await this.source.fetch(request); }
    catch { return failure("WORKFLOW_FETCH_FAILED"); }
    if (sourced.kind === "NOT_FOUND") return failure("WORKFLOW_NOT_FOUND");
    if (sourced.kind === "UNAVAILABLE") return failure("WORKFLOW_FETCH_FAILED");
    if (sourced.kind === "DIGEST_MISMATCH") return failure("WORKFLOW_DIGEST_MISMATCH");
    if (sourced.kind === "INVALID") return failure("WORKFLOW_PACKAGE_INVALID");
    if (sourced.candidate.name !== request.name
      || sourced.candidate.exactVersion !== request.version.value) {
      return failure("WORKFLOW_VERSION_MISMATCH");
    }
    let staging: WorkflowPackageStaging | undefined;
    try {
      staging = await this.store.stage(sourced.candidate);
      const validated = await this.validator.validate(staging);
      const resolved = await this.store.publish(staging, validated);
      return Object.freeze({ ok: true, value: resolved });
    } catch (cause) {
      if (staging !== undefined) await this.store.discard(staging);
      return failure(cause instanceof WorkflowPackageStoreError
        ? cause.code
        : "WORKFLOW_PACKAGE_INVALID");
    }
  }
}
