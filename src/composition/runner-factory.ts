import { isAbsolute } from "node:path";

import { canonicalDigest } from "../contracts/index.js";
import type {
  AbsolutePath,
  ActionInteractionBridge,
  FrozenJsonSchema,
  FrozenJsonValue,
  HostCustody,
  HostInvocation,
  ImplementationId,
  PublicationTargetRef,
  WorkflowControlBridge,
} from "../contracts/index.js";
import { createGitCustody } from "../custody/git-custody.js";
import type { ExecutionRuntimeAdapter } from "../execution/runtime-adapter.js";
import { LangGraphWorkflowHostAdapterFactory } from "../host/langgraph-host-adapter-factory.js";
import type { HostOperationHandler } from "../host/workflow-host-adapter-factory.js";
import { FileInvocationJournalStore } from "../invocation/journal.js";
import { createManagedInvocation, type InvocationResultValidator } from "../invocation/managed-invocation.js";
import { DshProviderAdapterFactory, type DshProviderAdapterConfiguration } from "../providers/dsh/index.js";
import type { ProviderAdapter, ProviderAdapterFactory, ProviderAdapterKey } from "../providers/provider.js";
import type { RunnerObservationPort } from "../coordinator/runner-coordinator.js";
import { createExecutionRuntimeAdapter } from "./create-execution-runtime-adapter.js";

export interface RunnerFactoryConfig {
  readonly schemaVersion: "runner.factory@1.0.0";
  readonly stateDirectory: string;
  readonly custody: Readonly<{
    recordsDirectory: string;
    publication: Readonly<{
      targetIdentity: string;
      repositoryPath: string;
      ref: string;
    }>;
  }>;
  readonly provider: Readonly<{
    key: "dsh-headless";
    configuration: DshProviderAdapterConfiguration;
  }>;
  readonly invocation: Readonly<{ journalDirectory: string }>;
  readonly host: Readonly<{ engine: "langgraph"; checkpointDirectory: string }>;
  readonly implementationIdentity: string;
}

export interface RunnerFactoryDependencies {
  readonly interaction: ActionInteractionBridge;
  readonly workflow: WorkflowControlBridge;
  readonly observation: RunnerObservationPort;
  readonly hostOperations: Readonly<Record<string, HostOperationHandler>>;
}

export class RunnerFactorySelectionError extends Error {
  readonly code = "RUNNER_FACTORY_SELECTION_MISMATCH";

  constructor(readonly selection: string) {
    super(`Runner factory has no exact adapter factory for '${selection}'`);
    this.name = "RunnerFactorySelectionError";
  }
}

export class RunnerFactoryConfigurationError extends TypeError {
  readonly code = "RUNNER_FACTORY_CONFIGURATION_INVALID";

  constructor(message = "Runner factory configuration is not exact and immutable") {
    super(message);
    this.name = "RunnerFactoryConfigurationError";
  }
}

export class RunnerFactoryStartupError extends Error {
  readonly code = "RUNNER_FACTORY_STARTUP_FAILED";

  constructor(cause: unknown) {
    super("Runner factory failed before publishing an adapter", { cause });
    this.name = "RunnerFactoryStartupError";
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

function exactData(value: unknown, expectedKeys: readonly string[]): DataRecord | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key): key is string => typeof key === "string")
    || [...keys].sort().join(",") !== [...expectedKeys].sort().join(",")) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function exactMethods(value: unknown, methods: readonly string[]): Readonly<Record<string, (...args: never[]) => unknown>> | undefined {
  const properties = exactData(value, methods);
  if (properties === undefined) return undefined;
  const captured: Array<readonly [string, (...args: never[]) => unknown]> = [];
  for (const method of methods) {
    const implementation = properties[method];
    if (typeof implementation !== "function") return undefined;
    captured.push([method, implementation.bind(value) as (...args: never[]) => unknown]);
  }
  return Object.freeze(Object.fromEntries(captured));
}

function exactHostOperations(value: unknown): Readonly<Record<string, HostOperationHandler>> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key): key is string => typeof key === "string")) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured: Array<readonly [string, HostOperationHandler]> = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const methods = exactMethods(descriptor.value, ["execute"]);
    if (methods === undefined) return undefined;
    captured.push([key, Object.freeze({ execute: methods.execute as HostOperationHandler["execute"] })]);
  }
  return Object.freeze(Object.fromEntries(captured));
}

