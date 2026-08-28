export interface TaskPromptAttachment {
  readonly identity: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly contentRef: string;
}

export interface TaskPrompt {
  readonly text: string;
  readonly attachments: readonly TaskPromptAttachment[];
}

export type TaskSelection =
  | Readonly<{
    readonly schemaVersion: "execution.task-selection@0.1.0";
    readonly mode: "NEW_TASK";
    readonly displayName?: string;
  }>
  | Readonly<{
    readonly schemaVersion: "execution.task-selection@0.1.0";
    readonly mode: "REUSE_TASK";
    readonly taskId: string;
  }>;

/** Host-neutral request accepted by every Execution Intake Adapter. */
export interface ExecutionRequest {
  readonly worktree: string;
  readonly selector: string;
  readonly prompt: TaskPrompt;
  readonly taskSelection?: TaskSelection;
  readonly refresh?: boolean;
  readonly intakeCorrelation?: string;
}

export type ExecutionErrorCode =
  | "APPLICATION_NOT_READY"
  | "APPLICATION_CLOSING"
  | "EXECUTION_BUSY"
  | "INVALID_EXECUTION_REQUEST"
  | "INVALID_WORKTREE"
  | "WORKTREE_OUT_OF_SCOPE"
  | "REFRESH_DISABLED"
  | "INVALID_WORKFLOW_SELECTOR"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_FETCH_FAILED"
  | "WORKFLOW_PACKAGE_INVALID"
  | "WORKFLOW_VERSION_MISMATCH"
  | "WORKFLOW_DIGEST_MISMATCH"
  | "WORKFLOW_DSH_INCOMPATIBLE"
  | "WORKFLOW_CACHE_PUBLISH_FAILED"
  | "DELIVERY_BINDING_FAILED"
  | "DELIVERY_CREATE_FAILED"
  | "RUNNER_START_FAILED"
  | "RUNNER_RESULT_INVALID"
  | "ACTION_NOT_AWAITING_INPUT"
  | "DELIVERY_UNKNOWN";

export interface ExecutionFailure {
  readonly kind: "ERROR";
  readonly code: ExecutionErrorCode;
  readonly message: string;
}

export interface ExecutionContended {
  readonly kind: "CONTENDED";
  readonly worktree: string;
  readonly admissionId: string;
}

export interface ExecutionRecovery {
  readonly kind: "RECOVERY";
  readonly worktree: string;
  readonly deliveryId: string;
  readonly state: "BOUND" | "START_UNCERTAIN" | "RUNNING_CORRELATED" | "START_FAILED" | "RESULT_UNRESOLVED" | "TERMINAL_HANDLING";
}

export interface ExecutionPreDeliveryCancelled {
  readonly kind: "PRE_DELIVERY_CANCELLED";
  readonly worktree: string;
  readonly admissionId: string;
}

export interface ExecutionStarted {
  readonly kind: "START_UNCERTAIN";
  readonly worktree: string;
  readonly deliveryId: string;
}

export interface ExecutionTerminal {
  readonly kind: "TERMINAL";
  readonly worktree: string;
  readonly deliveryId: string;
  readonly outcome: "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly summary?: string;
}

export interface ExecutionUnknown {
  readonly kind: "UNKNOWN";
  readonly worktree: string;
  readonly deliveryId: string;
  readonly state: "START_UNCERTAIN" | "RESULT_UNRESOLVED";
}

export type ExecutionResult =
  | ExecutionFailure
  | ExecutionContended
  | ExecutionRecovery
  | ExecutionPreDeliveryCancelled
  | ExecutionStarted
  | ExecutionTerminal
  | ExecutionUnknown;

export type ExecutionApplicationState =
  | "CREATED"
  | "STARTING"
  | "RECOVERING"
  | "READY"
  | "CLOSING"
  | "CLOSED";

export interface ExecutionApplicationStatus {
  readonly state: ExecutionApplicationState;
  readonly diagnostic?: Readonly<{
    readonly code: string;
    readonly phase: "STARTING" | "RECOVERING" | "CLOSING";
    readonly installationIdentity: string;
  }>;
}

/** Public product surface. No host, Provider, Cordis, or DSH-native value crosses it. */
export interface ExecutionApplication {
  start(): Promise<void>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  inspect(worktree: string): Promise<ExecutionResult>;
  cancel(deliveryId: string): Promise<ExecutionResult>;
  status(): ExecutionApplicationStatus;
  close(): Promise<void>;
}
