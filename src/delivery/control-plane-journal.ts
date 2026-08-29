import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { DeliveryProjectionCompleted } from "./control-plane-projection.js";

function filename(deliveryId: string): string {
  return `${createHash("sha256").update(deliveryId, "utf8").digest("hex")}.json`;
}

/** Internal durable materialization of lifecycle-completed facts; it is never an execution authority. */
export class DeliveryCompletedFactJournal {
  readonly #root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError("Delivery completed-fact root must be absolute");
    this.#root = resolve(root);
  }

  async persist(fact: DeliveryProjectionCompleted): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const destination = join(this.#root, filename(fact.manifest.deliveryId));
    const temporary = `${destination}.${randomUUID()}.candidate`;
    try {
      await writeFile(temporary, `${JSON.stringify(fact)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
  }

  async enumerateCompleted(): Promise<readonly DeliveryProjectionCompleted[]> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const values: DeliveryProjectionCompleted[] = [];
    for (const entry of (await readdir(this.#root)).filter((value) => value.endsWith(".json")).sort()) {
      try {
        const value = JSON.parse(await readFile(join(this.#root, entry), "utf8")) as DeliveryProjectionCompleted;
        if (filename(value.manifest.deliveryId) !== entry) throw new Error("identity mismatch");
        values.push(Object.freeze(value));
      } catch {
        throw new DeliveryProjectionJournalError();
      }
    }
    return Object.freeze(values);
  }
}

export class DeliveryProjectionJournalError extends Error {
  readonly code = "DELIVERY_PROJECTION_JOURNAL_CORRUPT";
  constructor() { super("DELIVERY_PROJECTION_JOURNAL_CORRUPT"); this.name = "DeliveryProjectionJournalError"; }
}
