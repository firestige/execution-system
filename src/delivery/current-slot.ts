import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type CurrentSlotState =
  | "BOUND"
  | "START_UNCERTAIN"
  | "RUNNING_CORRELATED"
  | "START_FAILED"
  | "RESULT_UNRESOLVED"
  | "TERMINAL_HANDLING";

export interface OccupiedCurrentSlot {
  readonly schemaVersion: "execution.current-slot@2.0.0";
  readonly state: CurrentSlotState;
  readonly worktree: string;
  readonly deliveryId: string;
  readonly manifestPath: string;
  readonly deliveryBindingIdentity: string;
  readonly updatedAt: number;
  readonly diagnostic: Readonly<{ readonly stage: string; readonly causeCode: string }> | null;
}

export interface EmptyCurrentSlot { readonly state: "EMPTY"; readonly worktree: string }
export type CurrentSlotView = OccupiedCurrentSlot | EmptyCurrentSlot;

export type CurrentSlotTransition =
  | "M01_RUNNER_LAUNCH_REQUESTED"
  | "M02_START_CORRELATED"
  | "M02_START_FAILED"
  | "M02_RESULT_UNRESOLVED"
  | "M02_TERMINAL_VALIDATED"
  | "M02_RECONCILED_RUNNING"
  | "M02_RECONCILED_TERMINAL"
  | "M01_START_FAILURE_HANDLED"
  | "M01_TERMINAL_HANDLING_COMPLETE"
  | "ADMINISTRATIVE_CLOSE";

interface TransitionDefinition {
  readonly owner: "M01" | "M02_FACT" | "ADMINISTRATION";
  readonly from: readonly CurrentSlotState[];
  readonly to: CurrentSlotState | "EMPTY";
}

function freezeTransition(definition: TransitionDefinition): TransitionDefinition {
  return Object.freeze({ ...definition, from: Object.freeze([...definition.from]) });
}

export const CURRENT_SLOT_TRANSITIONS: Readonly<Record<CurrentSlotTransition, TransitionDefinition>> = Object.freeze({
  M01_RUNNER_LAUNCH_REQUESTED: freezeTransition({ owner: "M01", from: ["BOUND"], to: "START_UNCERTAIN" }),
  M02_START_CORRELATED: freezeTransition({ owner: "M02_FACT", from: ["START_UNCERTAIN"], to: "RUNNING_CORRELATED" }),
  M02_START_FAILED: freezeTransition({ owner: "M02_FACT", from: ["START_UNCERTAIN"], to: "START_FAILED" }),
  M02_RESULT_UNRESOLVED: freezeTransition({ owner: "M02_FACT", from: ["RUNNING_CORRELATED"], to: "RESULT_UNRESOLVED" }),
  M02_TERMINAL_VALIDATED: freezeTransition({ owner: "M02_FACT", from: ["RUNNING_CORRELATED"], to: "TERMINAL_HANDLING" }),
  M02_RECONCILED_RUNNING: freezeTransition({ owner: "M02_FACT", from: ["RESULT_UNRESOLVED"], to: "RUNNING_CORRELATED" }),
  M02_RECONCILED_TERMINAL: freezeTransition({ owner: "M02_FACT", from: ["RESULT_UNRESOLVED"], to: "TERMINAL_HANDLING" }),
  M01_START_FAILURE_HANDLED: freezeTransition({ owner: "M01", from: ["START_FAILED"], to: "EMPTY" }),
  M01_TERMINAL_HANDLING_COMPLETE: freezeTransition({ owner: "M01", from: ["TERMINAL_HANDLING"], to: "EMPTY" }),
  ADMINISTRATIVE_CLOSE: freezeTransition({
    owner: "ADMINISTRATION",
    from: ["BOUND", "START_UNCERTAIN", "RUNNING_CORRELATED", "START_FAILED", "RESULT_UNRESOLVED", "TERMINAL_HANDLING"],
    to: "EMPTY",
  }),
});

