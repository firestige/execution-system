import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadRepositoryModelBindings,
  RepositoryModelBindingsError,
} from "../../src/delivery/index.js";

async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repository-model-bindings-"));
  const path = join(root, "worktree");
  await mkdir(path);
  return path;
}

async function writeBindings(root: string, text: string): Promise<void> {
  await mkdir(join(root, ".wsr"), { recursive: true });
  await writeFile(join(root, ".wsr", "role-provider-bindings.json"), text);
}

function digest(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, ordered((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(ordered(value)), "utf8").digest("hex")}`;
}

describe("repository Role-to-Provider/model bindings", () => {
  it("represents an absent conventional document without inventing an empty-document digest", async () => {
    const root = await worktree();

    await expect(loadRepositoryModelBindings(root)).resolves.toEqual({
      schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0",
      documentState: "ABSENT",
    });
  });

  it("loads one closed document, freezes it, and hashes canonical full-document JSON", async () => {
    const root = await worktree();
    const document = {
      bindings: {
        "role.evidence-scout": {
          agentProvider: { identity: "provider.codex", version: "0.144.5" },
          model: { provider: "openai", model: "gpt-5.3-codex" },
        },
        "role.architecture-reviewer": {
          agentProvider: { identity: "provider.dsh", version: "0.1.1-rc.2" },
          model: { provider: "deepseek-official", model: "deepseek-reasoner" },
        },
      },
      schemaVersion: "execution.repository-role-provider-bindings@1.0.0",
    };
    await writeBindings(root, JSON.stringify(document, null, 2));

    const loaded = await loadRepositoryModelBindings(root);

    expect(loaded).toEqual({
      schemaVersion: "execution.repository-role-provider-bindings-snapshot@1.0.0",
      documentState: "PRESENT",
      documentDigest: digest(document),
      bindings: document.bindings,
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(loaded.documentState === "PRESENT" && Object.isFrozen(loaded.bindings)).toBe(true);
    expect(loaded.documentState === "PRESENT" && Object.isFrozen(loaded.bindings["role.evidence-scout"])).toBe(true);
  });

  it("rejects duplicate members, unknown fields, malformed identities, and unsupported versions", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['{"schemaVersion":"execution.repository-role-provider-bindings@1.0.0","bindings":{},"bindings":{}}', "REPOSITORY_MODEL_BINDINGS_DUPLICATE_KEY"],
      [JSON.stringify({ schemaVersion: "execution.repository-role-provider-bindings@1.0.0", bindings: {}, fallback: {} }), "REPOSITORY_MODEL_BINDINGS_INVALID"],
      [JSON.stringify({ schemaVersion: "execution.repository-role-provider-bindings@2.0.0", bindings: {} }), "REPOSITORY_MODEL_BINDINGS_VERSION_UNSUPPORTED"],
      [JSON.stringify({ schemaVersion: "execution.repository-role-provider-bindings@1.0.0", bindings: { "bad role": { agentProvider: { identity: "provider.dsh", version: "1.0.0" }, model: { provider: "route", model: "model" } } } }), "REPOSITORY_MODEL_BINDINGS_INVALID"],
      [JSON.stringify({ schemaVersion: "execution.repository-role-provider-bindings@1.0.0", bindings: { role: { agentProvider: { identity: "provider.dsh", version: "latest" }, model: { provider: "route", model: "model" } } } }), "REPOSITORY_MODEL_BINDINGS_INVALID"],
      [JSON.stringify({ schemaVersion: "execution.repository-role-provider-bindings@1.0.0", bindings: { role: { agentProvider: { identity: "provider.dsh", version: "1.0.0" }, model: { provider: "route", model: "" } } } }), "REPOSITORY_MODEL_BINDINGS_INVALID"],
      [JSON.stringify({ schemaVersion: "execution.repository-role-provider-bindings@1.0.0", bindings: { role: { agentProvider: { identity: "provider.dsh", version: "1.0.0" }, model: { provider: "route", model: "model" }, fallback: "provider.other" } } }), "REPOSITORY_MODEL_BINDINGS_INVALID"],
    ];

    for (const [text, code] of cases) {
      const root = await worktree();
      await writeBindings(root, text);
      await expect(loadRepositoryModelBindings(root)).rejects.toMatchObject({ code });
    }
  });

  it("enforces the 256 KiB and 1,024-binding bounds", async () => {
    const tooMany = await worktree();
    await writeBindings(tooMany, JSON.stringify({
      schemaVersion: "execution.repository-role-provider-bindings@1.0.0",
      bindings: Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [`role${index}`, { agentProvider: { identity: "provider.dsh", version: "1.0.0" }, model: { provider: "route", model: "model" } }])),
    }));
    await expect(loadRepositoryModelBindings(tooMany)).rejects.toMatchObject({ code: "REPOSITORY_MODEL_BINDINGS_TOO_MANY" });

    const tooLarge = await worktree();
    await writeBindings(tooLarge, `${JSON.stringify({ schemaVersion: "execution.repository-role-provider-bindings@1.0.0", bindings: {} })}${" ".repeat(262_145)}`);
    await expect(loadRepositoryModelBindings(tooLarge)).rejects.toMatchObject({ code: "REPOSITORY_MODEL_BINDINGS_TOO_LARGE" });
  });

  it("fails closed for a binding document whose resolved path escapes the canonical worktree", async () => {
    const root = await worktree();
    const outside = await worktree();
    await writeBindings(outside, JSON.stringify({ schemaVersion: "execution.repository-role-provider-bindings@1.0.0", bindings: {} }));
    await mkdir(join(root, ".wsr"));
    await symlink(join(outside, ".wsr", "role-provider-bindings.json"), join(root, ".wsr", "role-provider-bindings.json"));

    await expect(loadRepositoryModelBindings(root)).rejects.toMatchObject({ code: "REPOSITORY_MODEL_BINDINGS_PATH_INVALID" });
  });

  it("exposes typed diagnostics without document bytes or filesystem causes", () => {
    const error = new RepositoryModelBindingsError("REPOSITORY_MODEL_BINDINGS_INVALID");
    expect(error.message).toBe("REPOSITORY_MODEL_BINDINGS_INVALID");
    expect(error).not.toHaveProperty("cause");
  });
});
