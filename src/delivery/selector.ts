import type { WorkflowPackageSourceRequest } from "../bootstrap/index.js";

export class WorkflowSelectorError extends Error {
  readonly code = "INVALID_WORKFLOW_SELECTOR";
  constructor() {
    super("INVALID_WORKFLOW_SELECTOR");
    this.name = "WorkflowSelectorError";
  }
}

const NAME = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseWorkflowSelector(selector: string): WorkflowPackageSourceRequest {
  if (typeof selector !== "string" || selector.length === 0 || selector.length > 256) throw new WorkflowSelectorError();
  const separator = selector.indexOf("@");
  if (separator !== selector.lastIndexOf("@")) throw new WorkflowSelectorError();
  const name = separator < 0 ? selector : selector.slice(0, separator);
  const requested = separator < 0 ? "latest" : selector.slice(separator + 1);
  if (!NAME.test(name)) throw new WorkflowSelectorError();
  if (requested === "latest") return Object.freeze({ name, version: Object.freeze({ kind: "LATEST" as const }) });
  if (!VERSION.test(requested)) throw new WorkflowSelectorError();
  return Object.freeze({ name, version: Object.freeze({ kind: "EXACT" as const, value: requested }) });
}

export function isExactWorkflowVersion(version: string): boolean { return VERSION.test(version); }
