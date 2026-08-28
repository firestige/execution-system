import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { canonicalJsonBytes, coordinateIdentity, deepFreeze } from "./canonical.js";
import { ConfigurationError, type ConfigurationErrorCode } from "./errors.js";
import { parseExecutionConfigurationDocument } from "./loader.js";
import type { ExecutionInstallationConfig, WorkflowSourceConfiguration } from "./types.js";

export const EXECUTION_CONFIG_SCHEMA_VERSION_V2 = "execution.config@2.0.0" as const;
export const DELIVERY_CONFIG_PROJECTION_VERSION_V2 = "execution.delivery-config@2.0.0" as const;

const ROOT_KEYS = ["schemaVersion", "paths", "workflowSource", "runner", "observation", "controls", "intake"] as const;
const PATH_KEYS = ["repositoryRoot", "workspaceRoot", "allowedWorktreeRoots", "stateRoot"] as const;
const DERIVED_PATH_KEYS = ["packageStoreRoot", "intakeBindingStoreRoot", "manifestRoot", "currentSlotRoot", "stagingRoot", "runner"] as const;
const OBSERVATION_KEYS = ["enabled", "endpoint", "timeoutMs", "maxBatchRecords", "maxBatchBytes", "flushIntervalMs", "shutdownFlushMs", "serviceName"] as const;
const CONTROL_KEYS = ["startupTimeoutMs", "executionTimeoutMs", "shutdownTimeoutMs", "maxConcurrentDeliveries", "allowExplicitRefresh", "diagnosticMaxBytes"] as const;
const INTAKE_KEYS = ["maxCorrelationBytes", "maxOutputBytes"] as const;
const IDENTITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

type RecordValue = Record<string, unknown>;

export interface AgentProviderRealmFactoryCapability {
  readonly agentProviderIdentity: string;
}

export interface ExecutionInstallationConfigV2 {
  readonly schemaVersion: typeof EXECUTION_CONFIG_SCHEMA_VERSION_V2;
  readonly paths: Readonly<{
    repositoryRoot: string;
    workspaceRoot: string;
    allowedWorktreeRoots: readonly string[];
    stateRoot: string;
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
    implementationKey: "runner.v2";
    host: Readonly<{ engine: "langgraph" }>;
    provider: Readonly<{
      identity: string;
      defaultModel: Readonly<{ provider: string; model: string }>;
      maxParallelToolCalls: number;
    }>;
  }>;
  readonly observation: ExecutionInstallationConfig["observation"];
  readonly controls: ExecutionInstallationConfig["controls"];
  readonly intake: ExecutionInstallationConfig["intake"];
}

export interface LoadedExecutionInstallationConfigV2 {
  readonly config: ExecutionInstallationConfigV2;
  readonly installationConfigIdentity: string;
}

export interface DeliveryConfigProjectionV2 {
  readonly value: Readonly<{
    schemaVersion: typeof DELIVERY_CONFIG_PROJECTION_VERSION_V2;
    paths: Readonly<{
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
    runner: Readonly<{
      implementationKey: "runner.v2";
      host: Readonly<{ engine: "langgraph" }>;
      provider: Readonly<{ identity: string; maxParallelToolCalls: number }>;
    }>;
    controls: Readonly<{
      executionTimeoutMs: number;
      maxConcurrentDeliveries: number;
      allowExplicitRefresh: boolean;
    }>;
  }>;
  readonly identity: string;
}

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new ConfigurationError("CONFIG_TYPE_INVALID", [path]);
  }
  return value as RecordValue;
}

function exact(value: unknown, path: string, allowed: readonly string[]): RecordValue {
  const candidate = record(value, path);
  const unknown = Object.keys(candidate).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    const derived = path === "paths" && unknown.some((key) => DERIVED_PATH_KEYS.includes(key as typeof DERIVED_PATH_KEYS[number]));
    throw new ConfigurationError(derived ? "CONFIG_DERIVED_KEY_FORBIDDEN" : "CONFIG_UNKNOWN_KEY", unknown.map((key) => `${path}.${key}`));
  }
  return candidate;
}

