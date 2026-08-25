export class IntakeBindingError extends Error {
  readonly code: "DELIVERY_INTAKE_BOUND" | "INTAKE_BINDING_INVARIANT_VIOLATION";
}

export interface IntakeSessionBinding {
  readonly sessionKey: string;
  readonly correlation: string;
  readonly deliveryId: string;
  readonly worktree: string;
  readonly state: "BOUND" | "DETACHED";
}

export class IntakeSessionBindingRepository {
  constructor(file: string);
  start(): Promise<void>;
  claim(input: Omit<IntakeSessionBinding, "state">): Promise<IntakeSessionBinding>;
  bySession(sessionKey: string): Promise<IntakeSessionBinding | undefined>;
  byDelivery(deliveryId: string): Promise<IntakeSessionBinding | undefined>;
  list(): Promise<readonly IntakeSessionBinding[]>;
  markDetached(deliveryId: string): Promise<void>;
  detach(deliveryId: string): Promise<void>;
}

export function parseWsrCommand(value: string): Readonly<Record<string, string>>;
export function mapIntakeToolOperation(value: unknown): Readonly<Record<string, string>>;
export function resolveConversationWorkspace(context: unknown, agent: unknown): Promise<Readonly<{
  sessionKey: string;
  workspaceId: string;
  path: string;
}>>;
export function recordConsumedActionReply(agent: unknown, message: unknown): void;
export function recordWsrCommandInput(
  agent: unknown,
  rawInput: string,
  attachments?: readonly unknown[],
  createId?: () => string,
): Promise<unknown>;
export function presentationForDshOperation(
  api: Readonly<{ createIntakePresentation: (...args: any[]) => any; presentationForIntakeResult: (...args: any[]) => any }>,
  correlation: string,
  operation: Readonly<Record<string, string>>,
  result: Readonly<Record<string, unknown>>,
  maxBytes?: number,
): unknown;
export function presentToDshSession(agent: unknown, presentation: Readonly<{
  schemaVersion: "wsr.presentation@1.0.0";
  correlation: string;
  kind: "command-accepted" | "delivery-running" | "delivery-list" | "delivery-status" | "action-output" | "action-input-request" | "terminal-result" | "error";
  data: Readonly<Record<string, unknown>>;
}>, createId?: () => string): void;
export function createPluginRuntime(config: unknown, options?: unknown): Promise<unknown>;
export function apply(ctx: unknown, config: unknown): Promise<void>;

declare module "@deepseek-ai/dsh-commands/types" {
  interface CommandSourceMap {
    workflowExecution: { readonly kind: "plugin"; readonly plugin: "workflow-execution" };
  }
}
