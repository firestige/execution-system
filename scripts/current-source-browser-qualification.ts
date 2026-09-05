import { parseWorkflowSelector } from "../src/delivery/selector.js";

export type CurrentSourceBrowserQualification =
  | Readonly<{ scenario: "evidence-studio"; evidenceKind: "composition"; workflowSelector: string }>
  | Readonly<{ scenario: "diagnostic"; evidenceKind: "diagnostic-non-composition"; diagnosticSelector?: string }>;

function isExactSelector(selector: string): boolean {
  try { return parseWorkflowSelector(selector).version.kind === "EXACT"; }
  catch { return false; }
}

export function parseCurrentSourceBrowserQualificationArguments(args: readonly string[]): CurrentSourceBrowserQualification {
  if (args.length < 4 || args.length > 5) {
    throw new Error("usage: qualify-current-source-browser ORIGIN WORKSPACE EVIDENCE_ORIGIN evidence-studio EXACT_SELECTOR | ORIGIN WORKSPACE EVIDENCE_ORIGIN diagnostic");
  }
  const scenario = args[3];
  const workflowSelector = args[4];
  if (scenario === "diagnostic") {
    if (workflowSelector !== undefined && !isExactSelector(workflowSelector)) {
      throw new Error("CURRENT_SOURCE_DIAGNOSTIC_SELECTOR_INVALID");
    }
    return Object.freeze({
      scenario, evidenceKind: "diagnostic-non-composition",
      ...(workflowSelector === undefined ? {} : { diagnosticSelector: workflowSelector }),
    });
  }
  if (scenario !== "evidence-studio") throw new Error(`CURRENT_SOURCE_SCENARIO_INVALID:${String(scenario)}`);
  if (workflowSelector === undefined) throw new Error("CURRENT_SOURCE_EXACT_SELECTOR_REQUIRED");
  if (!isExactSelector(workflowSelector)) throw new Error("CURRENT_SOURCE_EXACT_SELECTOR_INVALID");
  return Object.freeze({ scenario, evidenceKind: "composition", workflowSelector });
}