function string(value: unknown, path: string, code: ConfigurationErrorCode = "CONFIG_REQUIRED_VALUE"): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1024) throw new ConfigurationError(code, [path]);
  return value;
}

function identity(value: unknown, path: string): string {
  const normalized = string(value, path, "CONFIG_PROVIDER_INVALID");
  if (!IDENTITY.test(normalized)) throw new ConfigurationError("CONFIG_PROVIDER_INVALID", [path]);
  return normalized;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ConfigurationError("CONFIG_RANGE_INVALID", [path]);
  }
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ConfigurationError("CONFIG_TYPE_INVALID", [path]);
  return value;
}

function absolutePath(value: unknown, path: string, code: ConfigurationErrorCode = "CONFIG_PATH_INVALID"): string {
  const raw = string(value, path, code);
  if (!isAbsolute(raw) || raw.includes("\0")) throw new ConfigurationError(code, [path]);
  return resolve(raw);
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function url(value: unknown, path: string, protocols: readonly string[]): string {
  const raw = string(value, path, "CONFIG_URL_INVALID");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ConfigurationError("CONFIG_URL_INVALID", [path]); }
  if (!protocols.includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "") {
    throw new ConfigurationError("CONFIG_URL_INVALID", [path]);
  }
  return parsed.toString().replace(/\/$/u, "");
}

function loopbackUrl(value: unknown, path: string): string {
  const normalized = url(value, path, ["http:", "https:"]);
  const hostname = new URL(normalized).hostname.toLowerCase();
  if (!(hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1")) {
    throw new ConfigurationError("CONFIG_OBSERVATION_ENDPOINT_INVALID", [path]);
  }
  return normalized;
}

function requiredMarkers(value: unknown, path = ""): string[] {
  if (typeof value === "string" && value.startsWith("__REQUIRED__:")) return [path];
  if (Array.isArray(value)) return value.flatMap((child, index) => requiredMarkers(child, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => requiredMarkers(child, path === "" ? key : `${path}.${key}`));
  }
  return [];
}

function normalizeSource(value: unknown): WorkflowSourceConfiguration {
  const source = exact(value, "workflowSource", ["kind", "repository", "releasesBaseUrl", "assetPattern", "adapterKey", "adapterConfigFile"]);
  if (source.kind === "github") {
    if (source.adapterKey !== undefined || source.adapterConfigFile !== undefined) throw new ConfigurationError("CONFIG_SOURCE_INVALID", ["workflowSource"]);
    const repository = string(source.repository, "workflowSource.repository", "CONFIG_SOURCE_INVALID");
    const assetPattern = string(source.assetPattern, "workflowSource.assetPattern", "CONFIG_SOURCE_INVALID");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
      || assetPattern !== "workflow-package-{name}-{version}.tar.gz") throw new ConfigurationError("CONFIG_SOURCE_INVALID", ["workflowSource"]);
    return { kind: "github", repository, releasesBaseUrl: url(source.releasesBaseUrl, "workflowSource.releasesBaseUrl", ["https:"]), assetPattern };
  }
  if (source.kind === "adapter") {
    if (source.repository !== undefined || source.releasesBaseUrl !== undefined || source.assetPattern !== undefined) {
      throw new ConfigurationError("CONFIG_SOURCE_INVALID", ["workflowSource"]);
    }
    return {
      kind: "adapter",
      adapterKey: string(source.adapterKey, "workflowSource.adapterKey", "CONFIG_SOURCE_ADAPTER_UNKNOWN"),
      adapterConfigFile: absolutePath(source.adapterConfigFile, "workflowSource.adapterConfigFile", "CONFIG_SOURCE_INVALID"),
    };
  }
  throw new ConfigurationError("CONFIG_SOURCE_INVALID", ["workflowSource.kind"]);
}