function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value);
}

function admitConfiguration(candidate: RunnerFactoryConfig): RunnerFactoryConfig {
  if (!Object.isFrozen(candidate)) throw new RunnerFactoryConfigurationError();
  const root = exactData(candidate, ["schemaVersion", "stateDirectory", "custody", "provider", "invocation", "host", "implementationIdentity"]);
  const custody = exactData(root?.custody, ["recordsDirectory", "publication"]);
  const publication = exactData(custody?.publication, ["targetIdentity", "repositoryPath", "ref"]);
  const provider = exactData(root?.provider, ["key", "configuration"]);
  const providerConfiguration = exactData(provider?.configuration, ["providerIdentity", "workspaceDirectory", "sessionStorageDirectory", "credentialStore", "maxParallelToolCalls"]);
  const credentialStore = exactData(providerConfiguration?.credentialStore, ["path", "watch"]);
  const invocation = exactData(root?.invocation, ["journalDirectory"]);
  const host = exactData(root?.host, ["engine", "checkpointDirectory"]);
  const nested = [root?.custody, custody?.publication, root?.provider, provider?.configuration,
    providerConfiguration?.credentialStore, root?.invocation, root?.host];
  if (root === undefined || custody === undefined || publication === undefined || provider === undefined
    || providerConfiguration === undefined || credentialStore === undefined || invocation === undefined || host === undefined
    || nested.some((value) => value === undefined || !Object.isFrozen(value))) throw new RunnerFactoryConfigurationError();
  if (provider.key !== "dsh-headless") {
    throw new RunnerFactorySelectionError(typeof provider.key === "string" ? provider.key : "unknown");
  }
  if (root.schemaVersion !== "runner.factory@1.0.0"
    || !absolute(root.stateDirectory) || !absolute(custody.recordsDirectory)
    || typeof publication.targetIdentity !== "string" || publication.targetIdentity.length === 0
    || !absolute(publication.repositoryPath) || typeof publication.ref !== "string" || !publication.ref.startsWith("refs/")
    || providerConfiguration.providerIdentity !== "dsh-headless"
    || !absolute(providerConfiguration.workspaceDirectory) || !absolute(providerConfiguration.sessionStorageDirectory)
    || !absolute(credentialStore.path) || credentialStore.watch !== false
    || !Number.isSafeInteger(providerConfiguration.maxParallelToolCalls) || (providerConfiguration.maxParallelToolCalls as number) < 1
    || !absolute(invocation.journalDirectory) || host.engine !== "langgraph" || !absolute(host.checkpointDirectory)
    || typeof root.implementationIdentity !== "string" || root.implementationIdentity.length === 0) {
    throw new RunnerFactoryConfigurationError();
  }
  return candidate;
}

function admitDependencies(candidate: RunnerFactoryDependencies): RunnerFactoryDependencies {
  if (!Object.isFrozen(candidate)) throw new RunnerFactoryConfigurationError("Runner factory dependencies are not exact and immutable");
  const root = exactData(candidate, ["interaction", "workflow", "observation", "hostOperations"]);
  const interaction = exactMethods(root?.interaction, ["publish", "requestInput"]);
  const workflow = exactMethods(root?.workflow, ["request"]);
  const observation = exactMethods(root?.observation, ["observe"]);
  const hostOperations = exactHostOperations(root?.hostOperations);
  if (root === undefined || interaction === undefined || workflow === undefined || observation === undefined || hostOperations === undefined) {
    throw new RunnerFactoryConfigurationError("Runner factory dependencies are not exact capabilities");
  }
  return Object.freeze({
    interaction: interaction as unknown as ActionInteractionBridge,
    workflow: workflow as unknown as WorkflowControlBridge,
    observation: observation as unknown as RunnerObservationPort,
    hostOperations,
  });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalDigest(left as FrozenJsonValue) === canonicalDigest(right as FrozenJsonValue);
}

