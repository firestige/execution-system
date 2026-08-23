import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { NetworkPort } from "../../src/bootstrap/index.js";
import type { WorkflowSourceConfiguration } from "../../src/configuration/index.js";
import {
  GitHubWorkflowPackageSource,
  WorkflowPackageSourceRegistry,
  createConfiguredWorkflowPackageSource,
  parseWorkflowSelector,
  type WorkflowPackageSource,
} from "../../src/delivery/index.js";

function bytes(value: unknown): Uint8Array {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
}

describe("Workflow Package selector", () => {
  it("normalizes bare and @latest selectors to latest and preserves an exact version", () => {
    expect(parseWorkflowSelector("contributed")).toEqual({ name: "contributed", version: { kind: "LATEST" } });
    expect(parseWorkflowSelector("contributed@latest")).toEqual({ name: "contributed", version: { kind: "LATEST" } });
    expect(parseWorkflowSelector("contributed@1.2.3")).toEqual({ name: "contributed", version: { kind: "EXACT", value: "1.2.3" } });
  });

  it.each(["", "@latest", "bad/name", "name@", "name@v1", "name@1", "name@1.2", "name@1.2.3@latest"])(
    "rejects invalid selector %j without fallback",
    (selector) => expect(() => parseWorkflowSelector(selector)).toThrowError(expect.objectContaining({ code: "INVALID_WORKFLOW_SELECTOR" })),
  );
});