export function validateExecutionInstallationConfigV2(candidate: unknown, capability: AgentProviderRealmFactoryCapability): ExecutionInstallationConfigV2 {
  const placeholders = requiredMarkers(candidate);
  if (placeholders.length > 0) throw new ConfigurationError("CONFIG_REQUIRED_INPUT_MISSING", placeholders.slice(0, 16));
  const root = exact(candidate, "config", ROOT_KEYS);
  if (root.schemaVersion !== EXECUTION_CONFIG_SCHEMA_VERSION_V2) throw new ConfigurationError("CONFIG_SCHEMA_VERSION_UNSUPPORTED", ["schemaVersion"]);

  const paths = exact(root.paths, "paths", PATH_KEYS);
  const repositoryRoot = absolutePath(paths.repositoryRoot, "paths.repositoryRoot");
  const workspaceRoot = absolutePath(paths.workspaceRoot, "paths.workspaceRoot");
  const stateRoot = absolutePath(paths.stateRoot, "paths.stateRoot");
  if (!Array.isArray(paths.allowedWorktreeRoots) || paths.allowedWorktreeRoots.length === 0) {
    throw new ConfigurationError("CONFIG_PATH_OUT_OF_SCOPE", ["paths.allowedWorktreeRoots"]);
  }
  const allowedWorktreeRoots = paths.allowedWorktreeRoots.map((entry, index) => absolutePath(entry, `paths.allowedWorktreeRoots[${index}]`, "CONFIG_PATH_OUT_OF_SCOPE"));
  if (new Set(allowedWorktreeRoots).size !== allowedWorktreeRoots.length
    || allowedWorktreeRoots.some((entry) => !within(workspaceRoot, entry))
    || [repositoryRoot, workspaceRoot].some((entry) => within(entry, stateRoot) || within(stateRoot, entry))) {
    throw new ConfigurationError("CONFIG_PATH_OUT_OF_SCOPE", ["paths"]);
  }

  const runner = exact(root.runner, "runner", ["implementationKey", "host", "provider"]);
  const host = exact(runner.host, "runner.host", ["engine"]);
  const provider = exact(runner.provider, "runner.provider", ["identity", "defaultModel", "maxParallelToolCalls"]);
  const defaultModel = exact(provider.defaultModel, "runner.provider.defaultModel", ["provider", "model"]);
  if (runner.implementationKey !== "runner.v2" || host.engine !== "langgraph") throw new ConfigurationError("CONFIG_RUNNER_INVALID", ["runner"]);
  const providerIdentity = identity(provider.identity, "runner.provider.identity");
  if (!IDENTITY.test(capability.agentProviderIdentity) || providerIdentity !== capability.agentProviderIdentity) {
    throw new ConfigurationError("CONFIG_PROVIDER_INVALID", ["runner.provider.identity"]);
  }
  const modelProvider = identity(defaultModel.provider, "runner.provider.defaultModel.provider");
  const model = identity(defaultModel.model, "runner.provider.defaultModel.model");

  const observation = exact(root.observation, "observation", OBSERVATION_KEYS);
  const observationEnabled = boolean(observation.enabled, "observation.enabled");
  if ((!observationEnabled && observation.endpoint !== undefined) || (observationEnabled && observation.endpoint === undefined)) {
    throw new ConfigurationError("CONFIG_OBSERVATION_INVALID", ["observation.endpoint"]);
  }
  const controls = exact(root.controls, "controls", CONTROL_KEYS);
  const intake = exact(root.intake, "intake", INTAKE_KEYS);
  const runnerRoot = resolve(stateRoot, "runner");
  return deepFreeze({
    schemaVersion: EXECUTION_CONFIG_SCHEMA_VERSION_V2,
    paths: {
      repositoryRoot,
      workspaceRoot,
      allowedWorktreeRoots,
      stateRoot,
      packageStoreRoot: resolve(stateRoot, "packages"),
      intakeBindingStoreRoot: resolve(stateRoot, "intake-bindings"),
      manifestRoot: resolve(stateRoot, "manifests"),
      currentSlotRoot: resolve(stateRoot, "current-slots"),
      stagingRoot: resolve(stateRoot, "staging"),
      runner: {
        root: runnerRoot,
        journalRoot: resolve(runnerRoot, "journal"),
        checkpointRoot: resolve(runnerRoot, "checkpoints"),
        sessionRoot: resolve(runnerRoot, "sessions"),
        custodyRoot: resolve(runnerRoot, "custody"),
      },
    },
    workflowSource: normalizeSource(root.workflowSource),
    runner: {
      implementationKey: "runner.v2",
      host: { engine: "langgraph" },
      provider: {
        identity: providerIdentity,
        defaultModel: { provider: modelProvider, model },
        maxParallelToolCalls: integer(provider.maxParallelToolCalls, "runner.provider.maxParallelToolCalls", 1, 32),
      },
    },
    observation: {
      enabled: observationEnabled,
      ...(observationEnabled ? { endpoint: loopbackUrl(observation.endpoint, "observation.endpoint") } : {}),
      timeoutMs: integer(observation.timeoutMs, "observation.timeoutMs", 100, 10_000),
      maxBatchRecords: integer(observation.maxBatchRecords, "observation.maxBatchRecords", 1, 512),
      maxBatchBytes: integer(observation.maxBatchBytes, "observation.maxBatchBytes", 1024, 4_194_304),
      flushIntervalMs: integer(observation.flushIntervalMs, "observation.flushIntervalMs", 100, 10_000),
      shutdownFlushMs: integer(observation.shutdownFlushMs, "observation.shutdownFlushMs", 100, 10_000),
      serviceName: string(observation.serviceName, "observation.serviceName", "CONFIG_OBSERVATION_INVALID"),
    },
    controls: {
      startupTimeoutMs: integer(controls.startupTimeoutMs, "controls.startupTimeoutMs", 1000, 120_000),
      executionTimeoutMs: integer(controls.executionTimeoutMs, "controls.executionTimeoutMs", 1000, 86_400_000),
      shutdownTimeoutMs: integer(controls.shutdownTimeoutMs, "controls.shutdownTimeoutMs", 1000, 120_000),
      maxConcurrentDeliveries: integer(controls.maxConcurrentDeliveries, "controls.maxConcurrentDeliveries", 1, 32),
      allowExplicitRefresh: boolean(controls.allowExplicitRefresh, "controls.allowExplicitRefresh"),
      diagnosticMaxBytes: integer(controls.diagnosticMaxBytes, "controls.diagnosticMaxBytes", 256, 16_384),
    },
    intake: {
      maxCorrelationBytes: integer(intake.maxCorrelationBytes, "intake.maxCorrelationBytes", 16, 1024),
      maxOutputBytes: integer(intake.maxOutputBytes, "intake.maxOutputBytes", 256, 65_536),
    },
  });
}

