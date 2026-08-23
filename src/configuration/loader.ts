import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { isAlias, isMap, isNode, isPair, isScalar, isSeq, parseDocument } from "yaml";

import { canonicalConfigurationBytes, coordinateIdentity, deepFreeze } from "./canonical.js";
import { ConfigurationError, type ConfigurationErrorCode } from "./errors.js";
import {
  EXECUTION_CONFIG_SCHEMA_VERSION,
  type ExecutionInstallationConfig,
  type LoadedExecutionInstallationConfig,
  type WorkflowSourceConfiguration,
} from "./types.js";

type RecordValue = Record<string, unknown>;

const ROOT_KEYS = ["schemaVersion", "paths", "workflowSource", "runner", "observation", "controls", "intake"] as const;
const PATH_KEYS = ["repositoryRoot", "workspaceRoot", "allowedWorktreeRoots", "stateRoot", "credentialStorePath"] as const;
const DERIVED_PATH_KEYS = ["packageStoreRoot", "intakeBindingStoreRoot", "manifestRoot", "currentSlotRoot", "stagingRoot", "runner"] as const;
const RUNNER_KEYS = ["implementationKey", "host", "provider"] as const;
const HOST_KEYS = ["engine"] as const;
const PROVIDER_KEYS = ["key", "route", "modelId", "baseUrl", "credentialRef", "maxParallelToolCalls"] as const;
const OBSERVATION_KEYS = ["enabled", "endpoint", "timeoutMs", "maxBatchRecords", "maxBatchBytes", "flushIntervalMs", "shutdownFlushMs", "serviceName"] as const;
const CONTROL_KEYS = ["startupTimeoutMs", "executionTimeoutMs", "shutdownTimeoutMs", "maxConcurrentDeliveries", "allowExplicitRefresh", "diagnosticMaxBytes"] as const;
const INTAKE_KEYS = ["maxCorrelationBytes", "maxOutputBytes"] as const;

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
  try { parsed = new URL(raw); } catch (cause) { throw new ConfigurationError("CONFIG_URL_INVALID", [path], { cause }); }
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

