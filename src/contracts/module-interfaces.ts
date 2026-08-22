export const INTERFACE_VERSION = "runner.internal-interface@1.0.0" as const;

export type RuntimeModuleIdentity =
  | "runner.module.001"
  | "runner.module.002"
  | "runner.module.003"
  | "runner.module.004";

export type ExplicitKnowledge<T> =
  | Readonly<{ state: "KNOWN"; value: T }>
  | Readonly<{ state: "UNKNOWN"; owner: RuntimeModuleIdentity; reasonCode: string }>;

export interface ModuleRequest<Operation extends string, Payload> {
  readonly interfaceVersion: typeof INTERFACE_VERSION;
  readonly requestIdentity: string;
  readonly deliveryIdentity: string;
  readonly manifestBindingIdentity: string;
  readonly operation: Operation;
  readonly payload: Payload;
}

export type ModuleResult<Value> =
  | Readonly<{ status: "SUCCEEDED"; owner: RuntimeModuleIdentity; operation: string; value: Value }>
  | Readonly<{
      status: "REJECTED";
      owner: RuntimeModuleIdentity;
      operation: string;
      error: Readonly<{ code: string; retryable: boolean }>;
    }>
  | Readonly<{
      status: "UNKNOWN";
      owner: RuntimeModuleIdentity;
      operation: string;
      reasonCode: string;
    }>;

function frozen<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) frozen(child);
  }
  return Object.freeze(value);
}

export function known<T>(value: T): ExplicitKnowledge<T> {
  return frozen({ state: "KNOWN" as const, value });
}

export function unknown(
  owner: RuntimeModuleIdentity,
  reasonCode: string,
): ExplicitKnowledge<never> {
  return frozen({ state: "UNKNOWN" as const, owner, reasonCode });
}

export function rejected(
  owner: RuntimeModuleIdentity,
  operation: string,
  code: string,
  retryable: boolean,
): ModuleResult<never> {
  return frozen({
    status: "REJECTED" as const,
    owner,
    operation,
    error: { code, retryable },
  });
}

export const PROVIDER_CAPABILITIES = [
  "agent.invoke",
  "cwd.bound",
  "session.scoped",
  "child.cancel",
] as const;

export const PROVIDER_BINDINGS = frozen({
  "dsh-headless": {
    availability: "USABLE" as const,
    capabilities: [...PROVIDER_CAPABILITIES],
  },
  "copilot-sdk": {
    availability: "UNSUPPORTED_ITER2" as const,
    reasonCode: "PROVIDER_NOT_IMPLEMENTED" as const,
  },
  "codex-cli": {
    availability: "UNSUPPORTED_ITER2" as const,
    reasonCode: "PROVIDER_NOT_IMPLEMENTED" as const,
  },
});
