import { canonicalDigest, executionSiteKey, validateRunnerActivation } from "../contracts/index.js";
import type {
  AdmittedControlNode, CompileError, CompileRunnerActivation, CompiledControlGraph,
  CompiledDataEdge, CompiledDataflowPlan, CompiledExecutorCatalog, CompiledGraphActivation,
  CompiledInvocationPlan, ContractEventSuccessors, LangGraphExecutionPlan, ProducerKey,
  RunnerActivationContext, Sha256, SourcePortRef, TargetPortRef,
} from "../contracts/index.js";

class CompileIssue extends Error {
  constructor(readonly code: CompileError["code"], message: string) { super(message); }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function failure(code: CompileError["code"], message: string): ReturnType<CompileRunnerActivation> {
  return deepFreeze({ ok: false, error: { code, detail: { message } } });
}

function sortedRecord<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueIndex<T>(entries: readonly T[], identityOf: (entry: T) => string, code: CompileError["code"], label: string): Readonly<Record<string, T>> {
  const indexed: Array<readonly [string, T]> = [];
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = identityOf(entry);
    if (identities.has(identity)) throw new CompileIssue(code, `duplicate ${label} '${identity}'`);
    identities.add(identity);
    indexed.push([identity, entry]);
  }
  return sortedRecord(indexed);
}

function assertKnownTarget(target: string, targets: ReadonlySet<string>): void {
  if (!targets.has(target)) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `unresolved control target '${target}'`);
}

function compileControl(activation: RunnerActivationContext): CompiledControlGraph {
  const admitted = activation.program.control;
  const nodes = uniqueIndex(admitted.nodes, (node) => node.id, "CONTROL_CLOSURE_INVALID", "control node") as CompiledControlGraph["nodes"];
  const terminals = uniqueIndex(admitted.terminals, (terminal) => terminal.id, "CONTROL_CLOSURE_INVALID", "terminal") as CompiledControlGraph["terminals"];
  if (nodes[admitted.entryNode] === undefined) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `entry node '${admitted.entryNode}' is unresolved`);
  const targets = new Set([...Object.keys(nodes), ...Object.keys(terminals)]);

  const ordinaryEntries: Array<readonly [string, string]> = [];
  const ordinarySources = new Set<string>();
  for (const transition of admitted.ordinarySuccessor) {
    if (nodes[transition.from] === undefined) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `ordinary transition source '${transition.from}' is unresolved`);
    if (ordinarySources.has(transition.from)) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `duplicate ordinary successor for '${transition.from}'`);
    ordinarySources.add(transition.from);
    assertKnownTarget(transition.to, targets);
    ordinaryEntries.push([transition.from, transition.to]);
  }

  const eventByNode = new Map<string, Record<string, string>>();
  for (const transition of admitted.eventSuccessor) {
    if (nodes[transition.from] === undefined) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `event transition source '${transition.from}' is unresolved`);
    assertKnownTarget(transition.to, targets);
    const successors = eventByNode.get(transition.from) ?? {};
    if (successors[transition.event] !== undefined) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `duplicate '${transition.event}' successor for '${transition.from}'`);
    successors[transition.event] = transition.to;
    eventByNode.set(transition.from, successors);
  }

  const decisions = uniqueIndex(admitted.decisions, (decision) => decision.identity, "CONTROL_CLOSURE_INVALID", "decision") as CompiledControlGraph["decisions"];
  const controls = uniqueIndex(admitted.controls, (control) => control.identity, "CONTROL_CLOSURE_INVALID", "control binding") as CompiledControlGraph["controls"];
  for (const decision of admitted.decisions) {
    if (!("selector" in decision)) continue;
    const allowedTargets = decision.selector.kind === "case-map" ? decision.selector.cases.map((entry) => entry.target) : decision.selector.allowedTargets;
    if (allowedTargets.length === 0) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `decision '${decision.identity}' has no declared target`);
    for (const target of allowedTargets) assertKnownTarget(target, targets);
    if (decision.selector.kind === "host-operation" && activation.program.execution.hostOperations[decision.selector.operationIdentity] === undefined) {
      throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `decision '${decision.identity}' has unresolved Host operation`);
    }
  }
  for (const control of admitted.controls) {
    const node = nodes[control.nodeIdentity];
    if (node === undefined || !new Set(["wait", "wait-renewal", "recovery"]).has(node.kind)) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `control '${control.identity}' has unresolved control node`);
    const resume = decisions[control.resumeDecision];
    if (resume === undefined || !("selector" in resume)) throw new CompileIssue("CONTROL_CLOSURE_INVALID", `control '${control.identity}' has unresolved resume decision`);
  }

  return {
    entryNode: admitted.entryNode, nodes,
    ordinarySuccessor: sortedRecord(ordinaryEntries) as CompiledControlGraph["ordinarySuccessor"],
    eventSuccessor: sortedRecord([...eventByNode].map(([node, successors]) => [node, sortedRecord(Object.entries(successors)) as ContractEventSuccessors])) as CompiledControlGraph["eventSuccessor"],
    decisions, controls, terminals,
  };
}

