import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ContractHostCapability, ContractProviderCapability } from "../contracts/generated/workflow-contract.js";
import type { ValidatedWorkflowPackage, WorkflowPackageStaging } from "./workflow-package-store.js";
import { WorkflowPackageStoreError } from "./workflow-package-store.js";
import { extractWorkflowV2RoleSnapshot, type ExtractedWorkflowV2RoleSnapshot } from "./workflow-v2-role-snapshot.js";

const CHECKER_V2 = fileURLToPath(new URL("../../config/workflow-dsl-v2-candidate/tools/check-example.cjs", import.meta.url));

function versionParts(value: string): readonly number[] | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(value);
  return match === null ? undefined : Object.freeze(match.slice(1).map(Number));
}

function compareVersion(left: string, right: string): number | undefined {
  const a = versionParts(left);
  const b = versionParts(right);
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

async function json(path: string): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid JSON object");
    return value as Record<string, any>;
  } catch { throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID"); }
}

export interface WorkflowPackageCompatibilityTargetV2 {
  readonly contractVersion: "2.0.0";
  readonly providerIdentity: string;
  readonly providerCapabilities: readonly ContractProviderCapability[];
  readonly hostCapabilities: readonly ContractHostCapability[];
}

export interface ValidatedWorkflowPackageV2 extends ValidatedWorkflowPackage, ExtractedWorkflowV2RoleSnapshot {}

export class FrozenWorkflowPackageValidatorV2 {
  constructor(readonly compatibility: WorkflowPackageCompatibilityTargetV2) {}

  async validate(staging: WorkflowPackageStaging): Promise<ValidatedWorkflowPackageV2> {
    const pkg = await json(`${staging.definitionPath}/package.json`);
    if (pkg.package?.name !== staging.candidate.name || pkg.package?.version !== staging.candidate.exactVersion) {
      throw new WorkflowPackageStoreError("WORKFLOW_VERSION_MISMATCH");
    }
    const checked = spawnSync(process.execPath, [CHECKER_V2, staging.definitionPath], {
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 1_048_576,
    });
    if (checked.status !== 0) {
      const diagnostic = `${checked.stderr}\n${checked.stdout}`;
      if (/digest mismatch|digest must|contentIdentity must|owned digest mismatch|Snapshot .*binding mismatch/iu.test(diagnostic)) {
        throw new WorkflowPackageStoreError("WORKFLOW_DIGEST_MISMATCH");
      }
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    const minimum = pkg.compatibility?.minContractVersion;
    const maximum = pkg.compatibility?.maxContractVersion;
    const fromMinimum = typeof minimum === "string" ? compareVersion(this.compatibility.contractVersion, minimum) : undefined;
    const toMaximum = typeof maximum === "string" ? compareVersion(this.compatibility.contractVersion, maximum) : undefined;
    const [snapshot, workflow, actionsDocument, rolesDocument, routesDocument] = await Promise.all([
      json(`${staging.definitionPath}/snapshot.json`),
      json(`${staging.definitionPath}/${String(pkg.documents?.workflow)}`),
      json(`${staging.definitionPath}/${String(pkg.documents?.actions)}`),
      json(`${staging.definitionPath}/${String(pkg.documents?.roles)}`),
      json(`${staging.definitionPath}/${String(pkg.documents?.routes)}`),
    ]);
    const providerCapabilities = new Set(this.compatibility.providerCapabilities);
    const hostCapabilities = new Set(this.compatibility.hostCapabilities);
    const compatibleRoutes = Array.isArray(routesDocument.routes) && routesDocument.routes.every((route: any) =>
      Array.isArray(route?.resources?.capabilities)
      && route.resources.capabilities.every((capability: unknown) => typeof capability === "string" && providerCapabilities.has(capability as ContractProviderCapability)));
    const compatibleHost = Array.isArray(workflow.hostOperations ?? [])
      && (workflow.hostOperations ?? []).every((operation: any) => Array.isArray(operation?.requiredCapabilities)
        && operation.requiredCapabilities.every((capability: unknown) => typeof capability === "string" && hostCapabilities.has(capability as ContractHostCapability)));
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(this.compatibility.providerIdentity)
      || fromMinimum === undefined || toMaximum === undefined || fromMinimum < 0 || toMaximum > 0
      || !compatibleRoutes || !compatibleHost || pkg.schemaVersion !== "agentops.workflow-dsl@2.0.0") {
      throw new WorkflowPackageStoreError("WORKFLOW_DSH_INCOMPATIBLE");
    }
    if (typeof pkg.package.digest !== "string" || typeof workflow.workflow?.id !== "string") {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    const extracted = extractWorkflowV2RoleSnapshot({
      packageDocument: pkg,
      snapshotDocument: snapshot,
      actionsDocument,
      rolesDocument,
      routesDocument,
    });
    return Object.freeze({
      name: pkg.package.name,
      exactVersion: pkg.package.version,
      packageDigest: pkg.package.digest,
      workflowId: workflow.workflow.id,
      ...extracted,
    });
  }
}
