import { isAbsolute } from "node:path";

import { createLangGraphCoordinatorHost } from "./langgraph-coordinator-host.js";
import {
  WorkflowHostAdapterStartupError,
  WorkflowHostConfigurationError,
  WorkflowHostFactorySelectionError,
  type WorkflowHostAdapterDependencies,
  type WorkflowHostAdapterFactory,
  type HostOperationHandler,
} from "./workflow-host-adapter-factory.js";

export interface LangGraphWorkflowHostConfiguration {
  readonly engine: "langgraph";
  readonly checkpointDirectory: string;
}

function exactOwnKeys(value: object): string | undefined {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string") ? (keys as string[]).sort().join(",") : undefined;
}

function exactDataProperties(value: object, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (exactOwnKeys(value) !== [...expectedKeys].sort().join(",")) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function exactRecordDataProperties(value: object): readonly (readonly [string, unknown])[] | undefined {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key): key is string => typeof key === "string")) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.freeze(entries);
}

function exactMethodCapability(value: unknown, methods: readonly string[]): Readonly<Record<string, (...args: never[]) => unknown>> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const properties = exactDataProperties(value, methods);
  if (properties === undefined) return undefined;
  const captured: Array<readonly [string, (...args: never[]) => unknown]> = [];
  for (const method of methods) {
    const implementation = properties[method];
    if (typeof implementation !== "function") return undefined;
    captured.push([method, implementation.bind(value) as (...args: never[]) => unknown]);
  }
  return Object.freeze(Object.fromEntries(captured));
}

function exactConfiguration(candidate: LangGraphWorkflowHostConfiguration): LangGraphWorkflowHostConfiguration {
  if (candidate === null || typeof candidate !== "object") throw new WorkflowHostConfigurationError();
  const properties = exactDataProperties(candidate, ["engine", "checkpointDirectory"]);
  if (!Object.isFrozen(candidate) || properties === undefined) {
    throw new WorkflowHostConfigurationError();
  }
  if (properties.engine !== "langgraph") {
    throw new WorkflowHostFactorySelectionError(typeof properties.engine === "string" ? properties.engine : "unknown");
  }
  if (typeof properties.checkpointDirectory !== "string" || !isAbsolute(properties.checkpointDirectory)) throw new WorkflowHostConfigurationError();
  return Object.freeze({ engine: "langgraph", checkpointDirectory: properties.checkpointDirectory });
}

function exactDependencies(candidate: WorkflowHostAdapterDependencies): WorkflowHostAdapterDependencies {
  if (candidate === null || typeof candidate !== "object") throw new WorkflowHostConfigurationError("Workflow Host assembly dependencies are invalid");
  const keys = exactOwnKeys(candidate);
  if (keys !== "custody,invocation" && keys !== "custody,hostOperations,invocation") {
    throw new WorkflowHostConfigurationError("Workflow Host assembly dependencies are not exact");
  }
  const hasHostOperations = keys === "custody,hostOperations,invocation";
  const expectedKeys = hasHostOperations ? ["invocation", "custody", "hostOperations"] : ["invocation", "custody"];
  const properties = exactDataProperties(candidate, expectedKeys);
  if (properties === undefined) {
    throw new WorkflowHostConfigurationError("Workflow Host assembly dependencies are not exact");
  }
  const invocation = exactMethodCapability(properties.invocation, ["start", "continueWithInput"]);
  const custody = exactMethodCapability(properties.custody, ["establishBaseline", "acquireWriteHandle", "openReadView", "settleWorkspaceAttempt", "validateReadView"]);
  if (invocation === undefined || custody === undefined) {
    throw new WorkflowHostConfigurationError("Workflow Host assembly dependencies are invalid");
  }
  let hostOperations: Readonly<Record<string, HostOperationHandler>> | undefined;
  if (hasHostOperations) {
    const catalog = properties.hostOperations;
    if (catalog === null || typeof catalog !== "object") {
      throw new WorkflowHostConfigurationError("Workflow Host operation catalog is not exact");
    }
    const entries = exactRecordDataProperties(catalog);
    if (entries === undefined) throw new WorkflowHostConfigurationError("Workflow Host operation catalog is not exact");
    const captured: Array<readonly [string, HostOperationHandler]> = [];
    for (const [identity, handler] of entries) {
      const capability = exactMethodCapability(handler, ["execute"]);
      if (capability === undefined) {
        throw new WorkflowHostConfigurationError("Workflow Host operation capability is invalid");
      }
      captured.push([identity, capability as unknown as HostOperationHandler]);
    }
    hostOperations = Object.freeze(Object.fromEntries(captured));
  }
  return Object.freeze({
    invocation: invocation as unknown as WorkflowHostAdapterDependencies["invocation"],
    custody: custody as unknown as WorkflowHostAdapterDependencies["custody"],
    ...(hostOperations === undefined ? {} : { hostOperations }),
  });
}

export class LangGraphWorkflowHostAdapterFactory implements WorkflowHostAdapterFactory<"langgraph", LangGraphWorkflowHostConfiguration> {
  readonly engine = "langgraph" as const;

  async create(configuration: LangGraphWorkflowHostConfiguration, dependencies: WorkflowHostAdapterDependencies) {
    const admittedConfiguration = exactConfiguration(configuration);
    const admittedDependencies = exactDependencies(dependencies);
    try {
      return createLangGraphCoordinatorHost({
        invocation: admittedDependencies.invocation,
        custody: admittedDependencies.custody,
        checkpointDirectory: admittedConfiguration.checkpointDirectory,
        ...(admittedDependencies.hostOperations === undefined ? {} : { hostOperations: admittedDependencies.hostOperations }),
      });
    } catch (cause) {
      throw new WorkflowHostAdapterStartupError(this.engine, cause);
    }
  }
}
