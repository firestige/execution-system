import { createHash } from "node:crypto";

import type { RunnerActivationContext } from "./runner-activation.js";
import type { CompiledGraphActivation } from "./compiled-activation.js";

export type CompileError =
  | Readonly<{ code: "ACTIVATION_INVALID" | "BINDING_MISMATCH" | "CONTROL_CLOSURE_INVALID" | "EXECUTION_CLOSURE_INVALID" | "SESSION_BINDING_INVALID" | "DATAFLOW_CLOSURE_INVALID" | "UNSUPPORTED_CAPABILITY" | "COMPILE_IDENTITY_MISMATCH"; detail: RunnerActivationContext["initial"]["state"]["values"] }>;
type CompileResult<T, E> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>;
export type CompileRunnerActivation = (activation: RunnerActivationContext) => CompileResult<CompiledGraphActivation, CompileError>;

export type ActivationContractErrorCode = "INVALID_ACTIVATION" | "NOT_DEEPLY_FROZEN" | "BINDING_MISMATCH" | "FORBIDDEN_FIELD" | "NATIVE_IDENTITY_LEAK" | "SECRET_LEAK";
export class ActivationContractError extends Error {
  override readonly name = "ActivationContractError";
  constructor(readonly code: ActivationContractErrorCode, message: string) { super(message); }
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
export function canonicalDigest(value: unknown): RunnerActivationContext["bindingIdentity"] { return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`; }
export function activationBindingDigest(activation: RunnerActivationContext): RunnerActivationContext["bindingIdentity"] {
  const { bindingIdentity: _excluded, ...boundContent } = activation;
  return canonicalDigest(boundContent);
}
function isDeeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every(child => isDeeplyFrozen(child, seen));
}
const FORBIDDEN = new Set(["documents", "schemas", "definitionDocuments", "definitionSchemas", "workflowSelector", "packageStore", "deliveryAdmission"]);
const NATIVE = new Set(["threadId", "checkpointId", "sessionId", "processId"]);
const SECRET = new Set(["secret", "credential", "credentials", "apiKey", "token"]);
function inspectFields(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) throw new ActivationContractError("FORBIDDEN_FIELD", `forbidden activation field '${key}'`);
    if (NATIVE.has(key)) throw new ActivationContractError("NATIVE_IDENTITY_LEAK", `runtime-native identity '${key}' cannot cross admission`);
    if (SECRET.has(key)) throw new ActivationContractError("SECRET_LEAK", `secret-bearing field '${key}' cannot cross admission`);
    inspectFields(child, seen);
  }
}
function isSha256(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function validateProgram(activation: RunnerActivationContext): void {
  const { control, execution, dataflow } = activation.program;
  const sites = new Set(execution.sites.map(site => canonicalJson(site.site)));
  const controls = new Set(control.controls.map(controlBinding => controlBinding.identity as string));
  for (const site of execution.sites) {
    if (!(site.actionIdentity in execution.actions)) throw new ActivationContractError("INVALID_ACTIVATION", `site has unresolved Action '${site.actionIdentity}'`);
    if (site.executor.kind === "agent") {
      const executor = execution.agents[site.executor.identity];
      if (executor === undefined) throw new ActivationContractError("INVALID_ACTIVATION", `site has unresolved executor '${site.executor.identity}'`);
      const provided = new Set(executor.session.providedCapabilities);
      if (site.executor.requiredCapabilities.some(capability => !provided.has(capability))) throw new ActivationContractError("INVALID_ACTIVATION", `executor capability mismatch at '${canonicalJson(site.site)}'`);
    } else if (!(site.executor.identity in execution.hostOperations)) {
      throw new ActivationContractError("INVALID_ACTIVATION", `site has unresolved Host operation '${site.executor.identity}'`);
    }
  }
  const sinks = new Set<string>();
  for (const edge of dataflow.edges) {
    const sink = canonicalJson(edge.target);
    if (sinks.has(sink)) throw new ActivationContractError("INVALID_ACTIVATION", `duplicate data sink '${sink}'`);
    sinks.add(sink);
    if ((edge.source.kind === "site-result" && !sites.has(canonicalJson(edge.source.site))) || (edge.source.kind === "control-result" && !controls.has(edge.source.controlIdentity as string))) {
      throw new ActivationContractError("INVALID_ACTIVATION", "data edge has unresolved source");
    }
    if ((edge.target.kind === "site-input" && !sites.has(canonicalJson(edge.target.site))) || (edge.target.kind === "control-input" && !controls.has(edge.target.controlIdentity as string))) {
      throw new ActivationContractError("INVALID_ACTIVATION", "data edge has unresolved target");
    }
  }
}
export function validateRunnerActivation(input: unknown): RunnerActivationContext {
  inspectFields(input);
  if (!isDeeplyFrozen(input)) throw new ActivationContractError("NOT_DEEPLY_FROZEN", "Runner activation must be deeply frozen");
  if (input === null || typeof input !== "object") throw new ActivationContractError("INVALID_ACTIVATION", "Runner activation must be an object");
  const activation = input as Partial<RunnerActivationContext>;
  const admissionPair = activation.admission?.contractRevision === "agentops.workflow-dsl@2.0.0"
    && activation.admission.deliveryAdmissionContractIdentity === "agentops.delivery-admission@2.0.0";
  if (activation.schemaVersion !== "runner.activation@1.0.0" || !admissionPair || !isSha256(activation.bindingIdentity) || activation.program === undefined || activation.initial === undefined || activation.correlation === undefined) {
    throw new ActivationContractError("INVALID_ACTIVATION", "Runner activation does not match the admitted contract identity/shape");
  }
  if (activationBindingDigest(activation as RunnerActivationContext) !== activation.bindingIdentity) throw new ActivationContractError("BINDING_MISMATCH", "Runner activation binding identity is stale or mismatched");
  validateProgram(activation as RunnerActivationContext);
  return input as RunnerActivationContext;
}
export function validateSelectedBranches(selected: readonly string[], declared: readonly string[]): readonly string[] {
  if (selected.length === 0) throw new ActivationContractError("INVALID_ACTIVATION", "parallel selection must be non-empty");
  if (new Set(selected).size !== selected.length) throw new ActivationContractError("INVALID_ACTIVATION", "parallel selection contains duplicate branch identity");
  const unknown = selected.find(branch => !new Set(declared).has(branch));
  if (unknown !== undefined) throw new ActivationContractError("INVALID_ACTIVATION", `parallel selection contains unknown branch '${unknown}'`);
  return selected;
}
export function assertFrozenJsonValue(value: unknown): void {
  if (!isDeeplyFrozen(value)) throw new ActivationContractError("NOT_DEEPLY_FROZEN", "JSON value must be deeply frozen");
}
