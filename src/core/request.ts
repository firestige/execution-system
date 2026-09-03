import { isAbsolute } from "node:path";

import type {
  TaskPrompt,
  TaskPromptAttachment,
  TaskSelection,
} from "../application/execution-application.js";
import {
  createDeliveryConfigProjection,
  createDeliveryConfigProjectionV2,
  deepFreeze,
  type DeliveryConfigProjection,
  type DeliveryConfigProjectionV2,
  type ExecutionInstallationConfig,
  type ExecutionInstallationConfigV2,
} from "../configuration/index.js";

export interface ExecutionEnvironment {
  readonly schemaVersion: "execution.environment@2.0.0";
  readonly allowedWorktreeRoots: readonly string[];
  readonly allowExplicitRefresh: boolean;
  readonly maxCorrelationBytes: number;
  readonly deliveryConfigProjection: DeliveryConfigProjection | DeliveryConfigProjectionV2;
}

export interface ExecutionPrebindingCommand {
  readonly schemaVersion: "execution.prebinding-command@1.1.0";
  readonly admissionId: string;
  readonly canonicalWorktree: string;
  readonly selector: string;
  readonly prompt: TaskPrompt;
  readonly taskSelection: TaskSelection;
  readonly refresh: boolean;
  readonly intakeCorrelation?: string;
  readonly deliveryConfigProjection: DeliveryConfigProjection["value"] | DeliveryConfigProjectionV2["value"];
  readonly deliveryConfigProjectionIdentity: string;
}

export interface ConversationWorkspaceAuthorization {
  readonly schemaVersion: "execution.conversation-workspace-authorization@1.0.0";
  readonly sessionKey: string;
  readonly workspaceId: string;
  readonly path: string;
}

export class CoreRequestError extends Error {
  constructor(readonly code: "INVALID_EXECUTION_REQUEST" | "REFRESH_DISABLED") {
    super(code);
    this.name = "CoreRequestError";
  }
}

function exactObject(value: unknown, required: readonly string[], allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  }
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key): key is string => typeof key === "string")
    || required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.includes(key))) {
    throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => descriptors[key] === undefined || !("value" in descriptors[key]!))) {
    throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  }
  return Object.fromEntries(keys.map((key) => [key, (descriptors[key] as PropertyDescriptor & { value: unknown }).value]));
}

function boundedString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  return value;
}

export function admitConversationWorkspaceAuthorization(candidate: unknown): ConversationWorkspaceAuthorization {
  if (!Object.isFrozen(candidate)) throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  const keys = ["schemaVersion", "sessionKey", "workspaceId", "path"];
  const data = exactObject(candidate, keys, keys);
  if (data.schemaVersion !== "execution.conversation-workspace-authorization@1.0.0"
    || typeof data.path !== "string" || !isAbsolute(data.path)) throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  return Object.freeze({
    schemaVersion: data.schemaVersion,
    sessionKey: boundedString(data.sessionKey, 1, 512),
    workspaceId: boundedString(data.workspaceId, 1, 512),
    path: data.path,
  });
}

function attachment(value: unknown): TaskPromptAttachment {
  const data = exactObject(value, ["identity", "filename", "mediaType", "byteLength", "digest", "contentRef"], ["identity", "filename", "mediaType", "byteLength", "digest", "contentRef"]);
  if (!Number.isSafeInteger(data.byteLength) || (data.byteLength as number) < 0 || (data.byteLength as number) > 67_108_864
    || typeof data.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(data.digest)) {
    throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  }
  return deepFreeze({
    identity: boundedString(data.identity, 1, 512),
    filename: boundedString(data.filename, 1, 255),
    mediaType: boundedString(data.mediaType, 1, 255),
    byteLength: data.byteLength as number,
    digest: data.digest,
    contentRef: boundedString(data.contentRef, 1, 1024),
  });
}

function taskPrompt(value: unknown): TaskPrompt {
  const data = exactObject(value, ["text", "attachments"], ["text", "attachments"]);
  if (typeof data.text !== "string" || Buffer.byteLength(data.text, "utf8") > 1_048_576
    || !Array.isArray(data.attachments) || data.attachments.length > 32) {
    throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  }
  const attachments = data.attachments.map(attachment);
  if (data.text.length === 0 && attachments.length === 0) throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  return deepFreeze({ text: data.text, attachments });
}