export type CurrentSlotErrorCode =
  | "CURRENT_SLOT_ALREADY_OCCUPIED"
  | "CURRENT_SLOT_MISSING"
  | "CURRENT_SLOT_TRANSITION_INVALID"
  | "CURRENT_SLOT_AUTHORIZATION_INVALID"
  | "CURRENT_SLOT_CORRUPT";

export class CurrentSlotTransitionError extends Error {
  constructor(readonly code: CurrentSlotErrorCode, readonly worktree: string) {
    super(`${code}: current-slot operation rejected for canonical worktree`);
    this.name = "CurrentSlotTransitionError";
  }
}

export interface PersistBoundInput {
  readonly worktree: string;
  readonly deliveryId: string;
  readonly manifestPath: string;
  readonly deliveryBindingIdentity: string;
  readonly updatedAt: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactRecord(value: unknown, expectedFile: string): OccupiedCurrentSlot {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "deliveryBindingIdentity,deliveryId,diagnostic,manifestPath,schemaVersion,state,updatedAt,worktree") {
    throw new CurrentSlotTransitionError("CURRENT_SLOT_CORRUPT", "unknown");
  }
  const candidate = value as Record<string, unknown>;
  const states: readonly string[] = ["BOUND", "START_UNCERTAIN", "RUNNING_CORRELATED", "START_FAILED", "RESULT_UNRESOLVED", "TERMINAL_HANDLING"];
  const diagnostic = candidate.diagnostic;
  const diagnosticValid = diagnostic === null || (typeof diagnostic === "object" && !Array.isArray(diagnostic)
    && Object.keys(diagnostic).sort().join(",") === "causeCode,stage"
    && typeof (diagnostic as Record<string, unknown>).stage === "string"
    && /^[A-Z][A-Z0-9_]{0,63}$/u.test((diagnostic as Record<string, unknown>).stage as string)
    && typeof (diagnostic as Record<string, unknown>).causeCode === "string"
    && /^[A-Z][A-Z0-9_]{0,127}$/u.test((diagnostic as Record<string, unknown>).causeCode as string));
  if (candidate.schemaVersion !== "execution.current-slot@2.0.0"
    || typeof candidate.worktree !== "string" || !isAbsolute(candidate.worktree)
    || typeof candidate.deliveryId !== "string" || candidate.deliveryId.length === 0 || candidate.deliveryId.length > 256
    || typeof candidate.manifestPath !== "string" || !isAbsolute(candidate.manifestPath)
    || typeof candidate.deliveryBindingIdentity !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(candidate.deliveryBindingIdentity)
    || typeof candidate.state !== "string" || !states.includes(candidate.state)
    || !diagnosticValid || (candidate.state !== "RESULT_UNRESOLVED" && diagnostic !== null)
    || !Number.isSafeInteger(candidate.updatedAt) || (candidate.updatedAt as number) < 0
    || `${sha256(candidate.worktree)}.json` !== expectedFile) {
    throw new CurrentSlotTransitionError("CURRENT_SLOT_CORRUPT", typeof candidate.worktree === "string" ? candidate.worktree : "unknown");
  }
  return Object.freeze({
    schemaVersion: "execution.current-slot@2.0.0",
    state: candidate.state as CurrentSlotState,
    worktree: candidate.worktree,
    deliveryId: candidate.deliveryId,
    manifestPath: candidate.manifestPath,
    deliveryBindingIdentity: candidate.deliveryBindingIdentity,
    updatedAt: candidate.updatedAt as number,
    diagnostic: diagnostic as OccupiedCurrentSlot["diagnostic"],
  });
}

