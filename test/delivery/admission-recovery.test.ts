import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ImmediateConcurrencyController } from "../../src/bootstrap/index.js";
import {
  CurrentSlotRepository,
  DeliveryAdmissionService,
  DeliveryRecoveryError,
  DeliveryRecoveryService,
} from "../../src/delivery/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "delivery-admission-"));
  const slots = join(root, "current-slots");
  const manifests = join(root, "manifests");
  const worktreeA = join(root, "workspace", "a");
  const worktreeB = join(root, "workspace", "b");
  await Promise.all([mkdir(slots), mkdir(manifests), mkdir(worktreeA, { recursive: true }), mkdir(worktreeB, { recursive: true })]);
  return { root, slots, manifests, worktreeA, worktreeB };
}

describe("M01 admission and recovery", () => {
  it("admits different worktrees concurrently and returns immediate CONTENDED for one live worktree", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true }));
    const service = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(2));
    await service.start();
    const a = await service.admit(f.worktreeA);
    const contended = await service.admit(f.worktreeA);
    const b = await service.admit(f.worktreeB);
    expect(a.kind).toBe("NEW");
    expect(contended).toMatchObject({ kind: "CONTENDED", worktree: f.worktreeA });
    expect(b.kind).toBe("NEW");
    if (a.kind === "NEW") await a.holder.release();
    if (b.kind === "NEW") await b.holder.release();
  });

  it("returns BUSY at the installation bound without queuing", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true }));
    const service = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(1));
    await service.start();
    const first = await service.admit(f.worktreeA);
    expect((await service.admit(f.worktreeB)).kind).toBe("BUSY");
    if (first.kind === "NEW") await first.holder.release();
    const second = await service.admit(f.worktreeB);
    expect(second.kind).toBe("NEW");
    if (second.kind === "NEW") await second.holder.release();
  });

  it("cancels pre-Delivery work, runs best-effort cleanup, and creates no Delivery outcome", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true }));
    const service = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(1));
    await service.start();
    const admitted = await service.admit(f.worktreeA);
    expect(admitted.kind).toBe("NEW");
    if (admitted.kind !== "NEW") return;
    const cleaned: string[] = [];
    admitted.holder.ownPreDeliveryResource(Object.freeze({ cleanup: async () => { cleaned.push("staging"); throw new Error("best effort"); } }));
    const cancelled = await service.cancelPreDelivery(admitted.holder.admissionId);
    expect(cancelled).toEqual({ kind: "PRE_DELIVERY_CANCELLED", worktree: f.worktreeA, admissionId: admitted.holder.admissionId });
    expect(cleaned).toEqual(["staging"]);
    expect(admitted.holder.cancellation.cancelled).toBe(true);
    expect(cancelled).not.toHaveProperty("outcome");
    expect(cancelled).not.toHaveProperty("deliveryId");
    expect(await repository.read(f.worktreeA)).toEqual({ state: "EMPTY", worktree: f.worktreeA });
    const next = await service.admit(f.worktreeA);
    expect(next.kind).toBe("NEW");
    if (next.kind === "NEW") await next.holder.release();
  });

  it("distinguishes process death before and after persisted binding", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true }));
    const firstProcess = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(2));
    await firstProcess.start();
    const preManifest = await firstProcess.admit(f.worktreeA);
    expect(preManifest.kind).toBe("NEW");

    const afterPreManifestDeath = new DeliveryAdmissionService(
      new CurrentSlotRepository(f.slots),
      new DeliveryRecoveryService(new CurrentSlotRepository(f.slots), Object.freeze({ verify: async () => true })),
      new ImmediateConcurrencyController(2),
    );
    await afterPreManifestDeath.start();
    const newAgain = await afterPreManifestDeath.admit(f.worktreeA);
    expect(newAgain.kind).toBe("NEW");
    if (newAgain.kind === "NEW") await newAgain.holder.release();

    const manifestPath = join(f.manifests, "delivery-1.json");
    await writeFile(manifestPath, "{}");
    await repository.persistBound({
      worktree: f.worktreeB,
      deliveryId: "delivery-1",
      manifestPath,
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    const verify = vi.fn(async () => true);
    const afterPersistedDeath = new DeliveryAdmissionService(
      new CurrentSlotRepository(f.slots),
      new DeliveryRecoveryService(new CurrentSlotRepository(f.slots), Object.freeze({ verify })),
      new ImmediateConcurrencyController(2),
    );
    await afterPersistedDeath.start();
    expect(await afterPersistedDeath.admit(f.worktreeB)).toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-1", state: "BOUND" });
    expect(verify).toHaveBeenCalledOnce();
  });

  it("fails startup closed when persisted binding verification fails", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    await repository.persistBound({
      worktree: f.worktreeA,
      deliveryId: "delivery-1",
      manifestPath: join(f.manifests, "missing.json"),
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => false }));
    const service = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(2));
    await expect(service.start()).rejects.toBeInstanceOf(DeliveryRecoveryError);
    await expect(service.admit(f.worktreeA)).rejects.toMatchObject({ code: "DELIVERY_ADMISSION_NOT_READY" });
  });

  it("refreshes recovery disposition from current slot transitions and releases cleared truth", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    await repository.persistBound({
      worktree: f.worktreeA,
      deliveryId: "delivery-1",
      manifestPath: join(f.manifests, "delivery-1.json"),
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true }));
    const service = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(2));
    await service.start();
    await repository.transition(f.worktreeA, "M01_RUNNER_LAUNCH_REQUESTED", 2);
    expect(await service.admit(f.worktreeA)).toMatchObject({ kind: "RECOVERY", state: "START_UNCERTAIN" });
    await repository.transition(f.worktreeA, "ADMINISTRATIVE_CLOSE", 3, { authorization: "delivery-1" });
    const admitted = await service.admit(f.worktreeA);
    expect(admitted.kind).toBe("NEW");
    if (admitted.kind === "NEW") await admitted.holder.release();
  });

  it("fails pre-Delivery cancellation closed once binding persistence has begun", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    const originalPersist = repository.persistBound.bind(repository);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(repository, "persistBound").mockImplementation(async (input) => {
      await gate;
      return originalPersist(input);
    });
    const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true }));
    const service = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(2));
    await service.start();
    const admitted = await service.admit(f.worktreeA);
    expect(admitted.kind).toBe("NEW");
    if (admitted.kind !== "NEW") return;
    const binding = admitted.holder.persistBinding({
      deliveryId: "delivery-1",
      manifestPath: join(f.manifests, "delivery-1.json"),
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    await expect(service.cancelPreDelivery(admitted.holder.admissionId))
      .rejects.toMatchObject({ code: "PRE_DELIVERY_ALREADY_BOUND" });
    unblock();
    await expect(binding).resolves.toMatchObject({ state: "BOUND" });
    await admitted.holder.release();
  });

  it("counts recovered and newly persisted Deliveries against installation concurrency until slot clear", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    const recovery = new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true }));
    const service = new DeliveryAdmissionService(repository, recovery, new ImmediateConcurrencyController(1));
    await service.start();
    const admitted = await service.admit(f.worktreeA);
    expect(admitted.kind).toBe("NEW");
    if (admitted.kind !== "NEW") return;
    await admitted.holder.persistBinding({
      deliveryId: "delivery-1",
      manifestPath: join(f.manifests, "delivery-1.json"),
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    await admitted.holder.release();
    expect(await service.admit(f.worktreeB)).toMatchObject({ kind: "BUSY" });
    await repository.transition(f.worktreeA, "ADMINISTRATIVE_CLOSE", 2, { authorization: "delivery-1" });
    const afterClear = await service.admit(f.worktreeB);
    expect(afterClear.kind).toBe("NEW");
    if (afterClear.kind === "NEW") await afterClear.holder.release();

    await repository.persistBound({
      worktree: f.worktreeA,
      deliveryId: "delivery-2",
      manifestPath: join(f.manifests, "delivery-2.json"),
      deliveryBindingIdentity: `sha256:${"c".repeat(64)}`,
      updatedAt: 3,
    });
    const restarted = new DeliveryAdmissionService(
      repository,
      new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true })),
      new ImmediateConcurrencyController(1),
    );
    await restarted.start();
    expect(await restarted.admit(f.worktreeB)).toMatchObject({ kind: "BUSY" });
  });

  it("fails startup closed when recovered Deliveries exceed installation concurrency", async () => {
    const f = await fixture();
    const repository = new CurrentSlotRepository(f.slots);
    for (const [worktree, deliveryId, suffix] of [
      [f.worktreeA, "delivery-1", "b"],
      [f.worktreeB, "delivery-2", "c"],
    ] as const) {
      await repository.persistBound({
        worktree,
        deliveryId,
        manifestPath: join(f.manifests, `${deliveryId}.json`),
        deliveryBindingIdentity: `sha256:${suffix.repeat(64)}`,
        updatedAt: 1,
      });
    }
    const service = new DeliveryAdmissionService(
      repository,
      new DeliveryRecoveryService(repository, Object.freeze({ verify: async () => true })),
      new ImmediateConcurrencyController(1),
    );
    const failure = await service.start().catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: "DELIVERY_RECOVERY_CAPACITY_EXCEEDED" });
    expect([f.worktreeA, f.worktreeB]).toContain((failure as { worktree: string }).worktree);
    await expect(service.admit(f.worktreeA)).rejects.toMatchObject({ code: "DELIVERY_ADMISSION_NOT_READY" });
  });
});