function typeMatches(value: FrozenJsonValue, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

const SCHEMA_KEYWORDS = new Set(["type", "const", "enum", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "allOf", "anyOf", "oneOf", "not", "description", "title", "$schema", "$id"]);

function validSchemaDefinition(schema: unknown, depth = 0): schema is FrozenJsonSchema {
  if (depth > 64 || schema === null || typeof schema !== "object" || Array.isArray(schema)) return false;
  const record = schema as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SCHEMA_KEYWORDS.has(key))) return false;
  for (const key of ["description", "title", "$schema", "$id"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") return false;
  }
  if (record.type !== undefined) {
    const allowed = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
    const types = typeof record.type === "string" ? [record.type] : record.type;
    if (!Array.isArray(types) || types.length === 0 || new Set(types).size !== types.length
      || types.some((type) => typeof type !== "string" || !allowed.has(type))) return false;
  }
  if (record.enum !== undefined && (!Array.isArray(record.enum) || record.enum.length === 0)) return false;
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0)) return false;
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (record[key] !== undefined && (typeof record[key] !== "number" || !Number.isFinite(record[key]))) return false;
  }
  if (record.pattern !== undefined) {
    if (typeof record.pattern !== "string") return false;
    try { new RegExp(record.pattern, "u"); } catch { return false; }
  }
  if (record.required !== undefined && (!Array.isArray(record.required)
    || record.required.some((key) => typeof key !== "string")
    || new Set(record.required).size !== record.required.length)) return false;
  if (record.properties !== undefined) {
    if (record.properties === null || typeof record.properties !== "object" || Array.isArray(record.properties)
      || !Object.values(record.properties).every((child) => validSchemaDefinition(child, depth + 1))) return false;
  }
  if (record.items !== undefined && !validSchemaDefinition(record.items, depth + 1)) return false;
  if (record.additionalProperties !== undefined && typeof record.additionalProperties !== "boolean"
    && !validSchemaDefinition(record.additionalProperties, depth + 1)) return false;
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (record[key] !== undefined && (!Array.isArray(record[key]) || record[key].length === 0
      || !record[key].every((child) => validSchemaDefinition(child, depth + 1)))) return false;
  }
  if (record.not !== undefined && !validSchemaDefinition(record.not, depth + 1)) return false;
  return true;
}

function validateSchema(value: FrozenJsonValue, schema: FrozenJsonSchema, depth = 0): boolean {
  if (!validSchemaDefinition(schema, depth)) return false;
  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
    if (types.length === 0 || !types.every((item) => typeof item === "string") || !types.some((item) => typeMatches(value, item as string))) return false;
  }
  if ("const" in schema && !same(value, schema.const)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.some((item) => same(value, item)))) return false;
  for (const key of ["allOf", "anyOf", "oneOf"] as const) if (schema[key] !== undefined && !Array.isArray(schema[key])) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((child) => validateSchema(value, child as FrozenJsonSchema, depth + 1))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => validateSchema(value, child as FrozenJsonSchema, depth + 1))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((child) => validateSchema(value, child as FrozenJsonSchema, depth + 1)).length !== 1) return false;
  if (schema.not !== undefined && validateSchema(value, schema.not as FrozenJsonSchema, depth + 1)) return false;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (schema.pattern !== undefined && (typeof schema.pattern !== "string" || !new RegExp(schema.pattern, "u").test(value))) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((item) => validateSchema(item, schema.items as FrozenJsonSchema, depth + 1))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, FrozenJsonValue>>;
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string" && key in record))) return false;
    const properties = schema.properties;
    if (properties !== undefined && (properties === null || typeof properties !== "object" || Array.isArray(properties))) return false;
    for (const [key, child] of Object.entries(record)) {
      const childSchema = (properties as Readonly<Record<string, FrozenJsonSchema>> | undefined)?.[key];
      if (childSchema !== undefined) {
        if (!validateSchema(child, childSchema, depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true
        && !validateSchema(child, schema.additionalProperties as FrozenJsonSchema, depth + 1)) return false;
    }
  }
  return true;
}

export const RUNNER_INVOCATION_RESULT_VALIDATOR: InvocationResultValidator = Object.freeze({
  validate(schema: FrozenJsonSchema, value: FrozenJsonValue) {
    try { return validateSchema(value, schema); } catch { return false; }
  },
});

export class ExactProviderFactoryRegistry {
  readonly #factories: ReadonlyMap<ProviderAdapterKey, ProviderAdapterFactory>;

