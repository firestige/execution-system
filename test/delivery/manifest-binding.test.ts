import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AttachmentContentPort } from "../../src/bootstrap/index.js";
import type { DeliveryConfigProjection } from "../../src/configuration/index.js";
import {
  DeliveryBindingError,
  DeliveryManifestRepository,
  captureTaskPromptSnapshot,
  createDeliveryManifest,
  discardTaskPromptSnapshot,
} from "../../src/delivery/index.js";

const digest = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function projection(identity = digest("projection-a")): DeliveryConfigProjection {
  return Object.freeze({
    identity,
    value: Object.freeze({
      schemaVersion: "execution.delivery-config@1.0.0",
      paths: Object.freeze({
        repositoryRoot: "/repo",
        workspaceRoot: "/workspace",
        allowedWorktreeRoots: Object.freeze(["/repo"]),
        runnerResources: Object.freeze({ journal: "runner/journal", checkpoints: "runner/checkpoints", sessions: "runner/sessions", custody: "runner/custody" }),
      }),
      runner: Object.freeze({
        implementationKey: "runner.v1",
        host: Object.freeze({ engine: "langgraph" }),
        provider: Object.freeze({ key: "dsh", route: "deepseek", modelId: "deepseek-chat", baseUrl: "https://api.example.test", credentialRef: "PROVIDER_KEY", maxParallelToolCalls: 4 }),
      }),
      controls: Object.freeze({ executionTimeoutMs: 60_000, maxConcurrentDeliveries: 2, allowExplicitRefresh: false }),
    }),
  }) as unknown as DeliveryConfigProjection;
}

