import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  captureManagedWorkspaceTree,
  DEFAULT_MANAGED_WORKSPACE_SNAPSHOT_LIMITS,
  ManagedWorkspaceSnapshotError,
  managedWorkspaceObjectEnvironment,
  type ManagedWorkspaceSnapshotLimits,
} from "./managed-workspace-snapshot.js";

import type {
  AbsolutePath,
  AdmittedWorkspace,
  AuthorizedInvocationHandle,
  AuthorizedReadView,
  CoordinatorCustody,
  CustodyAttemptDisposition,
  CustodyError,
  CustodyInspection,
  CustodyRecoveryDisposition,
  DeliveryRef,
  EpisodeRef,
  GitTreeId,
  HandleId,
  HostCustody,
  Knowledge,
  OwnerRetirementDisposition,
  PreservedResultRef,
  PublicationDisposition,
  PublicationId,
  PublicationTargetRef,
  ReadViewDisposition,
  ReadViewId,
  ResolvedAccessRule,
  Result,
  SavepointId,
  SavepointRef,
  Sha256,
  WorkspaceRelativePath,
} from "../contracts/index.js";

export interface GitPublicationTarget {
  readonly target: PublicationTargetRef;
  readonly repositoryPath: AbsolutePath;
  readonly ref: string;
}

export interface GitCustodyOptions {
  readonly recordsDirectory: AbsolutePath;
  readonly publicationTargets?: readonly GitPublicationTarget[];
  readonly snapshotLimits?: ManagedWorkspaceSnapshotLimits;
}

interface StoredHandle extends AuthorizedInvocationHandle {
  readonly access: readonly ResolvedAccessRule[];
}

interface StoredView extends AuthorizedReadView {
  readonly access: readonly ResolvedAccessRule[];
}

interface CustodyRecord {
  readonly delivery: DeliveryRef;
  readonly workspace: AdmittedWorkspace;
  currentSavepoint: SavepointRef;
  savepoints: SavepointRef[];
  workspaceTrees: Record<string, GitTreeId>;
  handles: StoredHandle[];
  views: StoredView[];
  preservedResult?: PreservedResultRef;
  publication?: PublicationDisposition;
  retiredAuthorizationIdentity?: string;
}

class GitCommandError extends Error {}