function taskSelection(value: unknown): TaskSelection {
  if (value === undefined) return Object.freeze({
    schemaVersion: "execution.task-selection@0.1.0",
    mode: "NEW_TASK",
  });
  const candidate = exactObject(
    value,
    ["schemaVersion", "mode"],
    ["schemaVersion", "mode", "displayName", "taskId"],
  );
  if (candidate.schemaVersion !== "execution.task-selection@0.1.0") {
    throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  }
  if (candidate.mode === "NEW_TASK") {
    if (candidate.taskId !== undefined) throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
    if (candidate.displayName === undefined) return Object.freeze({
      schemaVersion: candidate.schemaVersion,
      mode: "NEW_TASK",
    });
    const displayName = boundedString(candidate.displayName, 1, 160);
    if (displayName.trim() !== displayName) throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
    return Object.freeze({ schemaVersion: candidate.schemaVersion, mode: "NEW_TASK", displayName });
  }
  if (candidate.mode === "REUSE_TASK") {
    if (candidate.displayName !== undefined) throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
    const taskId = boundedString(candidate.taskId, 1, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(taskId)) {
      throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
    }
    return Object.freeze({ schemaVersion: candidate.schemaVersion, mode: "REUSE_TASK", taskId });
  }
  throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
}

export function createExecutionEnvironment(
  config: ExecutionInstallationConfig | ExecutionInstallationConfigV2,
): ExecutionEnvironment {
  if (!Object.isFrozen(config)) throw new TypeError("ExecutionEnvironment input must be an immutable canonical configuration value");
  const deliveryConfigProjection = config.schemaVersion === "execution.config@2.0.0"
    ? createDeliveryConfigProjectionV2(config)
    : createDeliveryConfigProjection(config);
  return deepFreeze({
    schemaVersion: "execution.environment@2.0.0",
    allowedWorktreeRoots: [...config.paths.allowedWorktreeRoots],
    allowExplicitRefresh: config.controls.allowExplicitRefresh,
    maxCorrelationBytes: config.intake.maxCorrelationBytes,
    deliveryConfigProjection,
  });
}

export function captureRequestWorktree(candidate: unknown): string {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)
    || (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)) {
    throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  }
  const keys = Reflect.ownKeys(candidate);
  const allowed = ["worktree", "selector", "prompt", "taskSelection", "refresh", "intakeCorrelation"];
  if (!keys.every((key): key is string => typeof key === "string")
    || !keys.includes("worktree") || !keys.includes("selector") || !keys.includes("prompt")
    || keys.some((key) => !allowed.includes(key))) throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  const descriptor = Object.getOwnPropertyDescriptor(candidate, "worktree");
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
    throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  }
  return descriptor.value;
}

export function createPrebindingCommand(
  candidate: unknown,
  canonicalWorktree: string,
  admissionId: string,
  environment: ExecutionEnvironment,
): ExecutionPrebindingCommand {
  const data = exactObject(
    candidate,
    ["worktree", "selector", "prompt"],
    ["worktree", "selector", "prompt", "taskSelection", "refresh", "intakeCorrelation"],
  );
  const selector = boundedString(data.selector, 1, 256);
  const refresh = data.refresh ?? false;
  if (typeof refresh !== "boolean") throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
  if (refresh && !environment.allowExplicitRefresh) throw new CoreRequestError("REFRESH_DISABLED");
  let intakeCorrelation: string | undefined;
  if (data.intakeCorrelation !== undefined) {
    if (typeof data.intakeCorrelation !== "string" || Buffer.byteLength(data.intakeCorrelation, "utf8") > environment.maxCorrelationBytes) {
      throw new CoreRequestError("INVALID_EXECUTION_REQUEST");
    }
    intakeCorrelation = data.intakeCorrelation;
  }
  return deepFreeze({
    schemaVersion: "execution.prebinding-command@1.1.0",
    admissionId,
    canonicalWorktree,
    selector,
    prompt: taskPrompt(data.prompt),
    taskSelection: taskSelection(data.taskSelection),
    refresh,
    ...(intakeCorrelation === undefined ? {} : { intakeCorrelation }),
    deliveryConfigProjection: environment.deliveryConfigProjection.value,
    deliveryConfigProjectionIdentity: environment.deliveryConfigProjection.identity,
  });
}
