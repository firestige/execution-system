import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AbsolutePath,
  AdmittedWorkspace,
  ArtifactId,
  AttemptId,
  CheckpointId,
  DeliveryId,
  DeliveryRef,
  GitTreeId,
  InvocationId,
  NodeId,
  PublicationGuardId,
  PublicationTargetId,
  ReadViewId,
  RetirementAuthorizationId,
  SavepointId,
  Sha256,
  ThreadId,
  WorkflowResultId,
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../src/contracts/index.js";
import { createGitCustody } from "../../src/custody/git-custody.js";
import { captureManagedWorkspaceTree } from "../../src/custody/managed-workspace-snapshot.js";

const stable = <T extends string>(value: string): T => value as T;
const sha = (value: string): Sha256 => `sha256:${value}` as Sha256;

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "formal-g02-"));
  const repository = path.join(root, "workspace");
  const records = path.join(root, "records");
  mkdirSync(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "custody@example.invalid");
  git(repository, "config", "user.name", "Custody Test");
  mkdirSync(path.join(repository, "allowed"));
  mkdirSync(path.join(repository, "blocked"));
  writeFileSync(path.join(repository, ".gitignore"), "ignored.log\n");
  writeFileSync(path.join(repository, "allowed", "value.txt"), "baseline\n");
  writeFileSync(path.join(repository, "blocked", "secret.txt"), "baseline\n");
  writeFileSync(path.join(repository, "ignored.log"), "ignored baseline\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "baseline");
  const tree = git(repository, "rev-parse", "HEAD^{tree}") as GitTreeId;
  const delivery: DeliveryRef = {
    deliveryIdentity: stable<DeliveryId>("delivery-1"),
    manifestBindingIdentity: sha("manifest"),
    activationBindingIdentity: sha("activation"),
  };
  const workspace: AdmittedWorkspace = {
    identity: stable<WorkspaceId>("workspace-1"),
    canonicalWorktreePath: repository as AbsolutePath,
    admittedGitTree: tree,
  };
  const episode = {
    thread: { delivery, threadIdentity: stable<ThreadId>("thread-1") },
    site: { kind: "node" as const, nodeIdentity: stable<NodeId>("action-node") },
    invocationIdentity: stable<InvocationId>("invocation-1"),
    attemptIdentity: stable<AttemptId>("attempt-1"),
  };
  return { root, repository, records, tree, delivery, workspace, episode };
}

