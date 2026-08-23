import type { CoordinatorHost, FrozenJsonValue, HostCustody, HostInvocation } from "../contracts/index.js";

export type WorkflowHostEngine = "langgraph";

export interface HostOperationExecution {
  readonly accepted: boolean;
  readonly value: FrozenJsonValue;
}

export interface HostOperationHandler {
  execute(input: FrozenJsonValue, configuration: Readonly<Record<string, FrozenJsonValue>>): Promise<HostOperationExecution>;
}

export interface WorkflowHostAdapterDependencies {
  readonly invocation: HostInvocation;
  readonly custody: HostCustody;
  readonly hostOperations?: Readonly<Record<string, HostOperationHandler>>;
}

export interface WorkflowHostAdapterFactory<Engine extends WorkflowHostEngine, Configuration> {
  readonly engine: Engine;
  create(configuration: Configuration, dependencies: WorkflowHostAdapterDependencies): Promise<CoordinatorHost>;
}

export class WorkflowHostFactorySelectionError extends Error {
  readonly code = "WORKFLOW_HOST_FACTORY_SELECTION_MISMATCH";

  constructor(readonly engine: string) {
    super(`configured Workflow Host factory does not own '${engine}'`);
    this.name = "WorkflowHostFactorySelectionError";
  }
}

export class WorkflowHostConfigurationError extends TypeError {
  readonly code = "WORKFLOW_HOST_CONFIGURATION_INVALID";

  constructor(message = "Workflow Host configuration is not exact and immutable") {
    super(message);
    this.name = "WorkflowHostConfigurationError";
  }
}

export class WorkflowHostAdapterStartupError extends Error {
  readonly code = "WORKFLOW_HOST_ADAPTER_STARTUP_FAILED";

  constructor(readonly engine: WorkflowHostEngine, cause: unknown) {
    super(`Workflow Host adapter '${engine}' failed during startup`, { cause });
    this.name = "WorkflowHostAdapterStartupError";
  }
}
