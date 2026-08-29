import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type DeliveryProjectionCompleted } from "../../src/delivery/index.js";
import { DeliveryCompletedFactJournal, DeliveryProjectionJournalError } from "../../src/delivery/control-plane-journal.js";

const sha = (character: string) => `sha256:${character.repeat(64)}`;

function fact(): DeliveryProjectionCompleted {
  return Object.freeze({
    schemaVersion: "execution.delivery-completed@1.0.0",
    manifest: Object.freeze({
      deliveryId: "delivery-reload",
      taskId: "task-reload",
      createdAt: 100,
      canonicalWorktree: "/workspace/reload",
      deliveryBindingIdentity: sha("a"),
      workflow: Object.freeze({ identity: "workflow.reload", packageName: "reload", exactPackageVersion: "1.0.0", packageDigest: sha("b"), snapshotIdentity: sha("c"), snapshotDigest: sha("d") }),
    }),
    updatedAt: 180,
    terminal: Object.freeze({ outcome: "FAILED", finishedAt: 180 }),
    error: Object.freeze({ code: "INCOMPLETE" }),
    sessionCorrelation: "conversation-reload",
  });
}

describe("Delivery completed-fact journal", () => {
  it("atomically survives reload with the exact terminal lifecycle fact", async () => {
    const root = await mkdtemp(join(tmpdir(), "delivery-completed-"));
    await new DeliveryCompletedFactJournal(root).persist(fact());
    const reloaded = await new DeliveryCompletedFactJournal(root).enumerateCompleted();
    expect(reloaded).toEqual([fact()]);
  });

  it("fails closed when an unknown or corrupt record appears", async () => {
    const root = await mkdtemp(join(tmpdir(), "delivery-completed-corrupt-"));
    await writeFile(join(root, "unexpected.json"), "{ corrupt");
    await expect(new DeliveryCompletedFactJournal(root).enumerateCompleted()).rejects.toBeInstanceOf(DeliveryProjectionJournalError);
  });
});