async function preflight(config: ExecutionInstallationConfigV2): Promise<ExecutionInstallationConfigV2> {
  try {
    const [repositoryRoot, workspaceRoot, stateRoot, ...allowedWorktreeRoots] = await Promise.all([
      realpath(config.paths.repositoryRoot),
      realpath(config.paths.workspaceRoot),
      realpath(config.paths.stateRoot),
      ...config.paths.allowedWorktreeRoots.map((path) => realpath(path)),
    ]);
    if (allowedWorktreeRoots.some((entry) => !within(workspaceRoot, entry))
      || [repositoryRoot, workspaceRoot].some((entry) => within(entry, stateRoot) || within(stateRoot, entry))) {
      throw new ConfigurationError("CONFIG_PATH_OUT_OF_SCOPE", ["paths"]);
    }
    const entries = await Promise.all([repositoryRoot, workspaceRoot, stateRoot, ...allowedWorktreeRoots].map((path) => stat(path)));
    if (entries.some((entry) => !entry.isDirectory())) throw new ConfigurationError("CONFIG_PATH_INVALID", ["paths"]);
    await Promise.all([
      access(repositoryRoot, constants.R_OK),
      access(workspaceRoot, constants.R_OK),
      access(stateRoot, constants.R_OK | constants.W_OK),
      ...allowedWorktreeRoots.map((path) => access(path, constants.R_OK)),
      ...(config.workflowSource.kind === "adapter" ? [access(config.workflowSource.adapterConfigFile, constants.R_OK)] : []),
    ]);
    const workflowSource = config.workflowSource.kind === "adapter"
      ? { ...config.workflowSource, adapterConfigFile: await realpath(config.workflowSource.adapterConfigFile) }
      : config.workflowSource;
    const runnerRoot = resolve(stateRoot, "runner");
    return deepFreeze({
      ...config,
      paths: {
        repositoryRoot,
        workspaceRoot,
        allowedWorktreeRoots,
        stateRoot,
        packageStoreRoot: resolve(stateRoot, "packages"),
        intakeBindingStoreRoot: resolve(stateRoot, "intake-bindings"),
        manifestRoot: resolve(stateRoot, "manifests"),
        currentSlotRoot: resolve(stateRoot, "current-slots"),
        stagingRoot: resolve(stateRoot, "staging"),
        runner: {
          root: runnerRoot,
          journalRoot: resolve(runnerRoot, "journal"),
          checkpointRoot: resolve(runnerRoot, "checkpoints"),
          sessionRoot: resolve(runnerRoot, "sessions"),
          custodyRoot: resolve(runnerRoot, "custody"),
        },
      },
      workflowSource,
    });
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError("CONFIG_PATH_INVALID", ["paths"]);
  }
}