describe("configured Workflow Package Source", () => {
  it("fetches one exact GitHub Release asset using only configured coordinates", async () => {
    const archive = bytes("archive-content");
    const calls: string[] = [];
    const network: NetworkPort = Object.freeze({
      request: vi.fn(async (url: string) => {
        calls.push(url);
        if (calls.length === 1) return {
          status: 200,
          body: bytes({
            tag_name: "1.2.3",
            assets: [{
              name: "workflow-package-contributed-1.2.3.tar.gz",
              browser_download_url: "https://github.com/example/workflows/releases/download/1.2.3/workflow-package-contributed-1.2.3.tar.gz",
            }],
          }),
        };
        return { status: 200, body: archive };
      }),
    });
    const source = new GitHubWorkflowPackageSource({
      kind: "github",
      repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, network);
    const result = await source.fetch({ name: "contributed", version: { kind: "EXACT", value: "1.2.3" } });
    expect(result).toMatchObject({
      kind: "FOUND",
      candidate: {
        name: "contributed",
        exactVersion: "1.2.3",
        archiveDigest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      },
    });
    expect(calls).toEqual([
      "https://api.github.com/repos/example/workflows/releases/tags/1.2.3",
      "https://github.com/example/workflows/releases/download/1.2.3/workflow-package-contributed-1.2.3.tar.gz",
    ]);
  });

  it("resolves latest metadata to an exact version before selecting the asset", async () => {
    const calls: string[] = [];
    const source = new GitHubWorkflowPackageSource({
      kind: "github",
      repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, Object.freeze({
      request: async (url: string) => {
        calls.push(url);
        return calls.length === 1
          ? { status: 200, body: bytes({ tag_name: "2.0.0", assets: [{ name: "workflow-package-demo-2.0.0.tar.gz", browser_download_url: "https://github.com/example/workflows/releases/download/2.0.0/workflow-package-demo-2.0.0.tar.gz" }] }) }
          : { status: 200, body: bytes("latest") };
      },
    }));
    expect(await source.fetch({ name: "demo", version: { kind: "LATEST" } })).toMatchObject({
      kind: "FOUND",
      candidate: { exactVersion: "2.0.0" },
    });
    expect(calls[0]).toBe("https://api.github.com/repos/example/workflows/releases/latest");
  });

  it("requires the Release tag to equal the exact semantic version without alias normalization", async () => {
    const source = new GitHubWorkflowPackageSource({
      kind: "github",
      repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, Object.freeze({
      request: async () => ({ status: 200, body: bytes({
        tag_name: "v2.0.0",
        assets: [{ name: "workflow-package-demo-2.0.0.tar.gz", browser_download_url: "https://example.invalid/asset" }],
      }) }),
    }));
    expect(await source.fetch({ name: "demo", version: { kind: "LATEST" } })).toEqual({ kind: "INVALID" });
  });

  it("distinguishes not-found, unavailable, and invalid release metadata", async () => {
    const configuration = {
      kind: "github",
      repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    } as const;
    const request = { name: "demo", version: { kind: "EXACT", value: "1.0.0" } } as const;
    const source = (status: number, body: unknown) => new GitHubWorkflowPackageSource(configuration, Object.freeze({ request: async () => ({ status, body: bytes(body) }) }));
    expect(await source(404, "missing").fetch(request)).toEqual({ kind: "NOT_FOUND" });
    expect(await source(503, "outage").fetch(request)).toEqual({ kind: "UNAVAILABLE" });
    expect(await source(200, { tag_name: "1.0.0", assets: [] }).fetch(request)).toEqual({ kind: "INVALID" });
    expect(await source(200, "{ malformed").fetch(request)).toEqual({ kind: "INVALID" });
    expect(await source(200, { tag_name: "2.0.0", assets: [] }).fetch(request)).toEqual({ kind: "INVALID" });
    expect(await source(200, { tag_name: "v1.0.0", assets: [] }).fetch(request)).toEqual({ kind: "INVALID" });
    expect(await source(200, {
      tag_name: "1.0.0",
      assets: [{ name: "workflow-package-demo-1.0.0.tar.gz", browser_download_url: "https://user:secret@example.invalid/asset" }],
    }).fetch(request)).toEqual({ kind: "INVALID" });
    expect(await source(200, {
      tag_name: "1.0.0",
      assets: [{ name: "workflow-package-demo-1.0.0.tar.gz", browser_download_url: "not a URL" }],
    }).fetch(request)).toEqual({ kind: "INVALID" });
  });

  it("maps release and asset transport exceptions to unavailable", async () => {
    const configuration = {
      kind: "github",
      repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    } as const;
    const request = { name: "demo", version: { kind: "EXACT", value: "1.0.0" } } as const;
    const releaseFailure = new GitHubWorkflowPackageSource(configuration, Object.freeze({ request: async () => { throw new Error("offline"); } }));
    expect(await releaseFailure.fetch(request)).toEqual({ kind: "UNAVAILABLE" });
    let calls = 0;
    const assetFailure = new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async () => {
        calls += 1;
        if (calls === 1) return { status: 200, body: bytes({
          tag_name: "1.0.0",
          assets: [{ name: "workflow-package-demo-1.0.0.tar.gz", browser_download_url: "https://example.invalid/asset" }],
        }) };
        throw new Error("asset offline");
      },
    }));
    expect(await assetFailure.fetch(request)).toEqual({ kind: "UNAVAILABLE" });
  });

  it("constructs exactly the configured GitHub or alternate Adapter and never falls back", () => {
    const githubConfig: WorkflowSourceConfiguration = {
      kind: "github",
      repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    };
    const network: NetworkPort = Object.freeze({ request: async () => ({ status: 500, body: new Uint8Array() }) });
    const alternate: WorkflowPackageSource = Object.freeze({ fetch: async () => ({ kind: "NOT_FOUND" as const }) });
    const createAlternate = vi.fn(() => alternate);
    const registry = new WorkflowPackageSourceRegistry(Object.freeze({ contributed: createAlternate }));
    expect(createConfiguredWorkflowPackageSource(githubConfig, network, registry)).toBeInstanceOf(GitHubWorkflowPackageSource);
    expect(createAlternate).not.toHaveBeenCalled();
    expect(createConfiguredWorkflowPackageSource({ kind: "adapter", adapterKey: "contributed", adapterConfigFile: "/config/source.json" }, network, registry)).toBe(alternate);
    expect(createAlternate).toHaveBeenCalledExactlyOnceWith("/config/source.json");
    expect(() => createConfiguredWorkflowPackageSource({ kind: "adapter", adapterKey: "missing", adapterConfigFile: "/config/source.json" }, network, registry))
      .toThrowError(expect.objectContaining({ code: "SOURCE_FACTORY_NOT_FOUND" }));
  });
});