describe("M01 immutable TaskPrompt snapshot and Delivery Manifest", () => {
  it("copies attachment content only through the attachment port and excludes Intake references from durable binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "delivery-manifest-"));
    const bytes = new TextEncoder().encode("immutable attachment");
    const reads: Array<readonly [string, number]> = [];
    const attachments: AttachmentContentPort = Object.freeze({
      read: async (contentRef: string, maxBytes: number) => {
        reads.push([contentRef, maxBytes]);
        return bytes;
      },
    });
    const snapshot = await captureTaskPromptSnapshot({
      root: join(root, "snapshots"),
      deliveryId: "delivery-1",
      prompt: Object.freeze({
        text: "perform the task",
        attachments: Object.freeze([Object.freeze({
          identity: "attachment-1",
          filename: "input.txt",
          mediaType: "text/plain",
          byteLength: bytes.byteLength,
          digest: digest(bytes),
          contentRef: "opaque:intake:42",
        })]),
      }),
      attachments,
    });

    expect(reads).toEqual([["opaque:intake:42", bytes.byteLength + 1]]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(await readFile(snapshot.attachments[0]!.path, "utf8")).toBe("immutable attachment");
    expect(JSON.stringify(snapshot)).not.toContain("opaque:intake:42");

    const manifest = createDeliveryManifest({
      deliveryId: "delivery-1",
      taskId: "task-1",
      createdAt: 10,
      canonicalWorktree: "/repo/worktree-a",
      resolvedPackage: Object.freeze({ name: "system-design", exactVersion: "1.1.0", packageDigest: digest("package-a"), localPath: "/store/system-design/1.1.0", workflowId: "workflow.system-design" }),
      promptSnapshot: snapshot,
      deliveryConfigProjection: projection(),
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/opaque:intake|installationConfigIdentity|apiKey|observation/i);

    const repository = new DeliveryManifestRepository(join(root, "manifests"));
    const persisted = await repository.persist(manifest);
    expect((await repository.load(persisted.path)).deliveryBindingIdentity).toBe(manifest.deliveryBindingIdentity);
  });

  it("rejects attachment byte-length and digest mismatches without publishing a snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "delivery-snapshot-invalid-"));
    const attachments: AttachmentContentPort = Object.freeze({ read: async () => new TextEncoder().encode("wrong") });
    await expect(captureTaskPromptSnapshot({
      root,
      deliveryId: "delivery-invalid",
      prompt: Object.freeze({ text: "", attachments: Object.freeze([Object.freeze({ identity: "a", filename: "a.txt", mediaType: "text/plain", byteLength: 4, digest: digest("good"), contentRef: "opaque:a" })]) }),
      attachments,
    })).rejects.toMatchObject({ code: "ATTACHMENT_CONTENT_MISMATCH" } satisfies Partial<DeliveryBindingError>);
  });

  it("moves DeliveryBinding identity for exact Package or config projection changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "delivery-binding-movement-"));
    const snapshot = await captureTaskPromptSnapshot({
      root,
      deliveryId: "delivery-movement",
      prompt: Object.freeze({ text: "task", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }),
    });
    const base = {
      deliveryId: "delivery-movement",
      taskId: "task-movement",
      createdAt: 10,
      canonicalWorktree: "/repo/worktree-a",
      promptSnapshot: snapshot,
    } as const;
    const packageA = Object.freeze({ name: "implementation", exactVersion: "1.1.0", packageDigest: digest("package-a"), localPath: "/store/a", workflowId: "workflow.implementation" });
    const packageB = Object.freeze({ ...packageA, exactVersion: "1.2.0", packageDigest: digest("package-b"), localPath: "/store/b" });
    const first = createDeliveryManifest({ ...base, resolvedPackage: packageA, deliveryConfigProjection: projection() });
    const packageMoved = createDeliveryManifest({ ...base, resolvedPackage: packageB, deliveryConfigProjection: projection() });
    const configMoved = createDeliveryManifest({ ...base, resolvedPackage: packageA, deliveryConfigProjection: projection(digest("projection-b")) });

    expect(packageMoved.deliveryBindingIdentity).not.toBe(first.deliveryBindingIdentity);
    expect(configMoved.deliveryBindingIdentity).not.toBe(first.deliveryBindingIdentity);
  });

  it("fails closed on snapshot port errors and invalid Manifest repository operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "delivery-binding-errors-"));
    expect(() => new DeliveryManifestRepository("relative/manifests")).toThrow("root must be absolute");
    await expect(captureTaskPromptSnapshot({
      root: join(root, "snapshots"),
      deliveryId: "delivery-port-error",
      prompt: Object.freeze({ text: "", attachments: Object.freeze([Object.freeze({ identity: "a", filename: "a.txt", mediaType: "text/plain", byteLength: 1, digest: digest("a"), contentRef: "opaque:a" })]) }),
      attachments: Object.freeze({ read: async () => { throw new Error("unavailable"); } }),
    })).rejects.toMatchObject({ code: "ATTACHMENT_SNAPSHOT_FAILED" });
    await expect(captureTaskPromptSnapshot({
      root: "relative/snapshots",
      deliveryId: "delivery-invalid",
      prompt: Object.freeze({ text: "task", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => new Uint8Array() }),
    })).rejects.toMatchObject({ code: "DELIVERY_BINDING_INVALID" });

    const snapshot = await captureTaskPromptSnapshot({
      root: join(root, "snapshots"),
      deliveryId: "delivery-repository",
      prompt: Object.freeze({ text: "task", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => new Uint8Array() }),
    });
    await expect(captureTaskPromptSnapshot({
      root: join(root, "snapshots"),
      deliveryId: "delivery-repository",
      prompt: Object.freeze({ text: "task", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => new Uint8Array() }),
    })).rejects.toMatchObject({ code: "ATTACHMENT_SNAPSHOT_FAILED" });
    expect(() => createDeliveryManifest({
      deliveryId: "",
      taskId: "task",
      createdAt: -1,
      canonicalWorktree: "/repo/worktree",
      resolvedPackage: Object.freeze({ name: "demo", exactVersion: "1.0.0", packageDigest: digest("package"), localPath: "/store/demo", workflowId: "workflow.demo" }),
      promptSnapshot: snapshot,
      deliveryConfigProjection: projection(),
    })).toThrowError(expect.objectContaining({ code: "DELIVERY_BINDING_INVALID" }));

    const manifest = createDeliveryManifest({
      deliveryId: "delivery-repository",
      taskId: "task-repository",
      createdAt: 1,
      canonicalWorktree: "/repo/worktree",
      resolvedPackage: Object.freeze({ name: "demo", exactVersion: "1.0.0", packageDigest: digest("package"), localPath: "/store/demo", workflowId: "workflow.demo" }),
      promptSnapshot: snapshot,
      deliveryConfigProjection: projection(),
    });
    const repository = new DeliveryManifestRepository(join(root, "manifests"));
    const persisted = await repository.persist(manifest);
    await expect(repository.persist(manifest)).rejects.toMatchObject({ code: "DELIVERY_MANIFEST_PERSIST_FAILED" });
    await expect(repository.load("relative.json")).rejects.toMatchObject({ code: "DELIVERY_MANIFEST_INVALID" });
    await writeFile(persisted.path, JSON.stringify({ ...manifest, deliveryBindingIdentity: digest("tampered") }));
    await expect(repository.load(persisted.path)).rejects.toMatchObject({ code: "DELIVERY_MANIFEST_INVALID" });
    await expect(repository.discard(join(root, "outside.json"))).rejects.toMatchObject({ code: "DELIVERY_MANIFEST_INVALID" });
    await repository.discard(persisted.path);
    await discardTaskPromptSnapshot(snapshot);
  });
});
