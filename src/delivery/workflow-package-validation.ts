import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ContractHostCapability, ContractProviderCapability } from "../contracts/generated/workflow-contract.js";
import type { ValidatedWorkflowPackage, WorkflowPackageStaging } from "./workflow-package-store.js";
import { WorkflowPackageStoreError } from "./workflow-package-store.js";

export interface WorkflowPackageCompatibilityTarget {
  readonly contractVersion: "1.1.0";
  readonly providerKey: "dsh";
  readonly providerCapabilities: readonly ContractProviderCapability[];
  readonly hostCapabilities: readonly ContractHostCapability[];
}

const CHECKER = fileURLToPath(new URL("../../config/workflow-dsl/tools/check-example.cjs", import.meta.url));

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

export class FrozenWorkflowPackageValidator {
  constructor(readonly compatibility: WorkflowPackageCompatibilityTarget) {}

  async validate(staging: WorkflowPackageStaging): Promise<ValidatedWorkflowPackage> {
    const pkg = await json(`${staging.definitionPath}/package.json`);
    if (pkg.package?.name !== staging.candidate.name || pkg.package?.version !== staging.candidate.exactVersion) {
      throw new WorkflowPackageStoreError("WORKFLOW_VERSION_MISMATCH");
    }
    const checked = spawnSync(process.execPath, [CHECKER, staging.definitionPath], {
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
    const routes = await json(`${staging.definitionPath}/${String(pkg.documents?.routes)}`);
    const workflow = await json(`${staging.definitionPath}/${String(pkg.documents?.workflow)}`);
    const providerCapabilities = new Set(this.compatibility.providerCapabilities);
    const hostCapabilities = new Set(this.compatibility.hostCapabilities);
    const compatibleRoutes = Array.isArray(routes.routes) && routes.routes.every((route: any) =>
      Array.isArray(route?.resources?.capabilities)
      && route.resources.capabilities.every((capability: unknown) => typeof capability === "string" && providerCapabilities.has(capability as ContractProviderCapability)));
    const compatibleHost = Array.isArray(workflow.hostOperations ?? [])
      && (workflow.hostOperations ?? []).every((operation: any) => Array.isArray(operation?.requiredCapabilities)
        && operation.requiredCapabilities.every((capability: unknown) => typeof capability === "string" && hostCapabilities.has(capability as ContractHostCapability)));
    if (this.compatibility.providerKey !== "dsh" || fromMinimum === undefined || toMaximum === undefined
      || fromMinimum < 0 || toMaximum > 0 || !compatibleRoutes || !compatibleHost) {
      throw new WorkflowPackageStoreError("WORKFLOW_DSH_INCOMPATIBLE");
    }
    if (typeof pkg.package.digest !== "string" || typeof workflow.workflow?.id !== "string") {
      throw new WorkflowPackageStoreError("WORKFLOW_PACKAGE_INVALID");
    }
    return Object.freeze({
      name: pkg.package.name,
      exactVersion: pkg.package.version,
      packageDigest: pkg.package.digest,
      workflowId: workflow.workflow.id,
    });
  }
}
