import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IntakeSessionBindingRepository } from "../../packages/dsh-intake/src/index.js";

const fixture = path.resolve(import.meta.dirname, "../fixtures/dsh-intake-signal-child.mjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function start(root: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [fixture, root], { cwd: path.resolve(import.meta.dirname, "../.."), shell: false });
}

async function ready(child: ChildProcessWithoutNullStreams): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("READY\n")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`child exited before READY: ${code ?? signal}`)));
  });
}

async function binding(root: string) {
  const repository = new IntakeSessionBindingRepository(path.join(root, "bindings.json"));
  await repository.start();
  return repository.bySession("session-signal");
}

describe("DSH Intake process boundary", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("lets the host map %s to bounded close without rewriting Delivery truth", async (signal) => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-signal-"));
    roots.push(root);
    const child = start(root);
    await ready(child);

    expect(child.kill(signal)).toBe(true);
    const [code, exitSignal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

    expect({ code, exitSignal }).toEqual({ code: 0, exitSignal: null });
    expect(JSON.parse(await readFile(path.join(root, "close.json"), "utf8"))).toEqual({
      signal, closeCalls: 1, cancelCalls: 0,
    });
    await expect(binding(root)).resolves.toMatchObject({ deliveryId: "delivery-signal", state: "BOUND" });
  }, 30_000);

  it("recovers the durable binding after abrupt process death without requiring cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-intake-abrupt-"));
    roots.push(root);
    const child = start(root);
    await ready(child);

    expect(child.kill("SIGKILL")).toBe(true);
    const [code, exitSignal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

    expect({ code, exitSignal }).toEqual({ code: null, exitSignal: "SIGKILL" });
    await expect(access(path.join(root, "close.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(binding(root)).resolves.toMatchObject({ deliveryId: "delivery-signal", state: "BOUND" });
  }, 30_000);
});
