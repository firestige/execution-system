import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { parseDocument } from "yaml";

import { canonicalJsonBytes, deepFreeze } from "../configuration/index.js";

const DOCUMENT_SCHEMA_VERSION = "execution.repository-role-provider-bindings@1.0.0" as const;
const SNAPSHOT_SCHEMA_VERSION = "execution.repository-role-provider-bindings-snapshot@1.0.0" as const;
const DOCUMENT_RELATIVE_PATH = ".wsr/role-provider-bindings.json" as const;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_BINDINGS = 1_024;
const IDENTITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type UnknownRecord = Record<string, unknown>;

export type RepositoryModelBindingsErrorCode =
  | "REPOSITORY_MODEL_BINDINGS_PATH_INVALID"
  | "REPOSITORY_MODEL_BINDINGS_READ_FAILED"
  | "REPOSITORY_MODEL_BINDINGS_TOO_LARGE"
  | "REPOSITORY_MODEL_BINDINGS_PARSE_FAILED"
  | "REPOSITORY_MODEL_BINDINGS_DUPLICATE_KEY"
  | "REPOSITORY_MODEL_BINDINGS_VERSION_UNSUPPORTED"
  | "REPOSITORY_MODEL_BINDINGS_TOO_MANY"
  | "REPOSITORY_MODEL_BINDINGS_INVALID";

export class RepositoryModelBindingsError extends Error {
  constructor(readonly code: RepositoryModelBindingsErrorCode) {
    super(code);
    this.name = "RepositoryModelBindingsError";
  }
}

export interface ExactModelSelection {
  readonly provider: string;
  readonly model: string;
}

export interface ExactRoleProviderModelSelection {
  readonly agentProvider: Readonly<{
    identity: string;
    version: string;
  }>;
  readonly model: ExactModelSelection;
}

export type RepositoryModelBindingsSnapshot =
  | Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
    documentState: "ABSENT";
  }>
  | Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
    documentState: "PRESENT";
    documentDigest: string;
    bindings: Readonly<Record<string, ExactRoleProviderModelSelection>>;
  }>;

function inside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function record(value: unknown): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return undefined;
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function parseStrictJson(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_PARSE_FAILED"); }
  const diagnostic = parseDocument(text, { schema: "json", uniqueKeys: true });
  if (diagnostic.errors.length > 0) {
    const duplicate = diagnostic.errors.some((error) => error.code === "DUPLICATE_KEY" || /unique keys|duplicate key/iu.test(error.message));
    throw new RepositoryModelBindingsError(duplicate
      ? "REPOSITORY_MODEL_BINDINGS_DUPLICATE_KEY"
      : "REPOSITORY_MODEL_BINDINGS_PARSE_FAILED");
  }
  return value;
}

function normalizeDocument(value: unknown): Readonly<Record<string, ExactRoleProviderModelSelection>> {
  const root = record(value);
  if (root === undefined) throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_INVALID");
  if (root.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_VERSION_UNSUPPORTED");
  }
  if (!exactKeys(root, ["bindings", "schemaVersion"])) {
    throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_INVALID");
  }
  const bindings = record(root.bindings);
  if (bindings === undefined) throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_INVALID");
  if (Object.keys(bindings).length > MAX_BINDINGS) {
    throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_TOO_MANY");
  }
  const normalized: Record<string, ExactRoleProviderModelSelection> = {};
  for (const [roleId, candidate] of Object.entries(bindings)) {
    const selection = record(candidate);
    const agentProvider = record(selection?.agentProvider);
    const model = record(selection?.model);
    if (!IDENTITY.test(roleId) || selection === undefined || !exactKeys(selection, ["agentProvider", "model"])
      || agentProvider === undefined || !exactKeys(agentProvider, ["identity", "version"])
      || typeof agentProvider.identity !== "string" || !IDENTITY.test(agentProvider.identity)
      || typeof agentProvider.version !== "string" || !VERSION.test(agentProvider.version)
      || model === undefined || !exactKeys(model, ["model", "provider"])
      || typeof model.provider !== "string" || !IDENTITY.test(model.provider)
      || typeof model.model !== "string" || !IDENTITY.test(model.model)) {
      throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_INVALID");
    }
    normalized[roleId] = {
      agentProvider: { identity: agentProvider.identity, version: agentProvider.version },
      model: { provider: model.provider, model: model.model },
    };
  }
  return normalized;
}

function canonicalDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")}`;
}

export async function loadRepositoryModelBindings(canonicalWorktree: string): Promise<RepositoryModelBindingsSnapshot> {
  if (!isAbsolute(canonicalWorktree)) throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_PATH_INVALID");
  let worktree: string;
  try {
    worktree = await realpath(resolve(canonicalWorktree));
    if (!(await stat(worktree)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_PATH_INVALID");
  }
  const path = join(worktree, DOCUMENT_RELATIVE_PATH);
  try { await lstat(path); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return deepFreeze({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, documentState: "ABSENT" });
    }
    throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_READ_FAILED");
  }

  let bytes: Buffer;
  try {
    const canonicalPath = await realpath(path);
    if (!inside(worktree, canonicalPath) || !(await stat(canonicalPath)).isFile()) {
      throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_PATH_INVALID");
    }
    bytes = await readFile(canonicalPath);
  } catch (cause) {
    if (cause instanceof RepositoryModelBindingsError) throw cause;
    throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_READ_FAILED");
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_TOO_LARGE");
  }

  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_PARSE_FAILED"); }
  const parsed = parseStrictJson(text);
  const bindings = normalizeDocument(parsed);
  return deepFreeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    documentState: "PRESENT",
    documentDigest: canonicalDigest(parsed as JsonValue),
    bindings,
  });
}
