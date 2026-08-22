import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileInvocationJournalStore, type DurableInvocationJournal } from "../../src/invocation/index.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function journal(identity: string): DurableInvocationJournal {
  return {
    reference: { identity: `journal-${identity}`, episode: { invocationIdentity: identity } },
    dispatch: {},
    session: {},
    opaqueNativeSessionIdentity: `native-${identity}`,
    status: "running",
    nextOutputSequence: 0,
    interactionReceipts: [],
    redactedEvents: [],
  } as unknown as DurableInvocationJournal;
}

describe("FileInvocationJournalStore", () => {
  it("has empty missing semantics, sorted durable listing, and idempotent deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g03-store-"));
    directories.push(directory);
    const store = new FileInvocationJournalStore(join(directory, "nested"));
    expect(await store.load("missing")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    await store.delete("missing");

    await store.save(journal("z-invocation"));
    await store.save(journal("a-invocation"));
    expect((await store.list()).map((entry) => entry.reference.episode.invocationIdentity)).toEqual(["a-invocation", "z-invocation"]);
    expect(await store.load("a-invocation")).toMatchObject({ opaqueNativeSessionIdentity: "native-a-invocation" });
    await store.delete("a-invocation");
    await store.delete("a-invocation");
    expect(await store.load("a-invocation")).toBeUndefined();
  });

  it("rejects unsafe identity and surfaces corrupted persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g03-store-"));
    directories.push(directory);
    const store = new FileInvocationJournalStore(directory);
    await expect(store.load("../escape")).rejects.toThrow("invalid invocation journal identity");
    await writeFile(join(directory, "broken.json"), "not-json", "utf8");
    await expect(store.load("broken")).rejects.toBeInstanceOf(SyntaxError);
    await expect(store.list()).rejects.toBeInstanceOf(SyntaxError);
  });
});
