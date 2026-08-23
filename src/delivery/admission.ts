import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ImmediateConcurrencyController } from "../bootstrap/index.js";
import type { OccupiedCurrentSlot, PersistBoundInput } from "./current-slot.js";
import { CurrentSlotRepository } from "./current-slot.js";

export interface DeliveryRecoveryVerifier { verify(slot: OccupiedCurrentSlot): Promise<boolean> }

export class DeliveryRecoveryError extends Error {
  readonly code = "DELIVERY_RECOVERY_INVALID";
  constructor(readonly worktree: string) {
    super("DELIVERY_RECOVERY_INVALID: persisted Delivery binding could not be verified");
    this.name = "DeliveryRecoveryError";
  }
}

export class DeliveryRecoveryCapacityError extends Error {
  readonly code = "DELIVERY_RECOVERY_CAPACITY_EXCEEDED";
  constructor(readonly worktree: string) {
    super("DELIVERY_RECOVERY_CAPACITY_EXCEEDED: persisted Deliveries exceed installation concurrency");
    this.name = "DeliveryRecoveryCapacityError";
  }
}

export class DeliveryAdmissionError extends Error {
  constructor(readonly code: "DELIVERY_ADMISSION_NOT_READY" | "PRE_DELIVERY_ADMISSION_UNKNOWN" | "PRE_DELIVERY_ALREADY_BOUND") {
    super(code);
    this.name = "DeliveryAdmissionError";
  }
}

export interface DeliveryRecoveryDisposition {
  readonly kind: "RECOVERY";
  readonly worktree: string;
  readonly deliveryId: string;
  readonly state: OccupiedCurrentSlot["state"];
  readonly slot: OccupiedCurrentSlot;
}

export class DeliveryRecoveryService {
  readonly #slots = new Map<string, OccupiedCurrentSlot>();
  constructor(readonly repository: CurrentSlotRepository, readonly verifier: DeliveryRecoveryVerifier) {}