describe("Git custody", () => {
  it("establishes a dirty managed baseline without indexing ignored data or mutating the user Git database", async () => {
    const f = fixture();
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "dirty tracked\n");
    writeFileSync(path.join(f.repository, "untracked.txt"), "dirty untracked\n");
    writeFileSync(path.join(f.repository, "ignored.log"), "ignored changed before baseline\n");
    const admittedGitTree = captureManagedWorkspaceTree(f.repository);
    const workspace = { ...f.workspace, admittedGitTree };
    const indexBefore = readFileSync(path.join(f.repository, ".git", "index"));
    const objectsBefore = git(f.repository, "count-objects", "-v");
    const refsBefore = git(f.repository, "for-each-ref", "--format=%(refname)", "refs/agentops/custody");
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });

    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace });

    expect(baseline.ok).toBe(true);
    if (!baseline.ok) throw new Error("dirty baseline was not established");
    expect(baseline.value.gitTree).toBe(admittedGitTree);
    expect(readFileSync(path.join(f.repository, ".git", "index"))).toEqual(indexBefore);
    expect(git(f.repository, "count-objects", "-v")).toBe(objectsBefore);
    expect(git(f.repository, "for-each-ref", "--format=%(refname)", "refs/agentops/custody")).toBe(refsBefore);

    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    writeFileSync(path.join(f.repository, "ignored.log"), "ignored mutation during attempt\n");
    const ignoredOnly = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });
    expect(ignoredOnly.ok && ignoredOnly.value.kind).toBe("accepted");
    expect(readFileSync(path.join(f.repository, "ignored.log"), "utf8")).toBe("ignored mutation during attempt\n");
    expect(readFileSync(path.join(f.repository, ".git", "index"))).toEqual(indexBefore);
    expect(git(f.repository, "count-objects", "-v")).toBe(objectsBefore);
  });

  it("publishes a dirty managed tree intentionally while keeping the user index unchanged", async () => {
    const f = fixture();
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "dirty publishable\n");
    writeFileSync(path.join(f.repository, "untracked.txt"), "included in publication\n");
    writeFileSync(path.join(f.repository, "ignored.log"), "excluded from publication\n");
    const workspace = { ...f.workspace, admittedGitTree: captureManagedWorkspaceTree(f.repository) };
    const indexBefore = readFileSync(path.join(f.repository, ".git", "index"));
    const targetIdentity = stable<PublicationTargetId>("dirty-release-target");
    const custody = createGitCustody({
      recordsDirectory: f.records as AbsolutePath,
      publicationTargets: [{
        target: { identity: targetIdentity },
        repositoryPath: f.repository as AbsolutePath,
        ref: "refs/heads/dirty-published",
      }],
    });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace });
    if (!baseline.ok) throw new Error("dirty baseline was not established");
    const preserved = await custody.preserveResult({
      checkpoint: {
        identity: stable<CheckpointId>("dirty-checkpoint"),
        thread: f.episode.thread,
        stateIdentity: sha("dirty-state"),
        savepoint: { state: "known", value: baseline.value },
      },
      result: {
        identity: stable<WorkflowResultId>("dirty-result"),
        content: { outcome: "done" },
        contentIdentity: sha("dirty-result-content"),
        artifacts: {} as Record<ArtifactId, never>,
      },
    });
    if (!preserved.ok) throw new Error("dirty result was not preserved");

    const publication = await custody.publish({
      result: preserved.value,
      target: { identity: targetIdentity },
      guard: {
        identity: stable<PublicationGuardId>("dirty-guard"),
        expectedGitTree: baseline.value.gitTree,
      },
    });

    expect(publication.ok && publication.value.kind).toBe("published");
    expect(git(f.repository, "rev-parse", "refs/heads/dirty-published^{tree}")).toBe(baseline.value.gitTree);
    expect(readFileSync(path.join(f.repository, ".git", "index"))).toEqual(indexBefore);
    expect(git(f.repository, "show", "refs/heads/dirty-published:untracked.txt")).toBe("included in publication");
    expect(() => git(f.repository, "show", "refs/heads/dirty-published:ignored.log")).toThrow();
  });

  it("returns a stable capacity diagnostic and cleans failed WSR-owned snapshot objects", async () => {
    const f = fixture();
    const custody = createGitCustody({
      recordsDirectory: f.records as AbsolutePath,
      snapshotLimits: { maxFileCount: 1, maxFileBytes: 1_000, maxTotalBytes: 10_000 },
    });

    expect(await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace }))
      .toEqual({ ok: false, error: { code: "WORKSPACE_SNAPSHOT_CAPACITY_EXCEEDED" } });
    expect(readdirSync(path.join(f.records, "objects"))).toEqual([]);
  });

  it("requires a durable baseline before issuing a scoped write handle", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const access = [{ mode: "write" as const, path: "allowed" as WorkspaceRelativePath }];
    const missing = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: {
        deliveryIdentity: f.delivery.deliveryIdentity,
        savepointIdentity: stable<SavepointId>("missing"),
        gitTree: f.tree,
      },
      access,
    });
    expect(missing).toEqual({ ok: false, error: { code: "BASELINE_MISSING" } });

    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) throw new Error("baseline was not established");

    const reopened = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const handle = await reopened.acquireWriteHandle({ episode: f.episode, savepoint: baseline.value, access });
    expect(handle.ok).toBe(true);
    if (!handle.ok) throw new Error("handle was not issued");
    expect(handle.value.savepoint).toEqual(baseline.value);
    expect(handle.value.accessDigest).toMatch(/^sha256:/);
    const unchanged = await reopened.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });
    expect(unchanged.ok && unchanged.value.kind).toBe("accepted");
  });

  it("accepts an in-scope mutation and advances to a durable Git-tree savepoint", async () => {
    const f = fixture();
    const indexBefore = readFileSync(path.join(f.repository, ".git", "index"));
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    expect(existsSync(path.join(f.records, "objects"))).toBe(true);
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");

    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "accepted\n");
    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });

    expect(disposition.ok).toBe(true);
    if (!disposition.ok || disposition.value.kind !== "accepted") throw new Error("attempt was not accepted");
    expect(disposition.value.nextSavepoint.state).toBe("known");
    if (disposition.value.nextSavepoint.state !== "known" || "kind" in disposition.value.nextSavepoint.value) {
      throw new Error("next savepoint was absent");
    }
    const nextTree = disposition.value.nextSavepoint.value.gitTree;
    expect(nextTree).not.toBe(baseline.value.gitTree);
    expect(readFileSync(path.join(f.repository, ".git", "index"))).toEqual(indexBefore);
    expect(() => git(f.repository, "cat-file", "-t", nextTree)).toThrow();
  });

  it("detects an out-of-scope mutation and restores the prior savepoint", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "allowed\n");
    writeFileSync(path.join(f.repository, "blocked", "secret.txt"), "not allowed\n");

    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });

    expect(disposition).toEqual({
      ok: true,
      value: { kind: "scope-violation-restored", restoredSavepoint: baseline.value },
    });
    expect(readFileSync(path.join(f.repository, "allowed", "value.txt"), "utf8")).toBe("baseline\n");
    expect(readFileSync(path.join(f.repository, "blocked", "secret.txt"), "utf8")).toBe("baseline\n");
    expect(git(f.repository, "status", "--porcelain")).toBe("");
  });

  it("accepts root and nested mutations covered by the admitted recursive wildcard", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "**" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    writeFileSync(path.join(f.repository, "root.txt"), "root\n");
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "nested\n");

    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });

    expect(disposition.ok && disposition.value.kind).toBe("accepted");
    expect(readFileSync(path.join(f.repository, "root.txt"), "utf8")).toBe("root\n");
    expect(readFileSync(path.join(f.repository, "allowed", "value.txt"), "utf8")).toBe("nested\n");
  });

  it("accepts only mutations below an admitted recursive prefix wildcard", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed/**" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "nested\n");

    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });

    expect(disposition.ok && disposition.value.kind).toBe("accepted");
    expect(readFileSync(path.join(f.repository, "allowed", "value.txt"), "utf8")).toBe("nested\n");
  });

  it("restores an otherwise valid mutation when Host rejects the result", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "valid but rejected\n");

    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "reject",
    });
    expect(disposition).toEqual({
      ok: true,
      value: { kind: "host-rejected-restored", restoredSavepoint: baseline.value },
    });
    expect(readFileSync(path.join(f.repository, "allowed", "value.txt"), "utf8")).toBe("baseline\n");
  });

  it("bounds a read view to one savepoint and restores mutations", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const view = await custody.openReadView({
      episode: f.episode,
      source: baseline.value,
      access: [{ mode: "read", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!view.ok) throw new Error("view was not opened");
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "mutation during read\n");

    const validation = await custody.validateReadView(view.value);
    expect(validation.ok).toBe(true);
    if (!validation.ok || validation.value.kind !== "mutation-detected") throw new Error("mutation not detected");
    expect(validation.value.restored).toEqual({ state: "known", value: baseline.value });
    expect(readFileSync(path.join(f.repository, "allowed", "value.txt"), "utf8")).toBe("baseline\n");
  });

  it("preserves a result before guarded publication and retires only custody state", async () => {
    const f = fixture();
    const targetIdentity = stable<PublicationTargetId>("release-target");
    const custody = createGitCustody({
      recordsDirectory: f.records as AbsolutePath,
      publicationTargets: [{
        target: { identity: targetIdentity },
        repositoryPath: f.repository as AbsolutePath,
        ref: "refs/heads/custody-published",
      }],
    });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const checkpoint = {
      identity: stable<CheckpointId>("checkpoint-1"),
      thread: f.episode.thread,
      stateIdentity: sha("state"),
      savepoint: { state: "known" as const, value: baseline.value },
    };
    const result = {
      identity: stable<WorkflowResultId>("result-1"),
      content: { outcome: "done" },
      contentIdentity: sha("result-content"),
      artifacts: {} as Record<ArtifactId, never>,
    };

    const preserved = await custody.preserveResult({ checkpoint, result });
    expect(preserved.ok).toBe(true);
    if (!preserved.ok) throw new Error("result was not preserved");
    const wrongGuard = await custody.publish({
      result: preserved.value,
      target: { identity: targetIdentity },
      guard: {
        identity: stable<PublicationGuardId>("guard-wrong"),
        expectedGitTree: stable<GitTreeId>("not-the-current-tree"),
      },
    });
    expect(wrongGuard).toEqual({ ok: false, error: { code: "PUBLICATION_GUARD_INVALID" } });
    const publication = await custody.publish({
      result: preserved.value,
      target: { identity: targetIdentity },
      guard: {
        identity: stable<PublicationGuardId>("guard-1"),
        expectedGitTree: baseline.value.gitTree,
      },
    });
    expect(publication.ok).toBe(true);
    if (!publication.ok || publication.value.kind !== "published") throw new Error("result was not published");
    expect(git(f.repository, "rev-parse", "refs/heads/custody-published^{tree}")).toBe(baseline.value.gitTree);

    const repeated = await custody.publish({
      result: preserved.value,
      target: { identity: targetIdentity },
      guard: {
        identity: stable<PublicationGuardId>("guard-1"),
        expectedGitTree: baseline.value.gitTree,
      },
    });
    expect(repeated.ok && repeated.value.kind).toBe("already-at-target");

    const inspection = await custody.inspect(f.delivery);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) throw new Error("inspection failed");
    expect(inspection.value.preservedResult).toEqual({ state: "known", value: preserved.value });
    expect(inspection.value.publication.state).toBe("known");

    const authorization = {
      identity: stable<RetirementAuthorizationId>("retirement-1"),
      delivery: f.delivery,
    };
    const retirement = await custody.retire(authorization);
    expect(retirement.ok).toBe(true);
    if (!retirement.ok) throw new Error("retirement failed");
    expect(retirement.value).toEqual({ owner: "custody", authorization, state: "retired" });
    expect(readdirSync(path.join(f.records, "objects"))).toEqual([]);
    expect("reference" in retirement.value).toBe(false);
    expect("identity" in retirement.value).toBe(false);
    expect(await custody.retire(authorization)).toEqual(retirement);
    expect(await custody.retire({
      identity: stable<RetirementAuthorizationId>("different-retirement"),
      delivery: f.delivery,
    })).toEqual({ ok: false, error: { code: "RETIREMENT_NOT_AUTHORIZED" } });
  });

  it("fails closed for forged handles, mismatched guards, and unknown recovery state", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    const forged = { ...handle.value, accessDigest: sha("forged") };
    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: forged },
      hostDecision: "accept",
    });
    expect(disposition).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });

    const recovery = await custody.recover({
      delivery: f.delivery,
      directive: "continue",
      savepoint: {
        state: "unknown",
        owner: "custody",
        reason: "CALL_INTERRUPTED",
      },
    });
    expect(recovery.ok && recovery.value.kind).toBe("intervention-required");
  });

  it("is baseline-idempotent and rejects dirty, non-canonical, or rebound workspaces", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    expect(baseline.ok).toBe(true);
    const repeated = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    expect(repeated).toEqual(baseline);
    const rebound = await custody.establishBaseline({
      delivery: f.delivery,
      workspace: { ...f.workspace, identity: stable<WorkspaceId>("other-workspace") },
    });
    expect(rebound).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });

    const dirty = fixture();
    writeFileSync(path.join(dirty.repository, "blocked", "secret.txt"), "dirty\n");
    const dirtyResult = await createGitCustody({ recordsDirectory: dirty.records as AbsolutePath })
      .establishBaseline({ delivery: dirty.delivery, workspace: dirty.workspace });
    expect(dirtyResult).toEqual({ ok: false, error: { code: "GIT_STATE_MISMATCH" } });
    expect(readdirSync(path.join(dirty.records, "objects"))).toEqual([]);

    const nested = fixture();
    const nonCanonical = await createGitCustody({ recordsDirectory: nested.records as AbsolutePath })
      .establishBaseline({
        delivery: nested.delivery,
        workspace: {
          ...nested.workspace,
          canonicalWorktreePath: path.join(nested.repository, "allowed") as AbsolutePath,
        },
      });
    expect(nonCanonical).toEqual({ ok: false, error: { code: "GIT_STATE_MISMATCH" } });
  });

  it("rejects stale or unsafe capabilities and read views with write authority", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const missingView = await custody.openReadView({
      episode: f.episode,
      source: {
        deliveryIdentity: f.delivery.deliveryIdentity,
        savepointIdentity: stable<SavepointId>("missing"),
        gitTree: f.tree,
      },
      access: [],
    });
    expect(missingView).toEqual({ ok: false, error: { code: "BASELINE_MISSING" } });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const stale = { ...baseline.value, savepointIdentity: stable<SavepointId>("stale") };
    expect(await custody.acquireWriteHandle({ episode: f.episode, savepoint: stale, access: [] }))
      .toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
    for (const unsafePath of ["", "/absolute", "bad\\path", ".", "allowed/../blocked", "../escape"]) {
      expect(await custody.acquireWriteHandle({
        episode: f.episode,
        savepoint: baseline.value,
        access: [{ mode: "write", path: unsafePath as WorkspaceRelativePath }],
      })).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
    }
    expect(await custody.openReadView({ episode: f.episode, source: stale, access: [] }))
      .toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
    expect(await custody.openReadView({
      episode: f.episode,
      source: baseline.value,
      access: [{ mode: "write", path: "allowed" as WorkspaceRelativePath }],
    })).toEqual({ ok: false, error: { code: "READ_VIEW_INVALID" } });
    const forgedView = {
      viewIdentity: stable<ReadViewId>("forged-view"),
      episode: f.episode,
      source: baseline.value,
      accessDigest: sha("forged"),
    };
    expect(await custody.validateReadView(forgedView)).toEqual({ ok: false, error: { code: "READ_VIEW_INVALID" } });
    expect(await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "read", view: forgedView },
      hostDecision: "accept",
    })).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
  });

  it("settles read and no-workspace attempts without granting write authority", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const view = await custody.openReadView({
      episode: f.episode,
      source: baseline.value,
      access: [{ mode: "read", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!view.ok) throw new Error("view was not opened");
    const current = await custody.validateReadView(view.value);
    expect(current.ok && current.value.kind).toBe("current");
    const accepted = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "read", view: view.value },
      hostDecision: "accept",
    });
    expect(accepted.ok && accepted.value.kind).toBe("accepted");
    const rejected = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "read", view: view.value },
      hostDecision: "reject",
    });
    expect(rejected.ok && rejected.value.kind).toBe("host-rejected-restored");

    const noneAccepted = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "none" },
      hostDecision: "accept",
    });
    expect(noneAccepted.ok && noneAccepted.value.kind).toBe("accepted");
    writeFileSync(path.join(f.repository, "blocked", "secret.txt"), "mutated\n");
    const noneMutated = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "none" },
      hostDecision: "accept",
    });
    expect(noneMutated.ok && noneMutated.value.kind).toBe("scope-violation-restored");
    const noneRejected = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "none" },
      hostDecision: "reject",
    });
    expect(noneRejected.ok && noneRejected.value.kind).toBe("host-rejected-restored");
  });

  it("invalidates an older read view after an accepted write advances the savepoint", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const view = await custody.openReadView({
      episode: f.episode,
      source: baseline.value,
      access: [{ mode: "read", path: "allowed" as WorkspaceRelativePath }],
    });
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed/value.txt" as WorkspaceRelativePath }],
    });
    if (!view.ok || !handle.ok) throw new Error("capability was not issued");
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "next\n");
    const settled = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });
    expect(settled.ok && settled.value.kind).toBe("accepted");
    const invalidated = await custody.validateReadView(view.value);
    expect(invalidated.ok && invalidated.value.kind).toBe("source-changed");
  });

  it("supports known continue and restore recovery while rejecting untracked savepoints", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const continued = await custody.recover({
      delivery: f.delivery,
      directive: "continue",
      savepoint: { state: "known", value: baseline.value },
    });
    expect(continued.ok && continued.value.kind).toBe("continued");
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "transient\n");
    const restored = await custody.recover({
      delivery: f.delivery,
      directive: "restore-from-savepoint",
      savepoint: { state: "known", value: baseline.value },
    });
    expect(restored.ok && restored.value.kind).toBe("restored");
    expect(readFileSync(path.join(f.repository, "allowed", "value.txt"), "utf8")).toBe("baseline\n");
    const unknownSavepoint = { ...baseline.value, savepointIdentity: stable<SavepointId>("not-recorded") };
    expect(await custody.recover({
      delivery: f.delivery,
      directive: "restore-from-savepoint",
      savepoint: { state: "known", value: unknownSavepoint },
    })).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });
    const intervention = await custody.recover({
      delivery: f.delivery,
      directive: "intervene",
      savepoint: { state: "known", value: baseline.value },
    });
    expect(intervention.ok && intervention.value.kind).toBe("intervention-required");
  });

  it("guards preservation and publication conflicts without discarding the durable result", async () => {
    const f = fixture();
    const targetIdentity = stable<PublicationTargetId>("conflicting-target");
    const custody = createGitCustody({
      recordsDirectory: f.records as AbsolutePath,
      publicationTargets: [{
        target: { identity: targetIdentity },
        repositoryPath: f.repository as AbsolutePath,
        ref: "refs/heads/main",
      }],
    });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const beforeResult = await custody.inspect(f.delivery);
    expect(beforeResult.ok && beforeResult.value.preservedResult.state).toBe("unknown");
    const checkpoint = {
      identity: stable<CheckpointId>("checkpoint-conflict"),
      thread: f.episode.thread,
      stateIdentity: sha("state-conflict"),
      savepoint: { state: "known" as const, value: baseline.value },
    };
    const first = await custody.preserveResult({
      checkpoint,
      result: {
        identity: stable<WorkflowResultId>("result-conflict"),
        content: { durable: true },
        contentIdentity: sha("durable-content"),
        artifacts: {},
      },
    });
    if (!first.ok) throw new Error("result was not preserved");
    const repeated = await custody.preserveResult({
      checkpoint,
      result: {
        identity: stable<WorkflowResultId>("result-conflict"),
        content: { durable: true },
        contentIdentity: sha("durable-content"),
        artifacts: {},
      },
    });
    expect(repeated).toEqual(first);
    const second = await custody.preserveResult({
      checkpoint,
      result: {
        identity: stable<WorkflowResultId>("different-result"),
        content: { durable: false },
        contentIdentity: sha("different-content"),
        artifacts: {},
      },
    });
    expect(second).toEqual({ ok: false, error: { code: "CORRELATION_MISMATCH" } });

    git(f.repository, "checkout", "-qb", "other");
    writeFileSync(path.join(f.repository, "allowed", "value.txt"), "conflicting target\n");
    git(f.repository, "add", ".");
    git(f.repository, "commit", "-qm", "conflicting target");
    git(f.repository, "branch", "-f", "main", "HEAD");
    git(f.repository, "checkout", "-q", "master");
    const conflict = await custody.publish({
      result: first.value,
      target: { identity: targetIdentity },
      guard: { identity: stable<PublicationGuardId>("guard-conflict"), expectedGitTree: baseline.value.gitTree },
    });
    expect(conflict.ok && conflict.value.kind).toBe("conflict");
    const inspected = await custody.inspect(f.delivery);
    expect(inspected.ok && inspected.value.preservedResult).toEqual({ state: "known", value: first.value });
  });

  it("returns typed publication uncertainty and blocks retirement until disposition is known", async () => {
    const f = fixture();
    const targetIdentity = stable<PublicationTargetId>("invalid-ref-target");
    const custody = createGitCustody({
      recordsDirectory: f.records as AbsolutePath,
      publicationTargets: [{
        target: { identity: targetIdentity },
        repositoryPath: f.repository as AbsolutePath,
        ref: "refs/heads/invalid..ref",
      }],
    });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const preserved = await custody.preserveResult({
      checkpoint: {
        identity: stable<CheckpointId>("checkpoint-unknown"),
        thread: f.episode.thread,
        stateIdentity: sha("unknown-state"),
        savepoint: { state: "known", value: baseline.value },
      },
      result: {
        identity: stable<WorkflowResultId>("result-unknown"),
        content: null,
        contentIdentity: sha("unknown-content"),
        artifacts: {},
      },
    });
    if (!preserved.ok) throw new Error("result was not preserved");
    const publication = await custody.publish({
      result: preserved.value,
      target: { identity: targetIdentity },
      guard: { identity: stable<PublicationGuardId>("guard-unknown"), expectedGitTree: baseline.value.gitTree },
    });
    expect(publication.ok && publication.value.kind).toBe("unknown");
    const retirement = await custody.retire({
      identity: stable<RetirementAuthorizationId>("retirement-unknown"),
      delivery: f.delivery,
    });
    expect(retirement).toEqual({ ok: false, error: { code: "RETIREMENT_NOT_AUTHORIZED" } });
  });

  it("fails closed when durable custody state is unreadable", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    expect(baseline.ok).toBe(true);
    const recordName = readdirSync(f.records).find((name) => name.endsWith(".json"));
    if (recordName === undefined) throw new Error("record missing");
    writeFileSync(path.join(f.records, recordName), "not-json");
    expect(await custody.inspect(f.delivery)).toEqual({ ok: false, error: { code: "BASELINE_MISSING" } });
  });

  it("leaves ignored content outside the managed snapshot and write capability", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    writeFileSync(path.join(f.repository, "ignored.log"), "ignored mutation\n");

    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });
    expect(disposition.ok && disposition.value.kind).toBe("accepted");
    expect(readFileSync(path.join(f.repository, "ignored.log"), "utf8")).toBe("ignored mutation\n");
  });

  it("performs independent write-scope validation before classifying a Host rejection", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    writeFileSync(path.join(f.repository, "blocked", "secret.txt"), "scope violation\n");
    writeFileSync(path.join(f.repository, "ignored.log"), "ignored scope violation\n");

    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "reject",
    });
    expect(disposition.ok && disposition.value.kind).toBe("scope-violation-restored");
    expect(readFileSync(path.join(f.repository, "blocked", "secret.txt"), "utf8")).toBe("baseline\n");
    expect(readFileSync(path.join(f.repository, "ignored.log"), "utf8")).toBe("ignored scope violation\n");
  });

  it("performs independent read-view mutation validation before classifying a Host rejection", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const view = await custody.openReadView({
      episode: f.episode,
      source: baseline.value,
      access: [{ mode: "read", path: "allowed" as WorkspaceRelativePath }],
    });
    if (!view.ok) throw new Error("view was not opened");
    writeFileSync(path.join(f.repository, "ignored.log"), "read mutation\n");

    const disposition = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "read", view: view.value },
      hostDecision: "reject",
    });
    expect(disposition.ok && disposition.value.kind).toBe("host-rejected-restored");
    expect(readFileSync(path.join(f.repository, "ignored.log"), "utf8")).toBe("read mutation\n");
  });

  it("does not snapshot, anchor, or restore ignored-only changes", async () => {
    const f = fixture();
    const custody = createGitCustody({ recordsDirectory: f.records as AbsolutePath });
    const baseline = await custody.establishBaseline({ delivery: f.delivery, workspace: f.workspace });
    if (!baseline.ok) throw new Error("baseline was not established");
    const handle = await custody.acquireWriteHandle({
      episode: f.episode,
      savepoint: baseline.value,
      access: [{ mode: "write", path: "ignored.log" as WorkspaceRelativePath }],
    });
    if (!handle.ok) throw new Error("handle was not issued");
    writeFileSync(path.join(f.repository, "ignored.log"), "authorized ignored value\n");
    const accepted = await custody.settleWorkspaceAttempt({
      episode: f.episode,
      workspace: { kind: "write", handle: handle.value },
      hostDecision: "accept",
    });
    if (!accepted.ok || accepted.value.kind !== "accepted" || accepted.value.nextSavepoint.state !== "known"
      || "kind" in accepted.value.nextSavepoint.value) throw new Error("ignored savepoint was not accepted");
    expect(accepted.value.nextSavepoint.value.gitTree).toBe(baseline.value.gitTree);
    expect(accepted.value.nextSavepoint.value.savepointIdentity).not.toBe(baseline.value.savepointIdentity);
    expect(git(f.repository, "for-each-ref", "--format=%(objecttype)", "refs/agentops/custody")).toBe("");

    writeFileSync(path.join(f.repository, "ignored.log"), "later rejected value\n");
    const restored = await custody.recover({
      delivery: f.delivery,
      directive: "restore-from-savepoint",
      savepoint: { state: "known", value: accepted.value.nextSavepoint.value },
    });
    expect(restored.ok && restored.value.kind).toBe("restored");
    expect(readFileSync(path.join(f.repository, "ignored.log"), "utf8")).toBe("later rejected value\n");
  });
});