export class CurrentSlotRepository {
  readonly #root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError("current-slot root must be absolute");
    this.#root = resolve(root);
  }

  async read(worktree: string): Promise<CurrentSlotView> {
    const filename = this.#filename(worktree);
    try {
      const value = JSON.parse(await readFile(join(this.#root, filename), "utf8")) as unknown;
      return exactRecord(value, filename);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ state: "EMPTY", worktree });
      if (cause instanceof CurrentSlotTransitionError) throw cause;
      throw new CurrentSlotTransitionError("CURRENT_SLOT_CORRUPT", worktree);
    }
  }

  async enumerate(): Promise<readonly OccupiedCurrentSlot[]> {
    await mkdir(this.#root, { recursive: true });
    const files = (await readdir(this.#root)).filter((entry) => entry.endsWith(".json")).sort();
    const records = await Promise.all(files.map(async (filename) => {
      try { return exactRecord(JSON.parse(await readFile(join(this.#root, filename), "utf8")) as unknown, filename); }
      catch (cause) {
        if (cause instanceof CurrentSlotTransitionError) throw cause;
        throw new CurrentSlotTransitionError("CURRENT_SLOT_CORRUPT", "unknown");
      }
    }));
    const worktrees = records.map((record) => record.worktree);
    const deliveries = records.map((record) => record.deliveryId);
    if (new Set(worktrees).size !== worktrees.length || new Set(deliveries).size !== deliveries.length) {
      throw new CurrentSlotTransitionError("CURRENT_SLOT_CORRUPT", "duplicate");
    }
    return Object.freeze(records);
  }

  async persistBound(input: PersistBoundInput): Promise<OccupiedCurrentSlot> {
    if ((await this.read(input.worktree)).state !== "EMPTY") {
      throw new CurrentSlotTransitionError("CURRENT_SLOT_ALREADY_OCCUPIED", input.worktree);
    }
    const record = exactRecord({ schemaVersion: "execution.current-slot@2.0.0", state: "BOUND", ...input, diagnostic: null }, this.#filename(input.worktree));
    await this.#write(record);
    return record;
  }

  async transition(
    worktree: string,
    event: CurrentSlotTransition,
    updatedAt: number,
    options: Readonly<{
      authorization?: string;
      diagnostic?: Readonly<{ readonly stage: string; readonly causeCode: string }>;
    }> = {},
  ): Promise<CurrentSlotView> {
    const current = await this.read(worktree);
    if (current.state === "EMPTY") throw new CurrentSlotTransitionError("CURRENT_SLOT_MISSING", worktree);
    const transition = CURRENT_SLOT_TRANSITIONS[event];
    if (!transition.from.includes(current.state)) throw new CurrentSlotTransitionError("CURRENT_SLOT_TRANSITION_INVALID", worktree);
    if (transition.owner === "ADMINISTRATION" && options.authorization !== current.deliveryId) {
      throw new CurrentSlotTransitionError("CURRENT_SLOT_AUTHORIZATION_INVALID", worktree);
    }
    if (options.diagnostic !== undefined && event !== "M02_RESULT_UNRESOLVED") {
      throw new CurrentSlotTransitionError("CURRENT_SLOT_TRANSITION_INVALID", worktree);
    }
    if (options.diagnostic !== undefined && (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(options.diagnostic.stage)
      || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(options.diagnostic.causeCode))) {
      throw new CurrentSlotTransitionError("CURRENT_SLOT_TRANSITION_INVALID", worktree);
    }
    if (transition.to === "EMPTY") {
      try { await unlink(join(this.#root, this.#filename(worktree))); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      return Object.freeze({ state: "EMPTY", worktree });
    }
    const next = exactRecord({
      ...current,
      state: transition.to,
      updatedAt,
      diagnostic: transition.to === "RESULT_UNRESOLVED" ? options.diagnostic ?? null : null,
    }, this.#filename(worktree));
    await this.#write(next);
    return next;
  }

  #filename(worktree: string): string {
    if (!isAbsolute(worktree)) throw new CurrentSlotTransitionError("CURRENT_SLOT_CORRUPT", worktree);
    return `${sha256(worktree)}.json`;
  }

  async #write(record: OccupiedCurrentSlot): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const destination = join(this.#root, this.#filename(record.worktree));
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
  }
}