function assertJsonDataNode(node: unknown): void {
  if (!isNode(node)) return;
  if (isAlias(node) || node.anchor !== undefined || (node.tag !== undefined && !node.tag.startsWith("tag:yaml.org,2002:"))) {
    throw new ConfigurationError("CONFIG_YAML_UNSAFE");
  }
  if (isMap(node)) {
    for (const item of node.items) {
      if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== "string") throw new ConfigurationError("CONFIG_YAML_UNSAFE");
      if (item.key.value === "<<") throw new ConfigurationError("CONFIG_YAML_UNSAFE");
      assertJsonDataNode(item.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) assertJsonDataNode(item);
  } else if (isScalar(node)) {
    const value = node.value;
    const source = (node as typeof node & { readonly source?: unknown }).source;
    if (typeof source === "string" && /^\d{4}-\d{2}-\d{2}(?:[Tt ]|$)/u.test(source)) {
      throw new ConfigurationError("CONFIG_YAML_UNSAFE");
    }
    if (!(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
      throw new ConfigurationError("CONFIG_YAML_UNSAFE");
    }
  }
}

function duplicateCode(errors: readonly { readonly code?: string; readonly message: string }[]): ConfigurationError {
  return errors.some((error) => error.code === "DUPLICATE_KEY" || /unique keys|duplicate key/iu.test(error.message))
    ? new ConfigurationError("CONFIG_DUPLICATE_KEY")
    : new ConfigurationError("CONFIG_PARSE_FAILED");
}

function parseJson(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch (cause) { throw new ConfigurationError("CONFIG_PARSE_FAILED", [], { cause }); }
  const diagnostic = parseDocument(text, { schema: "json", uniqueKeys: true });
  if (diagnostic.errors.length > 0) throw duplicateCode(diagnostic.errors);
  return value;
}

function parseYaml(text: string): unknown {
  if (/^\s*[\[{]/u.test(text)) throw new ConfigurationError("CONFIG_PARSE_FAILED");
  if (/(^|[\s,{[])(&|\*)[^\s,}\]]+/mu.test(text) || /(^|\s)![^\s]+/mu.test(text)) {
    throw new ConfigurationError("CONFIG_YAML_UNSAFE");
  }
  const document = parseDocument(text, { schema: "core", uniqueKeys: true, merge: false });
  if (document.errors.length > 0) {
    const duplicate = duplicateCode(document.errors);
    if (duplicate.code === "CONFIG_DUPLICATE_KEY") throw duplicate;
    throw new ConfigurationError("CONFIG_YAML_UNSAFE");
  }
  assertJsonDataNode(document.contents);
  return document.toJS({ maxAliasCount: 0 });
}

export function parseExecutionConfigurationDocument(path: string, text: string): unknown {
  const extension = path.toLowerCase().match(/\.[^.]+$/u)?.[0];
  if (extension === ".json") return parseJson(text);
  if (extension === ".yaml" || extension === ".yml") return parseYaml(text);
  throw new ConfigurationError("CONFIG_EXTENSION_UNSUPPORTED");
}

function normalize(candidate: unknown): ExecutionInstallationConfig {
  const placeholders = requiredMarkers(candidate);
  if (placeholders.length > 0) throw new ConfigurationError("CONFIG_REQUIRED_INPUT_MISSING", placeholders.slice(0, 16));

  const root = exact(candidate, "config", ROOT_KEYS);
  if (root.schemaVersion !== EXECUTION_CONFIG_SCHEMA_VERSION) throw new ConfigurationError("CONFIG_SCHEMA_VERSION_UNSUPPORTED", ["schemaVersion"]);

  const paths = exact(root.paths, "paths", PATH_KEYS);
  const repositoryRoot = absolutePath(paths.repositoryRoot, "paths.repositoryRoot");
  const workspaceRoot = absolutePath(paths.workspaceRoot, "paths.workspaceRoot");
  const stateRoot = absolutePath(paths.stateRoot, "paths.stateRoot");
  const credentialStorePath = absolutePath(paths.credentialStorePath, "paths.credentialStorePath");
  if (!Array.isArray(paths.allowedWorktreeRoots) || paths.allowedWorktreeRoots.length === 0) {
    throw new ConfigurationError("CONFIG_PATH_OUT_OF_SCOPE", ["paths.allowedWorktreeRoots"]);
  }
  const allowedWorktreeRoots = paths.allowedWorktreeRoots.map((entry, index) => absolutePath(entry, `paths.allowedWorktreeRoots[${index}]`, "CONFIG_PATH_OUT_OF_SCOPE"));
  if (new Set(allowedWorktreeRoots).size !== allowedWorktreeRoots.length
    || allowedWorktreeRoots.some((entry) => !within(workspaceRoot, entry))) {
    throw new ConfigurationError("CONFIG_PATH_OUT_OF_SCOPE", ["paths.allowedWorktreeRoots"]);
  }
  if ([repositoryRoot, workspaceRoot].some((entry) => within(entry, stateRoot) || within(stateRoot, entry))) {
    throw new ConfigurationError("CONFIG_PATH_OUT_OF_SCOPE", ["paths.stateRoot"]);
  }

  const source = exact(root.workflowSource, "workflowSource", ["kind", "repository", "releasesBaseUrl", "assetPattern", "adapterKey", "adapterConfigFile"]);
  let workflowSource: WorkflowSourceConfiguration;
  if (source.kind === "github") {
    const forbidden = ["adapterKey", "adapterConfigFile"].filter((key) => source[key] !== undefined);
    if (forbidden.length > 0) throw new ConfigurationError("CONFIG_SOURCE_INVALID", forbidden.map((key) => `workflowSource.${key}`));
    const repository = string(source.repository, "workflowSource.repository", "CONFIG_SOURCE_INVALID");
    const assetPattern = string(source.assetPattern, "workflowSource.assetPattern", "CONFIG_SOURCE_INVALID");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
      || assetPattern !== "workflow-package-{name}-{version}.tar.gz") throw new ConfigurationError("CONFIG_SOURCE_INVALID", ["workflowSource"]);
    workflowSource = {
      kind: "github",
      repository,
      releasesBaseUrl: url(source.releasesBaseUrl, "workflowSource.releasesBaseUrl", ["https:"]),
      assetPattern,
    };
  } else if (source.kind === "adapter") {
    const forbidden = ["repository", "releasesBaseUrl", "assetPattern"].filter((key) => source[key] !== undefined);
    if (forbidden.length > 0) throw new ConfigurationError("CONFIG_SOURCE_INVALID", forbidden.map((key) => `workflowSource.${key}`));
    workflowSource = {
      kind: "adapter",
      adapterKey: string(source.adapterKey, "workflowSource.adapterKey", "CONFIG_SOURCE_ADAPTER_UNKNOWN"),
      adapterConfigFile: absolutePath(source.adapterConfigFile, "workflowSource.adapterConfigFile", "CONFIG_SOURCE_INVALID"),
    };
  } else throw new ConfigurationError("CONFIG_SOURCE_INVALID", ["workflowSource.kind"]);

  const runner = exact(root.runner, "runner", RUNNER_KEYS);
  const host = exact(runner.host, "runner.host", HOST_KEYS);
  const provider = exact(runner.provider, "runner.provider", PROVIDER_KEYS);
  if (runner.implementationKey !== "runner.v1" || host.engine !== "langgraph") throw new ConfigurationError("CONFIG_RUNNER_INVALID", ["runner"]);
  if (provider.key !== "dsh") throw new ConfigurationError("CONFIG_PROVIDER_INVALID", ["runner.provider.key"]);

  const observation = exact(root.observation, "observation", OBSERVATION_KEYS);
  const observationEnabled = boolean(observation.enabled, "observation.enabled");
  if ((!observationEnabled && observation.endpoint !== undefined) || (observationEnabled && observation.endpoint === undefined)) {
    throw new ConfigurationError("CONFIG_OBSERVATION_INVALID", ["observation.endpoint"]);
  }
  const controls = exact(root.controls, "controls", CONTROL_KEYS);
  const intake = exact(root.intake, "intake", INTAKE_KEYS);
  const runnerRoot = resolve(stateRoot, "runner");

  return deepFreeze({
    schemaVersion: EXECUTION_CONFIG_SCHEMA_VERSION,
    paths: {
      repositoryRoot,
      workspaceRoot,
      allowedWorktreeRoots,
      stateRoot,
      credentialStorePath,
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
    runner: {
      implementationKey: "runner.v1",
      host: { engine: "langgraph" },
      provider: {
        key: "dsh",
        route: string(provider.route, "runner.provider.route"),
        modelId: string(provider.modelId, "runner.provider.modelId"),
        baseUrl: url(provider.baseUrl, "runner.provider.baseUrl", ["http:", "https:"]),
        credentialRef: string(provider.credentialRef, "runner.provider.credentialRef"),
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

async function preflight(config: ExecutionInstallationConfig): Promise<ExecutionInstallationConfig> {
  try {
    const [repositoryRoot, workspaceRoot, stateRoot, credentialStorePath, ...canonicalAllowedRoots] = await Promise.all([
      realpath(config.paths.repositoryRoot),
      realpath(config.paths.workspaceRoot),
      realpath(config.paths.stateRoot),
      realpath(config.paths.credentialStorePath),
      ...config.paths.allowedWorktreeRoots.map((path) => realpath(path)),
    ]);
    if (canonicalAllowedRoots.some((entry) => !within(workspaceRoot, entry))
      || [repositoryRoot, workspaceRoot].some((entry) => within(entry, stateRoot) || within(stateRoot, entry))) {
      throw new ConfigurationError("CONFIG_PATH_OUT_OF_SCOPE", ["paths"]);
    }
    const [repository, workspace, stateDirectory, credentials, ...allowedRoots] = await Promise.all([
      stat(repositoryRoot),
      stat(workspaceRoot),
      stat(stateRoot),
      stat(credentialStorePath),
      ...canonicalAllowedRoots.map((path) => stat(path)),
    ]);
    if (!repository.isDirectory() || !workspace.isDirectory() || !stateDirectory.isDirectory() || !credentials.isFile()
      || allowedRoots.some((entry) => !entry.isDirectory())) {
      throw new ConfigurationError("CONFIG_PATH_INVALID", ["paths"]);
    }
    await Promise.all([
      access(repositoryRoot, constants.R_OK),
      access(workspaceRoot, constants.R_OK),
      access(stateRoot, constants.R_OK | constants.W_OK),
      access(credentialStorePath, constants.R_OK),
      ...canonicalAllowedRoots.map((path) => access(path, constants.R_OK)),
      ...(config.workflowSource.kind === "adapter"
        ? [access(config.workflowSource.adapterConfigFile, constants.R_OK)]
        : []),
    ]);
    const runnerRoot = resolve(stateRoot, "runner");
    const workflowSource = config.workflowSource.kind === "adapter"
      ? { ...config.workflowSource, adapterConfigFile: await realpath(config.workflowSource.adapterConfigFile) }
      : config.workflowSource;
    return deepFreeze({
      ...config,
      paths: {
        repositoryRoot,
        workspaceRoot,
        allowedWorktreeRoots: canonicalAllowedRoots,
        stateRoot,
        credentialStorePath,
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
    throw new ConfigurationError("CONFIG_PATH_INVALID", ["paths"], { cause });
  }
}

export async function loadExecutionInstallationConfig(configFile: string): Promise<LoadedExecutionInstallationConfig> {
  if (!isAbsolute(configFile)) throw new ConfigurationError("CONFIG_PATH_INVALID", ["configFile"]);
  let text: string;
  try { text = await readFile(configFile, "utf8"); } catch (cause) { throw new ConfigurationError("CONFIG_PATH_INVALID", ["configFile"], { cause }); }
  const config = await preflight(normalize(parseExecutionConfigurationDocument(configFile, text)));
  return deepFreeze({
    config,
    installationConfigIdentity: coordinateIdentity(EXECUTION_CONFIG_SCHEMA_VERSION, JSON.parse(Buffer.from(canonicalConfigurationBytes(config)).toString("utf8"))),
  });
}

export function validateExecutionInstallationConfig(candidate: unknown): ExecutionInstallationConfig {
  return normalize(candidate);
}