export async function loadExecutionInstallationConfigV2(configFile: string, capability: AgentProviderRealmFactoryCapability): Promise<LoadedExecutionInstallationConfigV2> {
  if (!isAbsolute(configFile)) throw new ConfigurationError("CONFIG_PATH_INVALID", ["configFile"]);
  let text: string;
  try { text = await readFile(configFile, "utf8"); }
  catch { throw new ConfigurationError("CONFIG_PATH_INVALID", ["configFile"]); }
  const config = await preflight(validateExecutionInstallationConfigV2(parseExecutionConfigurationDocument(configFile, text), capability));
  const canonical = JSON.parse(Buffer.from(canonicalJsonBytes(config as unknown as never)).toString("utf8")) as never;
  return deepFreeze({ config, installationConfigIdentity: coordinateIdentity(EXECUTION_CONFIG_SCHEMA_VERSION_V2, canonical) });
}

export function createDeliveryConfigProjectionV2(config: ExecutionInstallationConfigV2): DeliveryConfigProjectionV2 {
  const value = deepFreeze({
    schemaVersion: DELIVERY_CONFIG_PROJECTION_VERSION_V2,
    paths: {
      repositoryRoot: config.paths.repositoryRoot,
      workspaceRoot: config.paths.workspaceRoot,
      allowedWorktreeRoots: [...config.paths.allowedWorktreeRoots],
      runnerResources: {
        journal: "runner/journal" as const,
        checkpoints: "runner/checkpoints" as const,
        sessions: "runner/sessions" as const,
        custody: "runner/custody" as const,
      },
    },
    runner: {
      implementationKey: config.runner.implementationKey,
      host: config.runner.host,
      provider: {
        identity: config.runner.provider.identity,
        maxParallelToolCalls: config.runner.provider.maxParallelToolCalls,
      },
    },
    controls: {
      executionTimeoutMs: config.controls.executionTimeoutMs,
      maxConcurrentDeliveries: config.controls.maxConcurrentDeliveries,
      allowExplicitRefresh: config.controls.allowExplicitRefresh,
    },
  });
  return deepFreeze({ value, identity: coordinateIdentity(DELIVERY_CONFIG_PROJECTION_VERSION_V2, value as never) });
}
