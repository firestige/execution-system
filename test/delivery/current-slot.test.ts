import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CURRENT_SLOT_TRANSITIONS,
  CurrentSlotRepository,
  CurrentSlotTransitionError,
} from "../../src/delivery/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "current-slot-"));
  const worktree = join(root, "workspace", "feature");
  const manifestPath = join(root, "manifests", "delivery-1.json");
  const slots = join(root, "current-slots");
  await Promise.all([mkdir(worktree, { recursive: true }), mkdir(join(root, "manifests"), { recursive: true }), mkdir(slots)]);
  return { worktree, manifestPath, repository: new CurrentSlotRepository(slots) };
}

describe("M01 current-slot state machine", () => {
  it("freezes every authorized state/result/owner edge", () => {
    expect(CURRENT_SLOT_TRANSITIONS).toEqual({
      M01_RUNNER_LAUNCH_REQUESTED: { owner: "M01", from: ["BOUND"], to: "START_UNCERTAIN" },
      M02_START_CORRELATED: { owner: "M02_FACT", from: ["START_UNCERTAIN"], to: "RUNNING_CORRELATED" },
      M02_START_FAILED: { owner: "M02_FACT", from: ["START_UNCERTAIN"], to: "START_FAILED" },
      M02_RESULT_UNRESOLVED: { owner: "M02_FACT", from: ["RUNNING_CORRELATED"], to: "RESULT_UNRESOLVED" },
      M02_TERMINAL_VALIDATED: { owner: "M02_FACT", from: ["RUNNING_CORRELATED"], to: "TERMINAL_HANDLING" },
      M02_RECONCILED_RUNNING: { owner: "M02_FACT", from: ["RESULT_UNRESOLVED"], to: "RUNNING_CORRELATED" },
      M02_RECONCILED_TERMINAL: { owner: "M02_FACT", from: ["RESULT_UNRESOLVED"], to: "TERMINAL_HANDLING" },
      M01_START_FAILURE_HANDLED: { owner: "M01", from: ["START_FAILED"], to: "EMPTY" },
      M01_TERMINAL_HANDLING_COMPLETE: { owner: "M01", from: ["TERMINAL_HANDLING"], to: "EMPTY" },
      ADMINISTRATIVE_CLOSE: { owner: "ADMINISTRATION", from: ["BOUND", "START_UNCERTAIN", "RUNNING_CORRELATED", "START_FAILED", "RESULT_UNRESOLVED", "TERMINAL_HANDLING"], to: "EMPTY" },
    });
    expect(Object.isFrozen(CURRENT_SLOT_TRANSITIONS)).toBe(true);
  });

  it("persists BOUND and follows valid edges until clear-before-release", async () => {
    const f = await fixture();
    await f.repository.persistBound({
      worktree: f.worktree,
      deliveryId: "delivery-1",
      manifestPath: f.manifestPath,
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    expect(await f.repository.read(f.worktree)).toMatchObject({ state: "BOUND", deliveryId: "delivery-1" });
    expect(await f.repository.transition(f.worktree, "M01_RUNNER_LAUNCH_REQUESTED", 2)).toMatchObject({ state: "START_UNCERTAIN" });
    expect(await f.repository.transition(f.worktree, "M02_START_CORRELATED", 3)).toMatchObject({ state: "RUNNING_CORRELATED" });
    expect(await f.repository.transition(f.worktree, "M02_RESULT_UNRESOLVED", 4, {
      diagnostic: { stage: "HOST_START", causeCode: "CHECKPOINT_ORDER_VIOLATION" },
    })).toMatchObject({
      state: "RESULT_UNRESOLVED",
      diagnostic: { stage: "HOST_START", causeCode: "CHECKPOINT_ORDER_VIOLATION" },
    });
    expect(await f.repository.read(f.worktree)).toMatchObject({
      state: "RESULT_UNRESOLVED",
      diagnostic: { stage: "HOST_START", causeCode: "CHECKPOINT_ORDER_VIOLATION" },
    });
    expect(await f.repository.transition(f.worktree, "M02_RECONCILED_TERMINAL", 5)).toMatchObject({ state: "TERMINAL_HANDLING" });
    expect(await f.repository.transition(f.worktree, "M01_TERMINAL_HANDLING_COMPLETE", 6)).toEqual({ state: "EMPTY", worktree: f.worktree });
    expect(await f.repository.read(f.worktree)).toEqual({ state: "EMPTY", worktree: f.worktree });
  });

  it("fails closed on an unbounded or misplaced public diagnostic", async () => {
    const f = await fixture();
    await f.repository.persistBound({
      worktree: f.worktree, deliveryId: "delivery-1", manifestPath: f.manifestPath,
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`, updatedAt: 1,
    });
    await f.repository.transition(f.worktree, "M01_RUNNER_LAUNCH_REQUESTED", 2);
    await expect(f.repository.transition(f.worktree, "M02_START_CORRELATED", 3, {
      diagnostic: { stage: "HOST_START", causeCode: "GIT_STATE_MISMATCH" },
    } as any)).rejects.toMatchObject({ code: "CURRENT_SLOT_TRANSITION_INVALID" });
    await f.repository.transition(f.worktree, "M02_START_CORRELATED", 3);
    await expect(f.repository.transition(f.worktree, "M02_RESULT_UNRESOLVED", 4, {
      diagnostic: { stage: "host start", causeCode: "secret/path" },
    } as any)).rejects.toMatchObject({ code: "CURRENT_SLOT_TRANSITION_INVALID" });
  });

  it("rejects invalid edges, duplicate binding, and mismatched administrative authority", async () => {
    const f = await fixture();
    const binding = {
      worktree: f.worktree,
      deliveryId: "delivery-1",
      manifestPath: f.manifestPath,
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    } as const;
    await f.repository.persistBound(binding);
    await expect(f.repository.persistBound(binding)).rejects.toBeInstanceOf(CurrentSlotTransitionError);
    await expect(f.repository.transition(f.worktree, "M02_TERMINAL_VALIDATED", 2)).rejects.toMatchObject({ code: "CURRENT_SLOT_TRANSITION_INVALID" });
    await expect(f.repository.transition(f.worktree, "ADMINISTRATIVE_CLOSE", 2, { authorization: "wrong-delivery" }))
      .rejects.toMatchObject({ code: "CURRENT_SLOT_AUTHORIZATION_INVALID" });
    expect(await f.repository.transition(f.worktree, "ADMINISTRATIVE_CLOSE", 3, { authorization: "delivery-1" }))
      .toEqual({ state: "EMPTY", worktree: f.worktree });
  });

  it.each([
    ["BOUND", []],
    ["START_UNCERTAIN", ["M01_RUNNER_LAUNCH_REQUESTED"]],
    ["RUNNING_CORRELATED", ["M01_RUNNER_LAUNCH_REQUESTED", "M02_START_CORRELATED"]],
    ["START_FAILED", ["M01_RUNNER_LAUNCH_REQUESTED", "M02_START_FAILED"]],
    ["RESULT_UNRESOLVED", ["M01_RUNNER_LAUNCH_REQUESTED", "M02_START_CORRELATED", "M02_RESULT_UNRESOLVED"]],
    ["TERMINAL_HANDLING", ["M01_RUNNER_LAUNCH_REQUESTED", "M02_START_CORRELATED", "M02_TERMINAL_VALIDATED"]],
  ] as const)("administratively closes an occupied %s slot", async (state, transitions) => {
    const f = await fixture();
    await f.repository.persistBound({
      worktree: f.worktree,
      deliveryId: "delivery-1",
      manifestPath: f.manifestPath,
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    for (const [index, transition] of transitions.entries()) {
      await f.repository.transition(f.worktree, transition, index + 2);
    }
    expect(await f.repository.read(f.worktree)).toMatchObject({ state });
    await expect(f.repository.transition(f.worktree, "ADMINISTRATIVE_CLOSE", 20, { authorization: "delivery-1" }))
      .resolves.toEqual({ state: "EMPTY", worktree: f.worktree });
  });

  it("enumerates one occupied slot per canonical worktree and fails closed on corrupt truth", async () => {
    const f = await fixture();
    await f.repository.persistBound({
      worktree: f.worktree,
      deliveryId: "delivery-1",
      manifestPath: f.manifestPath,
      deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    expect(await f.repository.enumerate()).toHaveLength(1);
    const root = (await readdir(join(f.worktree, "..", "..", "current-slots")))[0];
    expect(root).toBeDefined();
    await writeFile(join(f.worktree, "..", "..", "current-slots", root!), "{ corrupt");
    await expect(f.repository.enumerate()).rejects.toMatchObject({ code: "CURRENT_SLOT_CORRUPT" });
  });

  it("fails closed for invalid roots, missing slots, and duplicate Delivery identities", async () => {
    expect(() => new CurrentSlotRepository("relative/current-slots")).toThrow("current-slot root must be absolute");
    const f = await fixture();
    await expect(f.repository.read("relative-worktree")).rejects.toMatchObject({ code: "CURRENT_SLOT_CORRUPT" });
    await expect(f.repository.transition(f.worktree, "M01_RUNNER_LAUNCH_REQUESTED", 1))
      .rejects.toMatchObject({ code: "CURRENT_SLOT_MISSING" });
    const secondWorktree = join(f.worktree, "..", "second");
    await mkdir(secondWorktree, { recursive: true });
    for (const worktree of [f.worktree, secondWorktree]) {
      await f.repository.persistBound({
        worktree,
        deliveryId: "duplicate-delivery",
        manifestPath: f.manifestPath,
        deliveryBindingIdentity: `sha256:${"b".repeat(64)}`,
        updatedAt: 1,
      });
    }
    await expect(f.repository.enumerate()).rejects.toMatchObject({ code: "CURRENT_SLOT_CORRUPT", worktree: "duplicate" });
  });
});
