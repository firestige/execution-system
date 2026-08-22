import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AbsolutePath, AuthorizedWorkspaceCapability, InvocationDispatch, WorkspaceRelativePath } from "../../src/contracts/index.js";
import { createGitCustody } from "../../src/custody/git-custody.js";
import { FileInvocationJournalStore, createManagedInvocation, type NativeProviderSessionFactory } from "../../src/invocation/index.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(repository: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function dispatch(episode: Record<string, unknown>, workspace: AuthorizedWorkspaceCapability, access: readonly { mode: "read" | "write"; path: string }[]): InvocationDispatch {
  const delivery = (episode.thread as { delivery: unknown }).delivery;
  return {
    episode,
    plan: { actionIdentity: "action-1", executorIdentity: "executor-1", bindingIdentity: `sha256:${"a".repeat(64)}` },
    action: { identity: "action-1", resultSchema: { type: "object" } },
    executor: {
      identity: "executor-1",
      bindingIdentity: `sha256:${"b".repeat(64)}`,
      sessionCompatibilityIdentity: `sha256:${"c".repeat(64)}`,
      session: {
        driver: { providerIdentity: "dsh-headless", configuration: {} },
        providedCapabilities: ["structured-completion"],
      },
      turn: { access },
    },
    input: { task: "use signed capability" },
    workspace,
    session: {
      identity: `affinity-${String(episode.invocationIdentity)}`,
      delivery,
      sessionCompatibilityIdentity: `sha256:${"c".repeat(64)}`,
      scopeValueIdentity: `sha256:${"d".repeat(64)}`,
      isolation: "isolated",
    },
  } as unknown as InvocationDispatch;
}

describe("G02 → G03 signed workspace capability collaboration", () => {
  it("consumes production write/read capabilities without receiving the Custody service", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "formal-g02-g03-"));
    roots.push(root);
    const repository = path.join(root, "workspace");
    const records = path.join(root, "records");
    mkdirSync(repository);
    mkdirSync(path.join(repository, "allowed"));
    git(repository, "init", "-q");
    git(repository, "config", "user.email", "collaboration@example.invalid");
    git(repository, "config", "user.name", "Collaboration Test");
    writeFileSync(path.join(repository, "allowed", "value.txt"), "baseline\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "baseline");
    const tree = git(repository, "rev-parse", "HEAD^{tree}");
    const delivery = {
      deliveryIdentity: "delivery-collaboration",
      manifestBindingIdentity: `sha256:${"1".repeat(64)}`,
      activationBindingIdentity: `sha256:${"2".repeat(64)}`,
    } as const;
    const episode = (invocationIdentity: string) => ({
      thread: { delivery, threadIdentity: "thread-collaboration" },
      site: { kind: "node", nodeIdentity: "node-collaboration" },
      invocationIdentity,
      attemptIdentity: `attempt-${invocationIdentity}`,
    });
    const custody = createGitCustody({ recordsDirectory: records as AbsolutePath });
    const baseline = await custody.establishBaseline({
      delivery: delivery as never,
      workspace: { identity: "workspace-collaboration" as never, canonicalWorktreePath: repository as AbsolutePath, admittedGitTree: tree as never },
    });
    if (!baseline.ok) throw new Error("production baseline failed");
    const writeAccess = [{ mode: "write" as const, path: "allowed" as WorkspaceRelativePath }];
    const writeHandle = await custody.acquireWriteHandle({ episode: episode("invocation-write") as never, savepoint: baseline.value, access: writeAccess });
    if (!writeHandle.ok) throw new Error("production write capability failed");
    const readAccess = [{ mode: "read" as const, path: "allowed" as WorkspaceRelativePath }];
    const readView = await custody.openReadView({ episode: episode("invocation-read") as never, source: baseline.value, access: readAccess });
    if (!readView.ok) throw new Error("production read capability failed");

    let opens = 0;
    const provider: NativeProviderSessionFactory = {
      async open() {
        opens += 1;
        return { opaqueIdentity: `native-${opens}`, async run() { return [{ kind: "structured-completion", result: { accepted: true } }]; }, async persist() {}, async cancel() {}, async dispose() {} };
      },
      async restore() { throw new Error("not used"); },
    };
    const manager = createManagedInvocation({
      providers: { "dsh-headless": provider },
      credentials: { async acquire() { return { material: { apiKey: "test-only" }, async release() {} }; } },
      journal: new FileInvocationJournalStore(path.join(root, "journals")),
      validateResult: () => true,
      authorizeRetirement: () => true,
    });
    const output = { async publish() { return { ok: true as const, value: undefined }; } };

    expect(await manager.host.start(dispatch(episode("invocation-write"), { kind: "write", handle: writeHandle.value }, writeAccess), output)).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(await manager.host.start(dispatch(episode("invocation-read"), { kind: "read", view: readView.value }, readAccess), output)).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(await manager.host.start(dispatch(episode("invocation-none"), { kind: "none" }, []), output)).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(opens).toBe(3);
  });
});
