import type {
  FrozenJsonSchema,
  FrozenJsonValue,
  InvocationDispatch,
  ManagedInvocationFailure,
} from "../contracts/index.js";

export type NativeTurnEvent =
  | Readonly<{ kind: "output"; content: FrozenJsonValue }>
  | Readonly<{
      kind: "input-request";
      requestIdentity: string;
      prompt: FrozenJsonValue;
      responseSchema: FrozenJsonSchema;
    }>
  | Readonly<{ kind: "structured-completion"; result: FrozenJsonValue }>
  | Readonly<{
      kind: "provider-failed";
      code: ManagedInvocationFailure["code"];
      detail: unknown;
    }>
  | Readonly<{ kind: "turn-ended" | "process-exited" | "session-disposed" }>;

export interface CredentialMaterial {
  readonly [name: string]: string;
}

export interface NativeSessionOpenRequest {
  readonly dispatch: InvocationDispatch;
  readonly credentials: CredentialMaterial;
  readonly signal: AbortSignal;
}

export interface NativeSessionRestoreRequest extends NativeSessionOpenRequest {
  readonly opaqueIdentity: string;
}

export interface NativeProviderSession {
  readonly opaqueIdentity: string;
  run(input: unknown): Promise<readonly NativeTurnEvent[]>;
  persist(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface NativeProviderSessionFactory {
  open(request: NativeSessionOpenRequest): Promise<NativeProviderSession>;
  restore(request: NativeSessionRestoreRequest): Promise<NativeProviderSession>;
}

export interface CredentialLease {
  readonly material: CredentialMaterial;
  release(): Promise<void>;
}

export interface CredentialLeaseBroker {
  acquire(dispatch: InvocationDispatch): Promise<CredentialLease>;
}

export type ProviderAdapterKey = "dsh-headless" | "copilot-sdk" | "codex-cli";

export interface ProviderAdapter<Key extends ProviderAdapterKey = ProviderAdapterKey> {
  readonly key: Key;
  readonly sessions: NativeProviderSessionFactory;
  readonly credentials: CredentialLeaseBroker;
  dispose(): Promise<void>;
}

export interface ProviderAdapterFactory<Key extends ProviderAdapterKey = ProviderAdapterKey, Configuration = unknown> {
  readonly key: Key;
  create(configuration: Configuration): Promise<ProviderAdapter<Key>>;
}

export class ProviderFactorySelectionError extends Error {
  readonly code = "PROVIDER_FACTORY_SELECTION_MISMATCH";

  constructor(readonly provider: string) {
    super(`configured Provider factory does not own '${provider}'`);
    this.name = "ProviderFactorySelectionError";
  }
}

export class ProviderAdapterStartupError extends Error {
  readonly code = "PROVIDER_ADAPTER_STARTUP_FAILED";

  constructor(readonly provider: string, cause: unknown) {
    super(`Provider adapter '${provider}' failed during startup`, { cause });
    this.name = "ProviderAdapterStartupError";
  }
}

export interface ProviderNotImplementedError {
  readonly code: "PROVIDER_NOT_IMPLEMENTED";
}

export function providerNotImplemented(): ProviderNotImplementedError {
  return Object.freeze({ code: "PROVIDER_NOT_IMPLEMENTED" });
}