  constructor(factories: readonly ProviderAdapterFactory[]) {
    const byKey = new Map<ProviderAdapterKey, ProviderAdapterFactory>();
    for (const factory of factories) {
      if (byKey.has(factory.key)) throw new RunnerFactoryConfigurationError(`duplicate Provider factory '${factory.key}'`);
      byKey.set(factory.key, factory);
    }
    this.#factories = byKey;
  }

  async create(key: string, configuration: unknown): Promise<ProviderAdapter> {
    const factory = this.#factories.get(key as ProviderAdapterKey);
    if (factory === undefined) throw new RunnerFactorySelectionError(key);
    return factory.create(configuration);
  }
}

function invocationFacade(invocation: HostInvocation): HostInvocation {
  return Object.freeze({
    start: invocation.start.bind(invocation),
    continueWithInput: invocation.continueWithInput.bind(invocation),
  });
}

function custodyFacade(custody: HostCustody): HostCustody {
  return Object.freeze({
    establishBaseline: custody.establishBaseline.bind(custody),
    acquireWriteHandle: custody.acquireWriteHandle.bind(custody),
    openReadView: custody.openReadView.bind(custody),
    settleWorkspaceAttempt: custody.settleWorkspaceAttempt.bind(custody),
    validateReadView: custody.validateReadView.bind(custody),
  });
}

export class RunnerFactory {
  readonly #providers = new ExactProviderFactoryRegistry([new DshProviderAdapterFactory()]);
  readonly #resources = new WeakMap<ExecutionRuntimeAdapter, { provider: ProviderAdapter; disposed: boolean }>();

  async create(candidate: RunnerFactoryConfig, dependencies: RunnerFactoryDependencies): Promise<ExecutionRuntimeAdapter> {
    const config = admitConfiguration(candidate);
    const admittedDependencies = admitDependencies(dependencies);
    if (config.provider.key !== "dsh-headless") throw new RunnerFactorySelectionError(config.provider.key);
    let provider: ProviderAdapter | undefined;
    try {
      provider = await this.#providers.create(config.provider.key, config.provider.configuration);
      const journal = new FileInvocationJournalStore(config.invocation.journalDirectory);
      const invocation = createManagedInvocation({
        providers: Object.freeze({ [provider.key]: provider.sessions }),
        credentials: provider.credentials,
        journal,
        resultValidator: RUNNER_INVOCATION_RESULT_VALIDATOR,
      });
      const publicationTarget = Object.freeze({ identity: config.custody.publication.targetIdentity }) as PublicationTargetRef;
      const custody = createGitCustody({
        recordsDirectory: config.custody.recordsDirectory as AbsolutePath,
        publicationTargets: Object.freeze([Object.freeze({
          target: publicationTarget,
          repositoryPath: config.custody.publication.repositoryPath as AbsolutePath,
          ref: config.custody.publication.ref,
        })]),
      });
      const host = await new LangGraphWorkflowHostAdapterFactory().create(
        config.host,
        Object.freeze({
          invocation: invocationFacade(invocation.host),
          custody: custodyFacade(custody),
          hostOperations: admittedDependencies.hostOperations,
        }),
      );
      const adapter = createExecutionRuntimeAdapter({
        stateDirectory: config.stateDirectory,
        host,
        invocation: invocation.control,
        custody,
        interaction: admittedDependencies.interaction,
        workflow: admittedDependencies.workflow,
        observation: admittedDependencies.observation,
        publicationTarget,
        implementationIdentity: config.implementationIdentity as ImplementationId,
      });
      this.#resources.set(adapter, { provider, disposed: false });
      return adapter;
    } catch (cause) {
      await provider?.dispose().catch(() => undefined);
      if (cause instanceof RunnerFactorySelectionError || cause instanceof RunnerFactoryConfigurationError) throw cause;
      throw new RunnerFactoryStartupError(cause);
    }
  }

  async dispose(adapter: ExecutionRuntimeAdapter): Promise<void> {
    const resources = this.#resources.get(adapter);
    if (resources === undefined || resources.disposed) return;
    resources.disposed = true;
    await resources.provider.dispose();
    this.#resources.delete(adapter);
  }
}
