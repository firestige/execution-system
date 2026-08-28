export type ObservationScalar = string | number | boolean;

const rows = [
  ["C01", "agentops.delivery.id", "string"], ["C02", "agentops.task.id", "string"],
  ["C03", "agentops.workflow.id", "string"], ["C04", "agentops.workflow.version", "string"],
  ["C05", "agentops.implementation.id", "string"], ["C06", "agentops.runtime.id", "string"],
  ["C07", "agentops.manifest.digest", "string"], ["C08", "agentops.workflow.family", "string"],
  ["C09", "agentops.event.id", "string"], ["C10", "agentops.delivery.outcome", "string"],
  ["C11", "agentops.summary.state", "string"], ["C12", "agentops.review.id", "string"],
  ["C13", "agentops.review.lens", "string"], ["C14", "agentops.review.scope", "string"],
  ["C15", "agentops.review.severity", "string"], ["C16", "agentops.review.total", "integer"],
  ["C17", "agentops.review.observed.count", "integer"], ["C18", "agentops.finding.id", "string"],
  ["C19", "agentops.finding.status", "string"], ["C20", "agentops.source.review.id", "string"],
  ["C21", "agentops.fix.id", "string"], ["C22", "agentops.fix.finding.id", "string"],
  ["C23", "agentops.recheck.id", "string"], ["C24", "agentops.recheck.review.id", "string"],
  ["C25", "agentops.recheck.finding.id", "string"], ["C26", "agentops.recheck.fix.id", "string"],
  ["C27", "agentops.iteration.id", "string"], ["C28", "agentops.artifact.id", "string"],
  ["C29", "agentops.artifact.digest", "string"], ["C30", "agentops.role.id", "string"],
  ["C31", "agentops.role.lineage.id", "string"], ["C32", "agentops.parent.role.id", "string"],
  ["C33", "agentops.writer.role.id", "string"], ["C34", "agentops.reviewer.role.id", "string"],
  ["C35", "agentops.recheck.role.id", "string"], ["C36", "agentops.writer.invocation.id", "string"],
  ["C37", "agentops.reviewer.invocation.id", "string"], ["C38", "agentops.recheck.invocation.id", "string"],
  ["C39", "agentops.intervention.kind", "string"], ["C40", "agentops.observed.loop.count", "integer"],
  ["C41", "agentops.observed.intervention.count", "integer"], ["C42", "agentops.usage.kind", "string"],
  ["C43", "agentops.usage.unit", "string"], ["C44", "agentops.usage.source", "string"],
  ["C45", "agentops.usage.source.id", "string"], ["C46", "agentops.usage.value", "integer"],
  ["C47", "agentops.sampling.decision", "string"], ["C48", "agentops.sampling.probability", "number"],
  ["C49", "agentops.family.schema", "string"], ["C50", "agentops.finding.summary", "string"],
  ["C51", "agentops.finding.scope.id", "string"], ["C52", "agentops.finding.target.kind", "string"],
  ["C53", "agentops.finding.target.id", "string"], ["C54", "agentops.finding.target.artifact.id", "string"],
  ["C55", "agentops.delivery.elapsed_time_ms", "number"], ["C56", "agentops.delivery.stage.reached", "string"],
  ["C57", "agentops.model.id", "string"],
  ["I01", "agentops.test.passed", "integer"], ["I02", "agentops.test.failed", "integer"],
  ["I03", "agentops.test.skipped", "integer"], ["I04", "agentops.test.duration.seconds", "number"],
  ["I05", "agentops.coverage.dimension", "string"], ["I06", "agentops.coverage.covered", "integer"],
  ["I07", "agentops.coverage.total", "integer"], ["I08", "agentops.coverage.scope", "string"],
  ["I09", "agentops.coverage.tool.id", "string"], ["I10", "agentops.coverage.format", "string"],
  ["S01", "agentops.fresh_reader.result", "string"], ["S02", "agentops.fresh_reader.finding.count", "integer"],
  ["S03", "agentops.verification.id", "string"], ["S04", "agentops.verification.result", "string"],
  ["S05", "agentops.verification.check.passed", "integer"], ["S06", "agentops.verification.check.failed", "integer"],
  ["C58", "agentops.task.display_name", "string"],
  ["C59", "agentops.delivery.manifest_projection", "string"],
  ["C60", "agentops.delivery.manifest_projection_digest", "string"],
] as const;

export type ObservationFieldId = typeof rows[number][0];
export type ObservationEventName = typeof EVENT_NAMES[number];
export type ObservationFamilySchema = "implementation@1" | "system-design@1";

const PUBLISHED_EVENT_NAMES = Object.freeze([
  "delivery.summary", "review.finding", "review.summary", "test.summary", "implementation.summary",
  "system_design.summary", "role.lineage", "intervention", "usage", "sampling.decision",
] as const);

export const EVENT_NAMES = Object.freeze([...PUBLISHED_EVENT_NAMES, "task.binding"] as const);

const allFields = Object.freeze(Object.fromEntries(rows.map(([id, name, type]) => [id, Object.freeze({ name, type })]))) as Readonly<Record<ObservationFieldId, Readonly<{ name: string; type: "string" | "integer" | "number" }>>>;

