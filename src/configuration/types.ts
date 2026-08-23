export const EXECUTION_CONFIG_SCHEMA_VERSION = "execution.config@1.0.0" as const;
export const DELIVERY_CONFIG_PROJECTION_VERSION = "execution.delivery-config@1.0.0" as const;

export interface ExecutionInputPaths {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly allowedWorktreeRoots: readonly string[];
  readonly stateRoot: string;
  readonly credentialStorePath: string;
}

export type WorkflowSourceConfiguration =
  | Readonly<{
    kind: "github";
    repository: string;
    releasesBaseUrl: string;
    assetPattern: string;
  }>
  | Readonly<{
    kind: "adapter";
    adapterKey: string;
    adapterConfigFile: string;
  }>;

export interface ExecutionInstallationConfig {
  readonly schemaVersion: typeof EXECUTION_CONFIG_SCHEMA_VERSION;
  readonly paths: Readonly<ExecutionInputPaths & {
    packageStoreRoot: string;
    intakeBindingStoreRoot: string;
    manifestRoot: string;
    currentSlotRoot: string;
    stagingRoot: string;
    runner: Readonly<{
      root: string;
      journalRoot: string;
      checkpointRoot: string;
      sessionRoot: string;
      custodyRoot: string;
    }>;
  }>;
  readonly workflowSource: WorkflowSourceConfiguration;
  readonly runner: Readonly<{
    implementationKey: "runner.v1";
    host: Readonly<{ engine: "langgraph" }>;
    provider: Readonly<{
      key: "dsh";
      route: string;
      modelId: string;
      baseUrl: string;
      credentialRef: string;
      maxParallelToolCalls: number;
    }>;
  }>;
  readonly observation: Readonly<{
    enabled: boolean;
    endpoint?: string;
    timeoutMs: number;
    maxBatchRecords: number;
    maxBatchBytes: number;
    flushIntervalMs: number;
    shutdownFlushMs: number;
    serviceName: string;
  }>;
  readonly controls: Readonly<{
    startupTimeoutMs: number;
    executionTimeoutMs: number;
    shutdownTimeoutMs: number;
    maxConcurrentDeliveries: number;
    allowExplicitRefresh: boolean;
    diagnosticMaxBytes: number;
  }>;
  readonly intake: Readonly<{
    maxCorrelationBytes: number;
    maxOutputBytes: number;
  }>;
}

export type ExecutionInstallationConfigInput = Readonly<{
  schemaVersion: typeof EXECUTION_CONFIG_SCHEMA_VERSION;
  paths: Readonly<ExecutionInputPaths>;
  workflowSource: WorkflowSourceConfiguration;
  runner: ExecutionInstallationConfig["runner"];
  observation: ExecutionInstallationConfig["observation"];
  controls: ExecutionInstallationConfig["controls"];
  intake: ExecutionInstallationConfig["intake"];
}>;

export interface LoadedExecutionInstallationConfig {
  readonly config: ExecutionInstallationConfig;
  readonly installationConfigIdentity: string;
}

export interface DeliveryConfigProjectionValue {
  readonly schemaVersion: typeof DELIVERY_CONFIG_PROJECTION_VERSION;
  readonly paths: Readonly<{
    repositoryRoot: string;
    workspaceRoot: string;
    allowedWorktreeRoots: readonly string[];
    runnerResources: Readonly<{
      journal: "runner/journal";
      checkpoints: "runner/checkpoints";
      sessions: "runner/sessions";
      custody: "runner/custody";
    }>;
  }>;
  readonly runner: ExecutionInstallationConfig["runner"];
  readonly controls: Readonly<{
    executionTimeoutMs: number;
    maxConcurrentDeliveries: number;
    allowExplicitRefresh: boolean;
  }>;
}

export interface DeliveryConfigProjection {
  readonly value: DeliveryConfigProjectionValue;
  readonly identity: string;
}

/**
 * Config-only inputs split along the frozen Runner factory and admitted Driver/model seams.
 * A persisted binding later adds the exact worktree, per-Delivery session directory, custody
 * publication target and ref required to form the complete RunnerFactoryConfig.
 */
export interface RunnerConfigurationProjection {
  readonly factory: Readonly<{
    schemaVersion: "runner.factory@1.0.0";
    stateDirectory: string;
    custody: Readonly<{ recordsRoot: string }>;
    provider: Readonly<{
      key: "dsh-headless";
      configuration: Readonly<{
        providerIdentity: "dsh-headless";
        sessionStorageRoot: string;
        credentialStore: Readonly<{ path: string; watch: false }>;
        maxParallelToolCalls: number;
      }>;
    }>;
    invocation: Readonly<{ journalDirectory: string }>;
    host: Readonly<{ engine: "langgraph"; checkpointDirectory: string }>;
    implementationIdentity: "runner.v1";
  }>;
  readonly admittedDriver: Readonly<{
    providerRoute: string;
    modelId: string;
    baseUrl: string;
    credentialRef: string;
  }>;
}
