import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ActionInputRequest,
  InteractionReceiptRef,
  InvocationDispatch,
  InvocationJournalRef,
  ManagedSessionRef,
} from "../contracts/index.js";

export type InvocationJournalStatus = "running" | "awaiting-input" | "completed" | "failed" | "invalid" | "unknown" | "cancelled";

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

export interface InvocationJournalStore {
  load(invocationIdentity: string): Promise<DurableInvocationJournal | undefined>;
  save(journal: DurableInvocationJournal): Promise<void>;
  list(): Promise<readonly DurableInvocationJournal[]>;
  delete(invocationIdentity: string): Promise<void>;
}

function safeIdentity(identity: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(identity)) throw new TypeError("invalid invocation journal identity");
  return identity;
}

export class FileInvocationJournalStore implements InvocationJournalStore {
  constructor(private readonly directory: string) {}

  private filename(identity: string): string {
    return join(this.directory, `${safeIdentity(identity)}.json`);
  }

  async load(identity: string): Promise<DurableInvocationJournal | undefined> {
    try {
      return JSON.parse(await readFile(this.filename(identity), "utf8")) as DurableInvocationJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(journal: DurableInvocationJournal): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filename = this.filename(journal.reference.episode.invocationIdentity);
    const temporary = join(this.directory, `.${basename(filename)}.${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filename);
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
    try {
      await unlink(this.filename(identity));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