type ScalarSource = "M01" | "M02" | "DSH" | "M03" | "FACT_OWNER";
function scalarSource(id: ObservationFieldId): ScalarSource {
  if (["C01","C02","C05","C07","C58","C59","C60"].includes(id)) return "M01";
  if (["C06","C10","C42","C43","C44","C45","C46","C55","C57"].includes(id)) return "M02";
  if (["C47","C48"].includes(id)) return "M03";
  if (["C09","C11"].includes(id)) return "FACT_OWNER";
  return "DSH";
}

function sourceRows(selected: readonly typeof rows[number][]) {
  return Object.freeze(Object.fromEntries(selected.map(([id, name, type]) => [id, Object.freeze({ name, type, source: scalarSource(id) })])));
}

export const OBSERVATION_PROFILE_SOURCE_MATRIX = Object.freeze({
  profileVersion: "1.0.0",
  eventNames: PUBLISHED_EVENT_NAMES,
  fields: Object.freeze({
    common: sourceRows(rows.slice(0, 57)),
    implementation: sourceRows(rows.slice(57, 67)),
    systemDesign: sourceRows(rows.slice(67, 73)),
  }),
});

export const PROFILE_FIELDS = allFields;

export const EVENT_RULES: Readonly<Record<ObservationEventName, Readonly<{ allowed: readonly ObservationFieldId[]; required: readonly ObservationFieldId[] }>>> = Object.freeze({
  "task.binding": { allowed: ["C01","C02","C07","C09","C58","C59","C60"], required: ["C01","C02","C07","C09","C59","C60"] },
  "delivery.summary": { allowed: ["C08","C09","C10","C11","C30","C49","C55","C56"], required: ["C08","C09","C10","C11","C49"] },
  "review.finding": { allowed: ["C08","C09","C12","C13","C14","C15","C18","C19","C20","C21","C22","C23","C24","C25","C26","C27","C28","C29","C33","C34","C35","C36","C37","C38","C49","C50","C51","C52","C53","C54"], required: ["C08","C09","C12","C13","C14","C15","C18","C19","C20","C28","C29","C33","C34","C36","C37","C49","C50","C51","C52","C53"] },
  "review.summary": { allowed: ["C08","C09","C11","C12","C13","C14","C16","C17","C23","C24","C25","C26","C27","C28","C29","C33","C34","C35","C36","C37","C38","C49","S01","S02"], required: ["C08","C09","C11","C12","C13","C14","C28","C29","C33","C34","C36","C37","C49"] },
  "test.summary": { allowed: ["C08","C09","C11","C28","C29","C30","C49","I01","I02","I03","I04"], required: ["C08","C09","C11","C28","C29","C49","I01","I02","I03"] },
  "implementation.summary": { allowed: ["C08","C09","C11","C28","C29","C30","C40","C41","C49","I05","I06","I07","I08","I09","I10"], required: ["C08","C09","C11","C28","C29","C49","I05","I06","I07","I08","I09","I10"] },
  "system_design.summary": { allowed: ["C08","C09","C11","C28","C29","C30","C40","C41","C49","S03","S04","S05","S06"], required: ["C08","C09","C11","C28","C29","C49","S03","S04","S05","S06"] },
  "role.lineage": { allowed: ["C08","C09","C30","C31","C32","C49"], required: ["C08","C09","C30","C31","C49"] },
  intervention: { allowed: ["C08","C09","C30","C39","C49"], required: ["C08","C09","C39","C49"] },
  usage: { allowed: ["C08","C09","C11","C30","C42","C43","C44","C45","C46","C49"], required: ["C08","C09","C11","C42","C43","C44","C45","C46","C49"] },
  "sampling.decision": { allowed: ["C09","C47","C48"], required: ["C09","C47","C48"] },
});

export const PROFILE_ENUMS: Readonly<Record<string, readonly ObservationScalar[]>> = Object.freeze({
  C08: ["implementation", "system-design"], C10: ["COMPLETED", "INCOMPLETE", "FAILED", "CANCELLED", "START_FAILED"],
  C11: ["FINAL", "LOWER_BOUND", "NOT_APPLICABLE", "UNAVAILABLE"],
  C13: ["GOAL_BLACKBOX", "IMPLEMENTATION_WHITEBOX", "ARCHITECTURE", "PROBLEM_SOLUTION", "QUALITY_ACCEPTANCE", "FRESH_READER"],
  C15: ["BLOCKING", "MAJOR", "MINOR"], C19: ["OPEN", "CLOSED_FIXED", "CLOSED_NOT_VALID", "ACCEPTED_MINOR"],
  C39: ["USER_REDIRECT"], C42: ["native_credit", "request", "premium_request", "provider_native", "money"],
  C44: ["runtime", "provider"], C47: ["RECORD_AND_SAMPLE", "DROP"], C49: ["implementation@1", "system-design@1"],
  C52: ["ARTIFACT", "SECTION", "COMPONENT", "REQUIREMENT"], I05: ["line", "branch", "function"],
  S01: ["PASS", "FINDINGS_REPORTED"], S04: ["PASS", "FAIL", "INCONCLUSIVE", "KNOWN_RED_NO_DELTA"],
});
