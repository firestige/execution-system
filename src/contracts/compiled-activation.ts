import type { ActionId, AgentExecutorId, CanonicalExecutionSiteKey, ControlId, DecisionId, ExecutionSiteRef, HostOperationId, NodeId, Sha256, TerminalId } from "./primitives.js";
import type { AdmittedActionTemplate, AdmittedControlNode, AdmittedDecision, AdmittedEventSuccessors, AdmittedInitialData, AdmittedTerminal, DeliveryCorrelation, ResolvedAgentExecutor, ResolvedControlBinding, ResolvedDataEdge, ResolvedExecutionSite, ResolvedHostOperation, Target } from "./runner-activation.js";

export interface CompiledInvocationPlan { readonly actionIdentity: ActionId; readonly executorIdentity: AgentExecutorId; readonly bindingIdentity: Sha256 }
export interface CompiledControlGraph { readonly entryNode: NodeId; readonly nodes: Readonly<Record<NodeId, AdmittedControlNode>>; readonly ordinarySuccessor: Readonly<Record<NodeId, Target>>; readonly eventSuccessor: Readonly<Record<NodeId, AdmittedEventSuccessors>>; readonly decisions: Readonly<Record<DecisionId, AdmittedDecision>>; readonly controls: Readonly<Record<ControlId, ResolvedControlBinding>>; readonly terminals: Readonly<Record<TerminalId, AdmittedTerminal>> }
export interface CompiledExecutorCatalog { readonly actions: Readonly<Record<ActionId, AdmittedActionTemplate>>; readonly sites: Readonly<Record<CanonicalExecutionSiteKey, ResolvedExecutionSite>>; readonly agents: Readonly<Record<AgentExecutorId, ResolvedAgentExecutor>>; readonly agentInvocations: Readonly<Partial<Record<CanonicalExecutionSiteKey, CompiledInvocationPlan>>>; readonly hostOperations: Readonly<Record<HostOperationId, ResolvedHostOperation>> }
export interface CompiledDataEdge extends ResolvedDataEdge { readonly identity: Sha256 }
export type ProducerKey = CanonicalExecutionSiteKey | `control:${ControlId}`;
export interface CompiledDataflowPlan { readonly incomingBySite: Readonly<Record<CanonicalExecutionSiteKey, readonly CompiledDataEdge[]>>; readonly incomingByControl: Readonly<Record<ControlId, readonly CompiledDataEdge[]>>; readonly outgoingByProducer: Readonly<Record<ProducerKey, readonly CompiledDataEdge[]>> }
export interface LangGraphExecutionPlan { readonly control: CompiledControlGraph; readonly execution: CompiledExecutorCatalog; readonly dataflow: CompiledDataflowPlan }
export interface CompiledGraphActivation { readonly schemaVersion: "runner.compiled-activation@1.0.0"; readonly compileIdentity: Sha256; readonly activationBindingIdentity: Sha256; readonly correlation: DeliveryCorrelation; readonly plan: LangGraphExecutionPlan; readonly initial: AdmittedInitialData }
export function executionSiteKey(site: ExecutionSiteRef): CanonicalExecutionSiteKey {
  if (site.kind === "node") return `node:${site.nodeIdentity}`;
  if (site.kind === "parallel-join") return `parallel-join:${site.nodeIdentity}`;
  return `parallel-branch:${site.nodeIdentity}:${site.branchIdentity}`;
}
