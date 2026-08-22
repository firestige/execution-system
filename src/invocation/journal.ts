import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ActionInputRequest,
  InteractionReceiptRef,
  InvocationDispatch,
  InvocationJournalRef,
  ManagedSessionRef,
} from "../contracts/index.js";

export type InvocationJournalStatus = "starting" | "running" | "awaiting-input" | "completed" | "failed" | "invalid" | "unknown" | "cancelled";

export interface DurableInvocationJournal {
  readonly reference: InvocationJournalRef;
  readonly dispatch: InvocationDispatch;
  readonly session: ManagedSessionRef;
  readonly opaqueNativeSessionIdentity: string;
  readonly status: InvocationJournalStatus;
  readonly nextOutputSequence: number;
  readonly pendingInput?: ActionInputRequest;
  readonly interactionReceipts: readonly InteractionReceiptRef[];
  readonly redactedEvents: readonly unknown[];
}

export interface DurableSessionAffinityIndex {
  readonly affinity: ManagedSessionRef["affinity"];
  readonly opaqueNativeSessionIdentity: string;
  readonly bindingIdentity: ManagedSessionRef["bindingIdentity"];
  readonly generation: number;
}

export interface InvocationJournalStore {
  load(invocationIdentity: string): Promise<DurableInvocationJournal | undefined>;
  create(journal: DurableInvocationJournal): Promise<boolean>;
  save(journal: DurableInvocationJournal): Promise<void>;
  update(invocationIdentity: string, transition: (current: DurableInvocationJournal | undefined) => DurableInvocationJournal | undefined): Promise<DurableInvocationJournal | undefined>;
  list(): Promise<readonly DurableInvocationJournal[]>;
  delete(invocationIdentity: string): Promise<void>;
  loadAffinity(affinityIdentity: string): Promise<DurableSessionAffinityIndex | undefined>;
  bindAffinity(index: DurableSessionAffinityIndex): Promise<void>;
  deleteAffinity(affinityIdentity: string): Promise<void>;
}

function safeIdentity(identity: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(identity)) throw new TypeError("invalid invocation journal identity");
  return identity;
}

export class FileInvocationJournalStore implements InvocationJournalStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  private filename(identity: string): string {
    return join(this.directory, `${safeIdentity(identity)}.json`);
  }

  private affinityFilename(identity: string): string {
    if (!/^[a-zA-Z0-9._:-]+$/.test(identity)) throw new TypeError("invalid session affinity identity");
    const filename = createHash("sha256").update(identity).digest("hex");
    return join(this.directory, "affinity", `${filename}.json`);
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const gate = previous.then(() => current);
    this.locks.set(key, gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === gate) this.locks.delete(key);
    }
  }

  private async read<T>(filename: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(filename, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async write(filename: string, value: unknown): Promise<void> {
    await mkdir(dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filename);
  }

  async load(identity: string): Promise<DurableInvocationJournal | undefined> {
    return this.read(this.filename(identity));
  }

  async create(journal: DurableInvocationJournal): Promise<boolean> {
    const identity = journal.reference.episode.invocationIdentity;
    return this.exclusive(`journal:${identity}`, async () => {
      if (await this.load(identity) !== undefined) return false;
      await this.write(this.filename(identity), journal);
      return true;
    });
  }

  async save(journal: DurableInvocationJournal): Promise<void> {
    const identity = journal.reference.episode.invocationIdentity;
    await this.exclusive(`journal:${identity}`, () => this.write(this.filename(identity), journal));
  }

  async update(identity: string, transition: (current: DurableInvocationJournal | undefined) => DurableInvocationJournal | undefined): Promise<DurableInvocationJournal | undefined> {
    return this.exclusive(`journal:${identity}`, async () => {
      const next = transition(await this.load(identity));
      if (next !== undefined) await this.write(this.filename(identity), next);
      return next;
    });
  }

  async list(): Promise<readonly DurableInvocationJournal[]> {
    try {
      const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
      return await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(this.directory, name), "utf8")) as DurableInvocationJournal));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async delete(identity: string): Promise<void> {
    await this.exclusive(`journal:${identity}`, async () => {
      try {
        await unlink(this.filename(identity));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }

  async loadAffinity(identity: string): Promise<DurableSessionAffinityIndex | undefined> {
    return this.read(this.affinityFilename(identity));
  }

  async bindAffinity(index: DurableSessionAffinityIndex): Promise<void> {
    await this.exclusive(`affinity:${index.affinity.identity}`, () => this.write(this.affinityFilename(index.affinity.identity), index));
  }

  async deleteAffinity(identity: string): Promise<void> {
    await this.exclusive(`affinity:${identity}`, async () => {
      try {
        await unlink(this.affinityFilename(identity));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }
}