function expectedAction(node: AdmittedControlNode, siteKind: "node" | "parallel-join", branchIdentity?: string): string | undefined {
  if (siteKind === "parallel-join") {
    if (node.kind !== "parallel" || node.join === null || typeof node.join !== "object") return undefined;
    const join = node.join as { readonly action?: unknown };
    return typeof join.action === "string" ? join.action : undefined;
  }
  if (branchIdentity !== undefined) return node.kind === "parallel" ? node.branches.find((branch) => branch.id === branchIdentity)?.action : undefined;
  return node.kind === "action" || node.kind === "cleanup" || (node.kind === "recovery" && node.action !== undefined) ? node.action : undefined;
}

function compileExecution(activation: RunnerActivationContext, control: CompiledControlGraph): CompiledExecutorCatalog {
  const admitted = activation.program.execution;
  for (const [identity, action] of Object.entries(admitted.actions)) if (action.identity !== identity) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `Action key mismatch at '${identity}'`);
  for (const [identity, executor] of Object.entries(admitted.agents)) {
    if (executor.identity !== identity) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `executor key mismatch at '${identity}'`);
    if (canonicalDigest(executor.session) !== executor.sessionCompatibilityIdentity) throw new CompileIssue("SESSION_BINDING_INVALID", `session compatibility identity mismatch for '${identity}'`);
    if (canonicalDigest({ session: executor.session, turn: executor.turn }) !== executor.bindingIdentity) throw new CompileIssue("SESSION_BINDING_INVALID", `executor binding identity mismatch for '${identity}'`);
  }
  for (const [identity, operation] of Object.entries(admitted.hostOperations)) if (operation.identity !== identity) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `Host operation key mismatch at '${identity}'`);

  const sites = uniqueIndex(admitted.sites, (site) => executionSiteKey(site.site), "EXECUTION_CLOSURE_INVALID", "execution site") as CompiledExecutorCatalog["sites"];
  const agentInvocations: Array<readonly [string, CompiledInvocationPlan]> = [];
  for (const site of admitted.sites) {
    const key = executionSiteKey(site.site);
    const node = control.nodes[site.site.nodeIdentity];
    if (node === undefined) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `site '${key}' has unresolved node`);
    const expected = site.site.kind === "parallel-branch" ? expectedAction(node, "node", site.site.branchIdentity) : expectedAction(node, site.site.kind);
    if (expected === undefined || expected !== site.actionIdentity) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `site '${key}' does not match its declared Action position`);
    if (admitted.actions[site.actionIdentity] === undefined) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `site '${key}' has unresolved Action`);
    if (site.executor.kind === "agent") {
      const executor = admitted.agents[site.executor.identity];
      if (executor === undefined) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `site '${key}' has unresolved executor`);
      if (!site.executor.requiredCapabilities.includes("structured-completion")) throw new CompileIssue("UNSUPPORTED_CAPABILITY", `site '${key}' does not require structured completion`);
      if (site.executor.requiredCapabilities.some((capability) => !executor.session.providedCapabilities.includes(capability))) throw new CompileIssue("UNSUPPORTED_CAPABILITY", `site '${key}' requires an unsupported Provider capability`);
      agentInvocations.push([key, {
        actionIdentity: site.actionIdentity, executorIdentity: executor.identity,
        bindingIdentity: canonicalDigest({ site: site.site, action: admitted.actions[site.actionIdentity], executorBindingIdentity: executor.bindingIdentity }),
      }]);
    } else if (admitted.hostOperations[site.executor.identity] === undefined) {
      throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `site '${key}' has unresolved Host operation`);
    }
  }

  for (const node of Object.values(control.nodes)) {
    if (node.kind === "action" || node.kind === "cleanup" || (node.kind === "recovery" && node.action !== undefined)) {
      const key = executionSiteKey({ kind: "node", nodeIdentity: node.id });
      if (sites[key] === undefined) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `declared Action position '${key}' has no site`);
    }
    if (node.kind === "parallel") {
      for (const branch of node.branches) {
        const key = executionSiteKey({ kind: "parallel-branch", nodeIdentity: node.id, branchIdentity: branch.id });
        if (sites[key] === undefined) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `declared branch '${key}' has no site`);
      }
      if (expectedAction(node, "parallel-join") !== undefined) {
        const key = executionSiteKey({ kind: "parallel-join", nodeIdentity: node.id });
        if (sites[key] === undefined) throw new CompileIssue("EXECUTION_CLOSURE_INVALID", `declared join '${key}' has no site`);
      }
    }
  }
  return {
    actions: sortedRecord(Object.entries(admitted.actions)) as CompiledExecutorCatalog["actions"], sites,
    agents: sortedRecord(Object.entries(admitted.agents)) as CompiledExecutorCatalog["agents"],
    agentInvocations: sortedRecord(agentInvocations) as CompiledExecutorCatalog["agentInvocations"],
    hostOperations: sortedRecord(Object.entries(admitted.hostOperations)) as CompiledExecutorCatalog["hostOperations"],
  };
}