const known = <T>(value: T): Knowledge<T> => ({ state: "known", value });
const custodyUnknown = (reason: "CALL_INTERRUPTED" | "PUBLICATION_DISPOSITION_UNOBSERVED" | "CLEANUP_DISPOSITION_UNOBSERVED") => ({
  state: "unknown" as const,
  owner: "custody" as const,
  reason,
});
const success = <T>(value: T): Result<T, CustodyError> => ({ ok: true, value });
const failure = (code: CustodyError["code"]): Result<never, CustodyError> => ({ ok: false, error: { code } });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}` as Sha256;
}

function stableId<T extends string>(prefix: string, value: unknown): T {
  return `${prefix}-${createHash("sha256").update(canonical(value)).digest("hex")}` as T;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function git(
  repository: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
  trimOutput = true,
): string {
  try {
    const output = execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      env: environment === undefined ? process.env : environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return trimOutput ? output.trim() : output;
  } catch (error) {
    throw new GitCommandError(error instanceof Error ? error.message : "git command failed");
  }
}

function validRelativePath(value: string): value is WorkspaceRelativePath {
  if (value.length === 0 || path.posix.isAbsolute(value) || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../") && !normalized.includes("/../");
}

function pathAllowed(changedPath: string, access: readonly ResolvedAccessRule[]): boolean {
  return access.some((rule) => rule.mode === "write" && validRelativePath(rule.path)
    && (changedPath === rule.path || changedPath.startsWith(`${rule.path}/`)));
}

export class GitCustody implements HostCustody, CoordinatorCustody {
  readonly #recordsDirectory: string;
  readonly #publicationTargets: Map<string, GitPublicationTarget>;
  readonly #snapshotLimits: ManagedWorkspaceSnapshotLimits;

  constructor(options: GitCustodyOptions) {
    this.#recordsDirectory = path.resolve(options.recordsDirectory);
    mkdirSync(this.#recordsDirectory, { recursive: true });
    this.#snapshotLimits = options.snapshotLimits ?? DEFAULT_MANAGED_WORKSPACE_SNAPSHOT_LIMITS;
    this.#publicationTargets = new Map(
      (options.publicationTargets ?? []).map((binding) => [binding.target.identity, binding]),
    );
  }

  async establishBaseline(request: Parameters<HostCustody["establishBaseline"]>[0]): Promise<Result<SavepointRef, CustodyError>> {
    const existing = this.#load(request.delivery);
    if (existing !== undefined) {
      if (!same(existing.delivery, request.delivery) || !same(existing.workspace, request.workspace)) {
        return failure("CORRELATION_MISMATCH");
      }
      return success(existing.currentSavepoint);
    }
    let objectDirectory: string | undefined;
    try {
      const repository = this.#canonicalRepository(request.workspace.canonicalWorktreePath);
      objectDirectory = this.#objectDirectory(request.delivery);
      const observed = this.#snapshot(repository, undefined, objectDirectory);
      if (observed !== request.workspace.admittedGitTree) {
        rmSync(path.dirname(objectDirectory), { recursive: true, force: true });
        return failure("GIT_STATE_MISMATCH");
      }
      const workspaceTree = observed;
      const savepoint: SavepointRef = {
        deliveryIdentity: request.delivery.deliveryIdentity,
        savepointIdentity: stableId<SavepointId>("savepoint", {
          delivery: request.delivery,
          tree: observed,
          kind: "baseline",
        }),
        gitTree: observed,
      };
      const record: CustodyRecord = {
        delivery: request.delivery,
        workspace: request.workspace,
        currentSavepoint: savepoint,
        savepoints: [savepoint],
        workspaceTrees: { [savepoint.savepointIdentity]: workspaceTree },
        handles: [],
        views: [],
      };
      this.#store(record);
      return success(savepoint);
    } catch (error) {
      if (objectDirectory !== undefined) {
        rmSync(path.dirname(objectDirectory), { recursive: true, force: true });
      }
      return failure(error instanceof ManagedWorkspaceSnapshotError
        ? error.code
        : error instanceof GitCommandError ? "GIT_STATE_MISMATCH" : "CORRELATION_MISMATCH");
    }
  }

  async acquireWriteHandle(request: Parameters<HostCustody["acquireWriteHandle"]>[0]): Promise<Result<AuthorizedInvocationHandle, CustodyError>> {
    const record = this.#loadFromEpisode(request.episode);
    if (record === undefined) return failure("BASELINE_MISSING");
    if (!this.#episodeMatchesRecord(request.episode, record) || !same(record.currentSavepoint, request.savepoint)) {
      return failure("CORRELATION_MISMATCH");
    }
    if (!request.access.every((rule) => validRelativePath(rule.path))) return failure("CORRELATION_MISMATCH");
    const accessDigest = digest(request.access);
    const handle: StoredHandle = {
      handleIdentity: stableId<HandleId>("handle", {
        episode: request.episode,
        savepoint: request.savepoint,
        accessDigest,
        nonce: randomBytes(24).toString("hex"),
      }),
      episode: request.episode,
      savepoint: request.savepoint,
      accessDigest,
      access: request.access,
    };
    record.handles.push(handle);
    this.#store(record);
    return success(this.#publicHandle(handle));
  }

  async openReadView(request: Parameters<HostCustody["openReadView"]>[0]): Promise<Result<AuthorizedReadView, CustodyError>> {
    const record = this.#loadFromEpisode(request.episode);
    if (record === undefined) return failure("BASELINE_MISSING");
    if (!this.#episodeMatchesRecord(request.episode, record) || !same(record.currentSavepoint, request.source)) {
      return failure("CORRELATION_MISMATCH");
    }
    if (request.access.some((rule) => rule.mode !== "read" || !validRelativePath(rule.path))) {
      return failure("READ_VIEW_INVALID");
    }
    const accessDigest = digest(request.access);
    const view: StoredView = {
      viewIdentity: stableId<ReadViewId>("read-view", {
        episode: request.episode,
        source: request.source,
        accessDigest,
        nonce: randomBytes(24).toString("hex"),
      }),
      episode: request.episode,
      source: request.source,
      accessDigest,
      access: request.access,
    };
    record.views.push(view);
    this.#store(record);
    return success(this.#publicView(view));
  }

  async settleWorkspaceAttempt(request: Parameters<HostCustody["settleWorkspaceAttempt"]>[0]): Promise<Result<CustodyAttemptDisposition, CustodyError>> {
    const record = this.#loadFromEpisode(request.episode);
    if (record === undefined) return failure("BASELINE_MISSING");
    if (!this.#episodeMatchesRecord(request.episode, record)) return failure("CORRELATION_MISMATCH");
    if (request.workspace.kind === "read") {
      const registered = this.#registeredView(record, request.workspace.view);
      if (registered === undefined || !same(registered.episode, request.episode)) return failure("CORRELATION_MISMATCH");
      const validation = await this.validateReadView(request.workspace.view);
      if (!validation.ok) return validation;
      if (validation.value.kind !== "current") {
        return success(validation.value.kind === "mutation-detected"
          ? { kind: "scope-violation-restored", restoredSavepoint: registered.source }
          : { kind: "restore-failed", state: known(record.currentSavepoint) });
      }
      if (request.hostDecision === "reject") {
        return this.#restoreDisposition(record, registered.source, "host-rejected-restored");
      }
      return success({ kind: "accepted", nextSavepoint: known({ kind: "ABSENT" }) });
    }
    if (request.workspace.kind === "none") {
      return this.#settleNoWorkspace(record, request.hostDecision);
    }
    const registered = this.#registeredHandle(record, request.workspace.handle);
    if (registered === undefined || !same(registered.episode, request.episode)) return failure("CORRELATION_MISMATCH");
    if (!same(registered.savepoint, record.currentSavepoint)) return failure("CORRELATION_MISMATCH");
    try {
      const repository = this.#canonicalRepository(record.workspace.canonicalWorktreePath);
      const objectDirectory = this.#objectDirectory(record.delivery);
      const nextTree = this.#snapshot(repository, registered.savepoint.gitTree, objectDirectory);
      const priorWorkspaceTree = this.#workspaceTree(record, registered.savepoint);
      const nextWorkspaceTree = nextTree;
      const changed = this.#changedPaths(repository, priorWorkspaceTree, nextWorkspaceTree, objectDirectory);
      if (!changed.every((changedPath) => pathAllowed(changedPath, registered.access))) {
        return this.#restoreDisposition(record, registered.savepoint, "scope-violation-restored");
      }
      if (request.hostDecision === "reject") {
        return this.#restoreDisposition(record, registered.savepoint, "host-rejected-restored");
      }
      const nextSavepoint: SavepointRef = {
        deliveryIdentity: record.delivery.deliveryIdentity,
        savepointIdentity: stableId<SavepointId>("savepoint", {
          delivery: record.delivery,
          tree: nextTree,
          predecessor: registered.savepoint.savepointIdentity,
        }),
        gitTree: nextTree,
      };
      record.currentSavepoint = nextSavepoint;
      record.savepoints.push(nextSavepoint);
      record.workspaceTrees[nextSavepoint.savepointIdentity] = nextWorkspaceTree;
      record.handles = record.handles.filter((candidate) => candidate.handleIdentity !== registered.handleIdentity);
      this.#store(record);
      return success({ kind: "accepted", nextSavepoint: known(nextSavepoint) });
    } catch {
      return success({ kind: "restore-failed", state: known(record.currentSavepoint) });
    }
  }

  async validateReadView(view: AuthorizedReadView): Promise<Result<ReadViewDisposition, CustodyError>> {
    const record = this.#loadFromEpisode(view.episode);
    if (record === undefined) return failure("BASELINE_MISSING");
    const registered = this.#registeredView(record, view);
    if (registered === undefined) return failure("READ_VIEW_INVALID");
    if (!same(record.currentSavepoint, registered.source)) {
      return success({ kind: "source-changed", observed: known(record.currentSavepoint.gitTree) });
    }
    try {
      const repository = this.#canonicalRepository(record.workspace.canonicalWorktreePath);
      const workspaceTree = this.#workspaceTree(record, registered.source);
      const observed = this.#snapshot(
        repository,
        workspaceTree,
        this.#objectDirectory(record.delivery),
      );
      if (observed === workspaceTree) return success({ kind: "current", view: this.#publicView(registered) });
      const restored = this.#restore(record, registered.source);
      return success({ kind: "mutation-detected", restored: restored ? known(registered.source) : custodyUnknown("CALL_INTERRUPTED") });
    } catch {
      return failure("READ_VIEW_INVALID");
    }
  }

  async preserveResult(request: Parameters<CoordinatorCustody["preserveResult"]>[0]): Promise<Result<PreservedResultRef, CustodyError>> {
    const record = this.#load(request.checkpoint.thread.delivery);
    if (record === undefined) return failure("BASELINE_MISSING");
    if (!same(record.delivery, request.checkpoint.thread.delivery)) return failure("CORRELATION_MISMATCH");
    if (request.checkpoint.savepoint.state === "known" && !same(request.checkpoint.savepoint.value, record.currentSavepoint)) {
      return failure("CORRELATION_MISMATCH");
    }
    const preserved: PreservedResultRef = {
      identity: stableId("preserved-result", {
        delivery: record.delivery,
        checkpoint: request.checkpoint.identity,
        result: request.result.identity,
        content: request.result.contentIdentity,
      }),
      delivery: record.delivery,
      contentIdentity: request.result.contentIdentity,
      savepoint: request.checkpoint.savepoint,
    };
    if (record.preservedResult !== undefined && !same(record.preservedResult, preserved)) {
      return failure("CORRELATION_MISMATCH");
    }
    const resultPath = path.join(this.#recordsDirectory, `${this.#deliveryKey(record.delivery)}.result.json`);
    this.#atomicWrite(resultPath, canonical({ reference: preserved, result: request.result }));
    record.preservedResult = preserved;
    this.#store(record);
    return success(preserved);
  }

  async publish(request: Parameters<CoordinatorCustody["publish"]>[0]): Promise<Result<PublicationDisposition, CustodyError>> {
    const record = this.#load(request.result.delivery);
    const target = this.#publicationTargets.get(request.target.identity);
    if (record === undefined || record.preservedResult === undefined || !same(record.preservedResult, request.result)) {
      return failure("CORRELATION_MISMATCH");
    }
    if (target === undefined || !same(target.target, request.target)) return failure("PUBLICATION_GUARD_INVALID");
    if (record.currentSavepoint.gitTree !== request.guard.expectedGitTree) return failure("PUBLICATION_GUARD_INVALID");
    if (request.result.savepoint.state !== "known" || request.result.savepoint.value.gitTree !== request.guard.expectedGitTree) {
      return failure("PUBLICATION_GUARD_INVALID");
    }
    try {
      const workspaceRepository = this.#canonicalRepository(record.workspace.canonicalWorktreePath);
      const targetRepository = this.#canonicalRepository(target.repositoryPath);
      if (workspaceRepository !== targetRepository) return failure("PUBLICATION_GUARD_INVALID");
      const expectedWorkspaceTree = this.#workspaceTree(record, record.currentSavepoint);
      const observedWorkspaceTree = this.#snapshot(
        workspaceRepository,
        expectedWorkspaceTree,
        this.#objectDirectory(record.delivery),
      );
      if (observedWorkspaceTree !== expectedWorkspaceTree) return failure("PUBLICATION_GUARD_INVALID");
      const reference = {
        identity: stableId<PublicationId>("publication", {
          delivery: record.delivery,
          target: request.target,
          result: request.result,
          guard: request.guard,
        }),
        target: request.target,
        result: request.result,
      };
      const targetTree = this.#tryResolveTree(targetRepository, target.ref);
      if (targetTree === request.guard.expectedGitTree) {
        const disposition: PublicationDisposition = { kind: "already-at-target", reference };
        record.publication = disposition;
        this.#store(record);
        return success(disposition);
      }
      if (targetTree !== undefined) {
        const disposition: PublicationDisposition = { kind: "conflict", preservedResult: request.result };
        record.publication = disposition;
        this.#store(record);
        return success(disposition);
      }
      try {
        this.#promotePublishedTree(
          targetRepository,
          request.guard.expectedGitTree,
          this.#objectDirectory(record.delivery),
        );
        const publicationCommit = git(
          targetRepository,
          ["commit-tree", request.guard.expectedGitTree, "-m", `Custody publication ${reference.identity}`],
          {
            ...process.env,
            GIT_AUTHOR_NAME: "AgentOps Custody",
            GIT_AUTHOR_EMAIL: "custody@agentops.invalid",
            GIT_COMMITTER_NAME: "AgentOps Custody",
            GIT_COMMITTER_EMAIL: "custody@agentops.invalid",
          },
        );
        git(targetRepository, ["update-ref", target.ref, publicationCommit, "0000000000000000000000000000000000000000"]);
      } catch {
        const disposition: PublicationDisposition = {
          kind: "unknown",
          preservedResult: request.result,
          uncertainty: custodyUnknown("PUBLICATION_DISPOSITION_UNOBSERVED"),
        };
        record.publication = disposition;
        this.#store(record);
        return success(disposition);
      }
      const disposition: PublicationDisposition = { kind: "published", reference };
      record.publication = disposition;
      this.#store(record);
      return success(disposition);
    } catch {
      return failure("PUBLICATION_GUARD_INVALID");
    }
  }

  async inspect(delivery: DeliveryRef): Promise<Result<CustodyInspection, CustodyError>> {
    const record = this.#load(delivery);
    if (record === undefined) return failure("BASELINE_MISSING");
    if (!same(record.delivery, delivery)) return failure("CORRELATION_MISMATCH");
    return success({
      delivery: record.delivery,
      currentSavepoint: known(record.currentSavepoint),
      preservedResult: record.preservedResult === undefined ? custodyUnknown("CALL_INTERRUPTED") : known(record.preservedResult),
      publication: record.publication === undefined ? custodyUnknown("PUBLICATION_DISPOSITION_UNOBSERVED") : known(record.publication),
    });
  }

  async recover(request: Parameters<CoordinatorCustody["recover"]>[0]): Promise<Result<CustodyRecoveryDisposition, CustodyError>> {
    const record = this.#load(request.delivery);
    if (record === undefined) return failure("BASELINE_MISSING");
    if (!same(record.delivery, request.delivery)) return failure("CORRELATION_MISMATCH");
    if (request.directive === "intervene" || request.savepoint.state === "unknown") {
      return success({ kind: "intervention-required", state: request.savepoint });
    }
    const requested = request.savepoint.value;
    if (requested.deliveryIdentity !== record.delivery.deliveryIdentity
      || !record.savepoints.some((candidate) => same(candidate, requested))) {
      return failure("CORRELATION_MISMATCH");
    }
    if (request.directive === "continue") {
      if (!same(record.currentSavepoint, requested)) return failure("CORRELATION_MISMATCH");
      return success({ kind: "continued", savepoint: requested });
    }
    return this.#restore(record, requested)
      ? success({ kind: "restored", savepoint: requested })
      : success({ kind: "intervention-required", state: custodyUnknown("CALL_INTERRUPTED") });
  }

  async retire(authorization: Parameters<CoordinatorCustody["retire"]>[0]): Promise<Result<OwnerRetirementDisposition, CustodyError>> {
    const record = this.#load(authorization.delivery);
    if (record === undefined || !same(record.delivery, authorization.delivery)) return failure("RETIREMENT_NOT_AUTHORIZED");
    if (record.preservedResult === undefined || record.publication === undefined || record.publication.kind === "unknown") {
      return failure("RETIREMENT_NOT_AUTHORIZED");
    }
    if (record.retiredAuthorizationIdentity !== undefined && record.retiredAuthorizationIdentity !== authorization.identity) {
      return failure("RETIREMENT_NOT_AUTHORIZED");
    }
    record.handles = [];
    record.views = [];
    record.retiredAuthorizationIdentity = authorization.identity;
    this.#store(record);
    rmSync(path.dirname(this.#objectDirectory(record.delivery)), { recursive: true, force: true });
    return success({
      owner: "custody",
      authorization,
      state: "retired",
    });
  }

  #settleNoWorkspace(record: CustodyRecord, hostDecision: "accept" | "reject"): Result<CustodyAttemptDisposition, CustodyError> {
    try {
      const repository = this.#canonicalRepository(record.workspace.canonicalWorktreePath);
      const workspaceTree = this.#workspaceTree(record, record.currentSavepoint);
      const observed = this.#snapshot(
        repository,
        workspaceTree,
        this.#objectDirectory(record.delivery),
      );
      if (observed !== workspaceTree || hostDecision === "reject") {
        return this.#restoreDisposition(record, record.currentSavepoint,
          observed !== workspaceTree ? "scope-violation-restored" : "host-rejected-restored");
      }
      return success({ kind: "accepted", nextSavepoint: known({ kind: "ABSENT" }) });
    } catch {
      return success({ kind: "restore-failed", state: known(record.currentSavepoint) });
    }
  }

  #restoreDisposition(
    record: CustodyRecord,
    savepoint: SavepointRef,
    kind: "host-rejected-restored" | "scope-violation-restored",
  ): Result<CustodyAttemptDisposition, CustodyError> {
    return this.#restore(record, savepoint)
      ? success({ kind, restoredSavepoint: savepoint })
      : success({ kind: "restore-failed", state: known(record.currentSavepoint) });
  }

  #restore(record: CustodyRecord, savepoint: SavepointRef): boolean {
    try {
      const repository = this.#canonicalRepository(record.workspace.canonicalWorktreePath);
      const targetWorkspaceTree = this.#workspaceTree(record, savepoint);
      const objectDirectory = this.#objectDirectory(record.delivery);
      const currentWorkspaceTree = this.#snapshot(repository, targetWorkspaceTree, objectDirectory);
      for (const changedPath of this.#changedPaths(repository, targetWorkspaceTree, currentWorkspaceTree, objectDirectory)) {
        this.#removeWorkspacePath(repository, changedPath);
      }
      this.#materializeTree(repository, targetWorkspaceTree, objectDirectory);
      if (this.#snapshot(repository, savepoint.gitTree, objectDirectory) !== savepoint.gitTree
        || this.#snapshot(repository, targetWorkspaceTree, objectDirectory) !== targetWorkspaceTree) {
        return false;
      }
      record.currentSavepoint = savepoint;
      this.#store(record);
      return true;
    } catch {
      return false;
    }
  }

  #snapshot(repository: string, baseTree: GitTreeId | undefined, objectDirectory: string): GitTreeId {
    return captureManagedWorkspaceTree(repository, baseTree, objectDirectory, this.#snapshotLimits);
  }

  #changedPaths(repository: string, from: GitTreeId, to: GitTreeId, objectDirectory: string): string[] {
    if (from === to) return [];
    return git(
      repository,
      ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", from, to],
      managedWorkspaceObjectEnvironment(repository, objectDirectory),
      false,
    )
      .split("\0")
      .filter((item) => item.length > 0);
  }

  #workspaceTree(record: CustodyRecord, savepoint: SavepointRef): GitTreeId {
    const workspaceTree = record.workspaceTrees[savepoint.savepointIdentity];
    if (workspaceTree === undefined) throw new GitCommandError("workspace tree is missing");
    return workspaceTree;
  }

  #removeWorkspacePath(repository: string, relativePath: string): void {
    const candidate = path.resolve(repository, relativePath);
    if (candidate === repository || !candidate.startsWith(`${repository}${path.sep}`)) {
      throw new GitCommandError("workspace diff escaped the canonical root");
    }
    rmSync(candidate, { recursive: true, force: true });
  }

  #materializeTree(repository: string, tree: GitTreeId, objectDirectory: string): void {
    const temporary = mkdtempSync(path.join(tmpdir(), "custody-restore-index-"));
    const index = path.join(temporary, "index");
    const environment = managedWorkspaceObjectEnvironment(repository, objectDirectory, {
      GIT_INDEX_FILE: index,
      GIT_WORK_TREE: repository,
    });
    try {
      git(repository, ["read-tree", tree], environment);
      git(repository, ["checkout-index", "--all", "--force"], environment);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  #objectDirectory(delivery: DeliveryRef): string {
    return path.join(this.#recordsDirectory, "objects", this.#deliveryKey(delivery), "objects");
  }

  #promotePublishedTree(repository: string, tree: GitTreeId, objectDirectory: string): void {
    const pack = execFileSync("git", ["pack-objects", "--stdout", "--revs"], {
      cwd: repository,
      env: managedWorkspaceObjectEnvironment(repository, objectDirectory),
      input: `${tree}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["unpack-objects", "-r"], {
      cwd: repository,
      input: pack,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (git(repository, ["cat-file", "-t", tree]) !== "tree") {
      throw new GitCommandError("published tree promotion failed");
    }
  }

  #tryResolveTree(repository: string, reference: string): GitTreeId | undefined {
    try {
      return git(repository, ["rev-parse", "--verify", `${reference}^{tree}`]) as GitTreeId;
    } catch {
      return undefined;
    }
  }

  #canonicalRepository(repository: AbsolutePath): string {
    const requested = realpathSync(path.resolve(repository));
    const root = realpathSync(git(requested, ["rev-parse", "--show-toplevel"]));
    if (requested !== root) throw new GitCommandError("workspace is not the canonical Git worktree root");
    return root;
  }

  #registeredHandle(record: CustodyRecord, handle: AuthorizedInvocationHandle): StoredHandle | undefined {
    const registered = record.handles.find((candidate) => candidate.handleIdentity === handle.handleIdentity);
    return registered !== undefined && same(this.#publicHandle(registered), handle) ? registered : undefined;
  }

  #registeredView(record: CustodyRecord, view: AuthorizedReadView): StoredView | undefined {
    const registered = record.views.find((candidate) => candidate.viewIdentity === view.viewIdentity);
    return registered !== undefined && same(this.#publicView(registered), view) ? registered : undefined;
  }

  #publicHandle(handle: StoredHandle): AuthorizedInvocationHandle {
    return {
      handleIdentity: handle.handleIdentity,
      episode: handle.episode,
      savepoint: handle.savepoint,
      accessDigest: handle.accessDigest,
    };
  }

  #publicView(view: StoredView): AuthorizedReadView {
    return {
      viewIdentity: view.viewIdentity,
      episode: view.episode,
      source: view.source,
      accessDigest: view.accessDigest,
    };
  }

  #episodeMatchesRecord(episode: EpisodeRef, record: CustodyRecord): boolean {
    return same(episode.thread.delivery, record.delivery);
  }

  #loadFromEpisode(episode: EpisodeRef): CustodyRecord | undefined {
    return this.#load(episode.thread.delivery);
  }

  #load(delivery: DeliveryRef): CustodyRecord | undefined {
    const recordPath = this.#recordPath(delivery);
    if (!existsSync(recordPath)) return undefined;
    try {
      return JSON.parse(readFileSync(recordPath, "utf8")) as CustodyRecord;
    } catch {
      return undefined;
    }
  }

  #store(record: CustodyRecord): void {
    this.#atomicWrite(this.#recordPath(record.delivery), `${canonical(record)}\n`);
  }

  #atomicWrite(destination: string, content: string): void {
    mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, destination);
  }

  #recordPath(delivery: DeliveryRef): string {
    return path.join(this.#recordsDirectory, `${this.#deliveryKey(delivery)}.json`);
  }

  #deliveryKey(delivery: DeliveryRef): string {
    return createHash("sha256").update(canonical(delivery)).digest("hex");
  }
}

export function createGitCustody(options: GitCustodyOptions): GitCustody {
  return new GitCustody(options);
}
