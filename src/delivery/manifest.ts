import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { TaskPrompt } from "../application/execution-application.js";
import type { AttachmentContentPort } from "../bootstrap/contracts.js";
import { canonicalJsonBytes, deepFreeze, type DeliveryConfigProjection } from "../configuration/index.js";
import type { ResolvedWorkflowPackage } from "./workflow-package-store.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestValue(value: JsonValue): string {
  return digestBytes(canonicalJsonBytes(value));
}

function safeSegment(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type DeliveryBindingErrorCode =
  | "ATTACHMENT_CONTENT_MISMATCH"
  | "ATTACHMENT_SNAPSHOT_FAILED"
  | "DELIVERY_BINDING_INVALID"
  | "DELIVERY_MANIFEST_PERSIST_FAILED"
  | "DELIVERY_MANIFEST_INVALID";

export class DeliveryBindingError extends Error {
  constructor(readonly code: DeliveryBindingErrorCode) {
    super(code);
    this.name = "DeliveryBindingError";
  }
}

export interface ImmutableAttachmentSnapshot {
  readonly identity: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly path: string;
}

export interface ImmutableTaskPromptSnapshot {
  readonly schemaVersion: "execution.task-prompt-snapshot@1.0.0";
  readonly identity: string;
  readonly digest: string;
  readonly path: string;
  readonly textPath: string;
  readonly attachments: readonly ImmutableAttachmentSnapshot[];
}

export interface CaptureTaskPromptSnapshotInput {
  readonly root: string;
  readonly deliveryId: string;
  readonly prompt: TaskPrompt;
  readonly attachments: AttachmentContentPort;
}

export async function captureTaskPromptSnapshot(input: CaptureTaskPromptSnapshotInput): Promise<ImmutableTaskPromptSnapshot> {
  if (!isAbsolute(input.root) || input.deliveryId.length === 0) throw new DeliveryBindingError("DELIVERY_BINDING_INVALID");
  const finalPath = join(resolve(input.root), safeSegment(input.deliveryId));
  const stagingPath = `${finalPath}.${randomUUID()}.staging`;
  const textBytes = new TextEncoder().encode(input.prompt.text);
  const promptIdentityInput = {
    textDigest: digestBytes(textBytes),
    attachments: input.prompt.attachments.map(({ identity, filename, mediaType, byteLength, digest }) => ({ identity, filename, mediaType, byteLength, digest })),
  } satisfies JsonValue;
  const taskPromptIdentity = digestValue(promptIdentityInput);
  try {
    await mkdir(stagingPath, { recursive: true, mode: 0o700 });
    const textPath = join(stagingPath, "prompt.txt");
    await writeFile(textPath, textBytes, { flag: "wx", mode: 0o600 });
    const captured: ImmutableAttachmentSnapshot[] = [];
    for (const [index, attachment] of input.prompt.attachments.entries()) {
      let bytes: Uint8Array;
      try { bytes = await input.attachments.read(attachment.contentRef, attachment.byteLength + 1); }
      catch { throw new DeliveryBindingError("ATTACHMENT_SNAPSHOT_FAILED"); }
      if (bytes.byteLength !== attachment.byteLength || digestBytes(bytes) !== attachment.digest || !SHA256.test(attachment.digest)) {
        throw new DeliveryBindingError("ATTACHMENT_CONTENT_MISMATCH");
      }
      const filename = `${String(index).padStart(2, "0")}-${safeSegment(attachment.identity)}.bin`;
      const path = join(stagingPath, filename);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      captured.push({
        identity: attachment.identity,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
        digest: attachment.digest,
        path,
      });
    }
    const snapshotDigest = digestValue({
      taskPromptIdentity,
      textDigest: digestBytes(textBytes),
      attachments: captured.map(({ identity, filename, mediaType, byteLength, digest }) => ({ identity, filename, mediaType, byteLength, digest })),
    });
    const record = {
      schemaVersion: "execution.task-prompt-snapshot@1.0.0",
      identity: taskPromptIdentity,
      digest: snapshotDigest,
      textFile: "prompt.txt",
      attachments: captured.map(({ path, ...attachment }) => ({ ...attachment, file: basename(path) })),
    } as const;
    await writeFile(join(stagingPath, "snapshot.json"), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    await mkdir(resolve(finalPath, ".."), { recursive: true, mode: 0o700 });
    await rename(stagingPath, finalPath);
    return deepFreeze({
      schemaVersion: record.schemaVersion,
      identity: taskPromptIdentity,
      digest: snapshotDigest,
      path: finalPath,
      textPath: join(finalPath, "prompt.txt"),
      attachments: captured.map((attachment) => ({ ...attachment, path: join(finalPath, basename(attachment.path)) })),
    });
  } catch (cause) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    if (cause instanceof DeliveryBindingError) throw cause;
    throw new DeliveryBindingError("ATTACHMENT_SNAPSHOT_FAILED");
  }
}

export async function discardTaskPromptSnapshot(snapshot: ImmutableTaskPromptSnapshot): Promise<void> {
  await rm(snapshot.path, { recursive: true, force: true });
}

export interface DeliveryManifest {
  readonly schemaVersion: "execution.delivery-manifest@1.1.0";
  readonly deliveryId: string;
  readonly taskId: string;
  readonly taskDisplayName?: string;
  readonly createdAt: number;
  readonly canonicalWorktree: string;
  readonly resolvedPackage: ResolvedWorkflowPackage;
  readonly prompt: Readonly<{
    taskPromptIdentity: string;
    snapshotIdentity: string;
    snapshotDigest: string;
    snapshotPath: string;
  }>;
  readonly deliveryConfigProjection: DeliveryConfigProjection;
  readonly deliveryBindingIdentity: string;
}

export interface CreateDeliveryManifestInput {
  readonly deliveryId: string;
  readonly taskId: string;
  readonly taskDisplayName?: string;
  readonly createdAt: number;
  readonly canonicalWorktree: string;
  readonly resolvedPackage: ResolvedWorkflowPackage;
  readonly promptSnapshot: ImmutableTaskPromptSnapshot;
  readonly deliveryConfigProjection: DeliveryConfigProjection;
}

function bindingInput(input: Omit<DeliveryManifest, "schemaVersion" | "deliveryBindingIdentity">): JsonValue {
  return input as unknown as JsonValue;
}

export function createDeliveryManifest(input: CreateDeliveryManifestInput): DeliveryManifest {
  if (input.deliveryId.length === 0 || input.taskId.length === 0 || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !isAbsolute(input.canonicalWorktree) || !isAbsolute(input.resolvedPackage.localPath) || !isAbsolute(input.promptSnapshot.path)
    || !SHA256.test(input.resolvedPackage.packageDigest) || !SHA256.test(input.promptSnapshot.identity)
    || !SHA256.test(input.promptSnapshot.digest) || !SHA256.test(input.deliveryConfigProjection.identity)) {
    throw new DeliveryBindingError("DELIVERY_BINDING_INVALID");
  }
  if (input.taskDisplayName !== undefined
    && (input.taskDisplayName.length === 0 || input.taskDisplayName.length > 160
      || input.taskDisplayName.trim() !== input.taskDisplayName)) {
    throw new DeliveryBindingError("DELIVERY_BINDING_INVALID");
  }
  const content = {
    deliveryId: input.deliveryId,
    taskId: input.taskId,
    ...(input.taskDisplayName === undefined ? {} : { taskDisplayName: input.taskDisplayName }),
    createdAt: input.createdAt,
    canonicalWorktree: resolve(input.canonicalWorktree),
    resolvedPackage: input.resolvedPackage,
    prompt: {
      taskPromptIdentity: input.promptSnapshot.identity,
      snapshotIdentity: input.promptSnapshot.identity,
      snapshotDigest: input.promptSnapshot.digest,
      snapshotPath: input.promptSnapshot.path,
    },
    deliveryConfigProjection: input.deliveryConfigProjection,
  };
  return deepFreeze({
    schemaVersion: "execution.delivery-manifest@1.1.0",
    ...content,
    deliveryBindingIdentity: digestValue(bindingInput(content)),
  });
}

export interface PersistedDeliveryManifest { readonly manifest: DeliveryManifest; readonly path: string }

export class DeliveryManifestRepository {
  readonly #root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError("Delivery Manifest root must be absolute");
    this.#root = resolve(root);
  }

  async persist(manifest: DeliveryManifest): Promise<PersistedDeliveryManifest> {
    const path = join(this.#root, `${safeSegment(manifest.deliveryId)}.json`);
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
      return deepFreeze({ manifest, path });
    } catch {
      throw new DeliveryBindingError("DELIVERY_MANIFEST_PERSIST_FAILED");
    }
  }

  async load(path: string): Promise<DeliveryManifest> {
    try {
      const absolute = resolve(path);
      if (!isAbsolute(path) || resolve(absolute, "..") !== this.#root || !(await stat(absolute)).isFile()) throw new Error("invalid path");
      const candidate = JSON.parse(await readFile(absolute, "utf8")) as DeliveryManifest;
      const keys = Object.keys(candidate).sort().join(",");
      const legacy = (candidate.schemaVersion as string) === "execution.delivery-manifest@1.0.0"
        && keys === "canonicalWorktree,createdAt,deliveryBindingIdentity,deliveryConfigProjection,deliveryId,prompt,resolvedPackage,schemaVersion,taskId";
      const current = candidate.schemaVersion === "execution.delivery-manifest@1.1.0"
        && (keys === "canonicalWorktree,createdAt,deliveryBindingIdentity,deliveryConfigProjection,deliveryId,prompt,resolvedPackage,schemaVersion,taskId"
          || keys === "canonicalWorktree,createdAt,deliveryBindingIdentity,deliveryConfigProjection,deliveryId,prompt,resolvedPackage,schemaVersion,taskDisplayName,taskId");
      if (!legacy && !current) {
        throw new Error("invalid shape");
      }
      const reconstructed = createDeliveryManifest({
        deliveryId: candidate.deliveryId,
        taskId: candidate.taskId,
        ...(candidate.taskDisplayName === undefined
          ? {}
          : { taskDisplayName: candidate.taskDisplayName }),
        createdAt: candidate.createdAt,
        canonicalWorktree: candidate.canonicalWorktree,
        resolvedPackage: candidate.resolvedPackage,
        promptSnapshot: {
          schemaVersion: "execution.task-prompt-snapshot@1.0.0",
          identity: candidate.prompt.snapshotIdentity,
          digest: candidate.prompt.snapshotDigest,
          path: candidate.prompt.snapshotPath,
          textPath: join(candidate.prompt.snapshotPath, "prompt.txt"),
          attachments: [],
        },
        deliveryConfigProjection: candidate.deliveryConfigProjection,
      });
      if (reconstructed.deliveryBindingIdentity !== candidate.deliveryBindingIdentity
        || candidate.prompt.taskPromptIdentity !== candidate.prompt.snapshotIdentity) throw new Error("invalid identity");
      return reconstructed;
    } catch (cause) {
      if (cause instanceof DeliveryBindingError && cause.code === "DELIVERY_BINDING_INVALID") {
        throw new DeliveryBindingError("DELIVERY_MANIFEST_INVALID");
      }
      throw new DeliveryBindingError("DELIVERY_MANIFEST_INVALID");
    }
  }

  async discard(path: string): Promise<void> {
    const absolute = resolve(path);
    if (!isAbsolute(path) || resolve(absolute, "..") !== this.#root) throw new DeliveryBindingError("DELIVERY_MANIFEST_INVALID");
    await rm(absolute, { force: true });
  }
}
