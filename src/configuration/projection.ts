import { deepFreeze, coordinateIdentity } from "./canonical.js";
import {
  DELIVERY_CONFIG_PROJECTION_VERSION,
  type DeliveryConfigProjection,
  type DeliveryConfigProjectionValue,
  type ExecutionInstallationConfig,
  type RunnerConfigurationProjection,
} from "./types.js";

export function createDeliveryConfigProjection(config: ExecutionInstallationConfig): DeliveryConfigProjection {
  const value = deepFreeze<DeliveryConfigProjectionValue>({
    schemaVersion: DELIVERY_CONFIG_PROJECTION_VERSION,
    paths: {
      repositoryRoot: config.paths.repositoryRoot,
      workspaceRoot: config.paths.workspaceRoot,
      allowedWorktreeRoots: [...config.paths.allowedWorktreeRoots],
      runnerResources: {
        journal: "runner/journal",
        checkpoints: "runner/checkpoints",
        sessions: "runner/sessions",
        custody: "runner/custody",
      },
    },
    runner: config.runner,
    controls: {
      executionTimeoutMs: config.controls.executionTimeoutMs,
      maxConcurrentDeliveries: config.controls.maxConcurrentDeliveries,
      allowExplicitRefresh: config.controls.allowExplicitRefresh,
    },
  });
  return deepFreeze({
    value,
    identity: coordinateIdentity(DELIVERY_CONFIG_PROJECTION_VERSION, value),
  });
}

export function createRunnerConfigurationProjection(config: ExecutionInstallationConfig): RunnerConfigurationProjection {
  return deepFreeze({
    factory: {
      schemaVersion: "runner.factory@1.0.0",
      stateDirectory: config.paths.runner.root,
      custody: { recordsRoot: config.paths.runner.custodyRoot },
      provider: {
        key: "dsh-headless",
        configuration: {
          providerIdentity: "dsh-headless",
          sessionStorageRoot: config.paths.runner.sessionRoot,
          credentialStore: { path: config.paths.credentialStorePath, watch: false },
          maxParallelToolCalls: config.runner.provider.maxParallelToolCalls,
        },
      },
      invocation: { journalDirectory: config.paths.runner.journalRoot },
      host: { engine: config.runner.host.engine, checkpointDirectory: config.paths.runner.checkpointRoot },
      implementationIdentity: config.runner.implementationKey,
    },
    admittedDriver: {
      providerRoute: config.runner.provider.route,
      modelId: config.runner.provider.modelId,
      baseUrl: config.runner.provider.baseUrl,
      credentialRef: config.runner.provider.credentialRef,
    },
  });
}