  async establish(): Promise<readonly DeliveryRecoveryDisposition[]> {
    const records = await this.repository.enumerate();
    const dispositions: DeliveryRecoveryDisposition[] = [];
    for (const record of records) {
      let verified = false;
      try { verified = await this.verifier.verify(record); } catch { verified = false; }
      if (!verified) throw new DeliveryRecoveryError(record.worktree);
      this.#slots.set(record.worktree, record);
      dispositions.push(this.#disposition(record));
    }
    return Object.freeze(dispositions);
  }

  async lookup(worktree: string): Promise<DeliveryRecoveryDisposition | undefined> {
    const established = this.#slots.get(worktree);
    if (established === undefined) return undefined;
    const current = await this.repository.read(worktree);
    if (current.state === "EMPTY") {
      this.#slots.delete(worktree);
      return undefined;
    }
    if (current.deliveryId !== established.deliveryId
      || current.deliveryBindingIdentity !== established.deliveryBindingIdentity
      || current.manifestPath !== established.manifestPath) throw new DeliveryRecoveryError(worktree);
    this.#slots.set(worktree, current);
    return this.#disposition(current);
  }

  register(slot: OccupiedCurrentSlot): void { this.#slots.set(slot.worktree, slot); }
  remove(worktree: string): void { this.#slots.delete(worktree); }

  #disposition(slot: OccupiedCurrentSlot): DeliveryRecoveryDisposition {
    return Object.freeze({ kind: "RECOVERY", worktree: slot.worktree, deliveryId: slot.deliveryId, state: slot.state, slot });
  }
}

export interface PreDeliveryResource { cleanup(): Promise<void> }
export interface PreDeliveryCancellationSignal { readonly cancelled: boolean }

export interface DeliveryAdmissionHolder {
  readonly admissionId: string;
  readonly worktree: string;
  readonly cancellation: PreDeliveryCancellationSignal;
  ownPreDeliveryResource(resource: PreDeliveryResource): void;
  persistBinding(input: Omit<PersistBoundInput, "worktree">): Promise<OccupiedCurrentSlot>;
  release(): Promise<void>;
}

export type DeliveryAdmissionResult =
  | Readonly<{ kind: "NEW"; holder: DeliveryAdmissionHolder }>
  | Readonly<{ kind: "CONTENDED"; worktree: string; admissionId: string }>
  | DeliveryRecoveryDisposition
  | Readonly<{ kind: "BUSY"; worktree: string }>;

export interface PreDeliveryCancelled {
  readonly kind: "PRE_DELIVERY_CANCELLED";
  readonly worktree: string;
  readonly admissionId: string;
}

interface LiveAdmission {
  readonly admissionId: string;
  readonly worktree: string;
  readonly releaseConcurrency: () => void;
  readonly resources: PreDeliveryResource[];
  cancelled: boolean;
  binding: boolean;
  persisted: boolean;
  concurrencyTransferred: boolean;
  released: boolean;
}

export class DeliveryAdmissionService {
  readonly #liveByWorktree = new Map<string, LiveAdmission>();
  readonly #liveById = new Map<string, LiveAdmission>();
  readonly #occupiedConcurrency = new Map<string, () => void>();
  #state: "CREATED" | "READY" | "FAILED" = "CREATED";

  constructor(
    readonly repository: CurrentSlotRepository,
    readonly recovery: DeliveryRecoveryService,
    readonly concurrency: ImmediateConcurrencyController,
  ) {}

  async start(): Promise<readonly DeliveryRecoveryDisposition[]> {
    if (this.#state === "READY") return Object.freeze([]);
    try {
      const dispositions = await this.recovery.establish();
      const acquired: Array<readonly [string, () => void]> = [];
      for (const disposition of dispositions) {
        const concurrency = this.concurrency.tryAcquire();
        if (concurrency.kind === "BUSY") {
          for (const [, release] of acquired) release();
          throw new DeliveryRecoveryCapacityError(disposition.worktree);
        }
        acquired.push(Object.freeze([disposition.worktree, concurrency.release]));
      }
      for (const [worktree, release] of acquired) this.#occupiedConcurrency.set(worktree, release);
      this.#state = "READY";
      return dispositions;
    } catch (cause) {
      this.#state = "FAILED";
      throw cause;
    }
  }

  async admit(worktree: string): Promise<DeliveryAdmissionResult> {
    if (this.#state !== "READY") throw new DeliveryAdmissionError("DELIVERY_ADMISSION_NOT_READY");
    if (!isAbsolute(worktree)) throw new TypeError("admission worktree must be canonical and absolute");
    await this.#releaseClearedConcurrency();
    const recovered = await this.recovery.lookup(worktree);
    if (recovered !== undefined) return recovered;
    const existing = this.#liveByWorktree.get(worktree);
    if (existing !== undefined) return Object.freeze({ kind: "CONTENDED", worktree, admissionId: existing.admissionId });
    const concurrency = this.concurrency.tryAcquire();
    if (concurrency.kind === "BUSY") return Object.freeze({ kind: "BUSY", worktree });
    const live: LiveAdmission = {
      admissionId: `admission-${randomUUID()}`,
      worktree,
      releaseConcurrency: concurrency.release,
      resources: [],
      cancelled: false,
      binding: false,
      persisted: false,
      concurrencyTransferred: false,
      released: false,
    };
    this.#liveByWorktree.set(worktree, live);
    this.#liveById.set(live.admissionId, live);
    return Object.freeze({ kind: "NEW", holder: this.#holder(live) });
  }

  async cancelPreDelivery(admissionId: string): Promise<PreDeliveryCancelled> {
    const live = this.#liveById.get(admissionId);
    if (live === undefined) throw new DeliveryAdmissionError("PRE_DELIVERY_ADMISSION_UNKNOWN");
    if (live.binding || live.persisted) throw new DeliveryAdmissionError("PRE_DELIVERY_ALREADY_BOUND");
    live.cancelled = true;
    await this.#release(live);
    return Object.freeze({ kind: "PRE_DELIVERY_CANCELLED", worktree: live.worktree, admissionId });
  }

  #holder(live: LiveAdmission): DeliveryAdmissionHolder {
    const signal = Object.freeze({ get cancelled() { return live.cancelled; } });
    return Object.freeze({
      admissionId: live.admissionId,
      worktree: live.worktree,
      cancellation: signal,
      ownPreDeliveryResource: (resource: PreDeliveryResource) => {
        if (live.released || live.binding || live.persisted) throw new DeliveryAdmissionError("PRE_DELIVERY_ALREADY_BOUND");
        if (resource === null || typeof resource !== "object" || typeof resource.cleanup !== "function") throw new TypeError("pre-Delivery cleanup resource is invalid");
        live.resources.push(resource);
      },
      persistBinding: async (input: Omit<PersistBoundInput, "worktree">) => {
        if (live.released || live.binding || live.persisted || live.cancelled) throw new DeliveryAdmissionError("PRE_DELIVERY_ALREADY_BOUND");
        live.binding = true;
        try {
          const slot = await this.repository.persistBound({ ...input, worktree: live.worktree });
          live.persisted = true;
          live.resources.length = 0;
          this.recovery.register(slot);
          this.#occupiedConcurrency.set(live.worktree, live.releaseConcurrency);
          live.concurrencyTransferred = true;
          return slot;
        } finally {
          live.binding = false;
        }
      },
      release: async () => { await this.#release(live); },
    });
  }

  async #release(live: LiveAdmission): Promise<void> {
    if (live.released) return;
    if (live.binding) throw new DeliveryAdmissionError("PRE_DELIVERY_ALREADY_BOUND");
    live.released = true;
    if (!live.persisted) {
      for (const resource of live.resources.reverse()) await resource.cleanup().catch(() => undefined);
    }
    live.resources.length = 0;
    this.#liveByWorktree.delete(live.worktree);
    this.#liveById.delete(live.admissionId);
    if (!live.concurrencyTransferred) live.releaseConcurrency();
  }

  async #releaseClearedConcurrency(): Promise<void> {
    for (const [worktree, release] of this.#occupiedConcurrency) {
      if (await this.recovery.lookup(worktree) !== undefined) continue;
      this.#occupiedConcurrency.delete(worktree);
      release();
    }
  }
}