function assertSourceClosure(source: SourcePortRef, execution: CompiledExecutorCatalog, control: CompiledControlGraph): void {
  if (source.kind === "site-result" && execution.sites[executionSiteKey(source.site)] === undefined) throw new CompileIssue("DATAFLOW_CLOSURE_INVALID", `source site '${executionSiteKey(source.site)}' is unresolved`);
  if (source.kind === "control-result" && control.controls[source.controlIdentity] === undefined) throw new CompileIssue("DATAFLOW_CLOSURE_INVALID", `source control '${source.controlIdentity}' is unresolved`);
}

function assertTargetClosure(target: TargetPortRef, execution: CompiledExecutorCatalog, control: CompiledControlGraph): void {
  if (target.kind === "site-input" && execution.sites[executionSiteKey(target.site)] === undefined) throw new CompileIssue("DATAFLOW_CLOSURE_INVALID", `target site '${executionSiteKey(target.site)}' is unresolved`);
  if (target.kind === "control-input" && control.controls[target.controlIdentity] === undefined) throw new CompileIssue("DATAFLOW_CLOSURE_INVALID", `target control '${target.controlIdentity}' is unresolved`);
}

function producerKey(source: SourcePortRef): ProducerKey | undefined {
  if (source.kind === "site-result") return executionSiteKey(source.site);
  if (source.kind === "control-result") return `control:${source.controlIdentity}`;
  return undefined;
}

function compileDataflow(activation: RunnerActivationContext, execution: CompiledExecutorCatalog, control: CompiledControlGraph): CompiledDataflowPlan {
  for (const decision of activation.program.control.decisions) assertSourceClosure(decision.source, execution, control);
  for (const node of activation.program.control.nodes) if (node.kind === "parallel" && node.selection !== undefined) assertSourceClosure(node.selection.source, execution, control);
  for (const executor of Object.values(activation.program.execution.agents)) if (executor.session.policy.scope.kind === "data-bound") assertSourceClosure(executor.session.policy.scope.source, execution, control);
  const incomingBySite = new Map<string, CompiledDataEdge[]>();
  const incomingByControl = new Map<string, CompiledDataEdge[]>();
  const outgoingByProducer = new Map<string, CompiledDataEdge[]>();
  const sinks = new Set<string>();
  for (const edge of activation.program.dataflow.edges) {
    assertSourceClosure(edge.source, execution, control);
    assertTargetClosure(edge.target, execution, control);
    const sink = canonicalDigest(edge.target);
    if (sinks.has(sink)) throw new CompileIssue("DATAFLOW_CLOSURE_INVALID", `duplicate dataflow sink '${sink}'`);
    sinks.add(sink);
    const compiled: CompiledDataEdge = { ...edge, identity: canonicalDigest(edge) };
    if (edge.target.kind === "site-input") {
      const key = executionSiteKey(edge.target.site);
      incomingBySite.set(key, [...(incomingBySite.get(key) ?? []), compiled]);
    } else if (edge.target.kind === "control-input") {
      incomingByControl.set(edge.target.controlIdentity, [...(incomingByControl.get(edge.target.controlIdentity) ?? []), compiled]);
    }
    const producer = producerKey(edge.source);
    if (producer !== undefined) outgoingByProducer.set(producer, [...(outgoingByProducer.get(producer) ?? []), compiled]);
  }
  const sortEdges = (edges: readonly CompiledDataEdge[]): readonly CompiledDataEdge[] => [...edges].sort((left, right) => left.identity.localeCompare(right.identity));
  return {
    incomingBySite: sortedRecord([...incomingBySite].map(([key, edges]) => [key, sortEdges(edges)])) as CompiledDataflowPlan["incomingBySite"],
    incomingByControl: sortedRecord([...incomingByControl].map(([key, edges]) => [key, sortEdges(edges)])) as CompiledDataflowPlan["incomingByControl"],
    outgoingByProducer: sortedRecord([...outgoingByProducer].map(([key, edges]) => [key, sortEdges(edges)])) as CompiledDataflowPlan["outgoingByProducer"],
  };
}

function compile(activation: RunnerActivationContext): CompiledGraphActivation {
  const control = compileControl(activation);
  const execution = compileExecution(activation, control);
  const dataflow = compileDataflow(activation, execution, control);
  validateRunnerActivation(activation);
  const plan: LangGraphExecutionPlan = { control, execution, dataflow };
  const content: Omit<CompiledGraphActivation, "compileIdentity"> = {
    schemaVersion: "runner.compiled-activation@1.0.0", activationBindingIdentity: activation.bindingIdentity,
    correlation: activation.correlation, plan, initial: activation.initial,
  };
  return { ...content, compileIdentity: canonicalDigest(content) as Sha256 };
}

export const compileRunnerActivation: CompileRunnerActivation = (activation) => {
  try { return deepFreeze({ ok: true, value: compile(activation) }); }
  catch (error) {
    if (error instanceof CompileIssue) return failure(error.code, error.message);
    const contractError = error as { readonly code?: string; readonly message?: string };
    return failure(contractError.code === "BINDING_MISMATCH" ? "BINDING_MISMATCH" : "ACTIVATION_INVALID", contractError.message ?? "activation validation failed");
  }
};
