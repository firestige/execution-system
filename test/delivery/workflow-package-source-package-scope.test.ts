import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { NetworkPort } from "../../src/bootstrap/index.js";
import { GitHubWorkflowPackageSource } from "../../src/delivery/index.js";

const bytes = (value: unknown): Uint8Array => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const sha256 = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function scopedRelease(name: string, version: string, descriptorUrl: string, archiveUrl: string, checksumUrl: string, prerelease = false) {
  return {
    tag_name: `workflow-package/${name}/v${version}`,
    draft: false,
    prerelease,
    assets: [
      { name: `workflow-package-${name}-${version}.tar.gz`, browser_download_url: archiveUrl },
      { name: `workflow-package-${name}-${version}.json`, browser_download_url: descriptorUrl },
      { name: `workflow-package-${name}-${version}.tar.gz.sha256`, browser_download_url: checksumUrl },
    ],
  };
}

describe("package-scoped GitHub Workflow Source", () => {
  it("enumerates exact package records and ignores unrelated repository-wide releases", async () => {
    const archive = bytes("demo-2.0.0");
    const descriptorUrl = "https://github.com/example/workflows/releases/download/workflow-package%2Fdemo%2Fv2.0.0/workflow-package-demo-2.0.0.json";
    const archiveUrl = "https://github.com/example/workflows/releases/download/workflow-package%2Fdemo%2Fv2.0.0/workflow-package-demo-2.0.0.tar.gz";
    const checksumUrl = `${archiveUrl}.sha256`;
    const calls: string[] = [];
    const network: NetworkPort = Object.freeze({ request: async (url: string) => {
      calls.push(url);
      if (url.endsWith("?per_page=100&page=1")) return { status: 200, body: bytes([
        scopedRelease("unrelated", "9.0.0", "https://example.test/unrelated.json", "https://example.test/unrelated.tar.gz", "https://example.test/unrelated.sha256"),
        scopedRelease("demo", "1.0.0", "https://example.test/demo-1.json", "https://example.test/demo-1.tar.gz", "https://example.test/demo-1.sha256"),
        scopedRelease("demo", "2.0.0", descriptorUrl, archiveUrl, checksumUrl),
        scopedRelease("demo", "3.0.0-rc.1", "https://example.test/demo-3.json", "https://example.test/demo-3.tar.gz", "https://example.test/demo-3.sha256", true),
      ]) };
      if (url === descriptorUrl) return { status: 200, body: bytes({
        schemaVersion: "workflow-package.package-release@1.0.0",
        revision: "a".repeat(40), tag: "workflow-package/demo/v2.0.0",
        package: { name: "demo", version: "2.0.0", digest: `sha256:${"b".repeat(64)}` },
        archive: { name: "workflow-package-demo-2.0.0.tar.gz", sha256: sha256(archive), bytes: archive.byteLength },
        checksum: { name: "workflow-package-demo-2.0.0.tar.gz.sha256" },
      }) };
      if (url === checksumUrl) return { status: 200, body: bytes(`${sha256(archive).slice(7)}  workflow-package-demo-2.0.0.tar.gz\n`) };
      if (url === archiveUrl) return { status: 200, body: archive };
      return { status: 404, body: bytes("missing") };
    } });
    const source = new GitHubWorkflowPackageSource({
      kind: "github", repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, network);

    expect(await source.fetch({ name: "demo", version: { kind: "EXACT", value: "2.0.0" } })).toMatchObject({
      kind: "FOUND", candidate: { name: "demo", exactVersion: "2.0.0", archiveDigest: sha256(archive) },
    });
    expect(calls[0]).toBe("https://api.github.com/repos/example/workflows/releases?per_page=100&page=1");
    expect(calls).not.toContain("https://api.github.com/repos/example/workflows/releases/latest");
  });

  it("uses the same enumerated locator for exact prerelease while latest is unsupported", async () => {
    const archive = bytes("release-candidate");
    const archiveUrl = "https://example.test/demo-2rc.tar.gz";
    const descriptorUrl = "https://example.test/demo-2rc.json";
    const checksumUrl = `${archiveUrl}.sha256`;
    const network: NetworkPort = Object.freeze({ request: async (url: string) => {
      if (url.includes("?per_page=")) return { status: 200, body: bytes([
        scopedRelease("demo", "2.0.0-rc.2", descriptorUrl, archiveUrl, checksumUrl, true),
      ]) };
      if (url === descriptorUrl) return { status: 200, body: bytes({
        schemaVersion: "workflow-package.package-release@1.0.0",
        revision: "a".repeat(40), tag: "workflow-package/demo/v2.0.0-rc.2",
        package: { name: "demo", version: "2.0.0-rc.2", digest: `sha256:${"b".repeat(64)}` },
        archive: { name: "workflow-package-demo-2.0.0-rc.2.tar.gz", sha256: sha256(archive), bytes: archive.byteLength },
        checksum: { name: "workflow-package-demo-2.0.0-rc.2.tar.gz.sha256" },
      }) };
      if (url === checksumUrl) return { status: 200, body: bytes(`${sha256(archive).slice(7)}  workflow-package-demo-2.0.0-rc.2.tar.gz\n`) };
      if (url === archiveUrl) return { status: 200, body: archive };
      return { status: 404, body: bytes("missing") };
    } });
    const source = new GitHubWorkflowPackageSource({
      kind: "github", repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, network);
    await expect(source.fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toEqual({ kind: "INVALID" });
    await expect(source.fetch({ name: "demo", version: { kind: "EXACT", value: "2.0.0-rc.2" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { exactVersion: "2.0.0-rc.2" },
    });
  });

  it("paginates deterministically and rejects duplicate package versions", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({
      ...scopedRelease("other", `1.0.${index}`, "https://example.test/d.json", "https://example.test/a.tar.gz", "https://example.test/a.sha256"),
      draft: true,
    }));
    const duplicate = scopedRelease("demo", "1.0.0", "https://example.test/d.json", "https://example.test/a.tar.gz", "https://example.test/a.sha256");
    const calls: string[] = [];
    const source = new GitHubWorkflowPackageSource({
      kind: "github", repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, Object.freeze({ request: async (url: string) => {
      calls.push(url);
      return { status: 200, body: bytes(url.endsWith("page=1") ? filler : [duplicate, duplicate]) };
    } }));
    await expect(source.fetch({ name: "demo", version: { kind: "EXACT", value: "1.0.0" } })).resolves.toEqual({ kind: "INVALID" });
    expect(calls.slice(0, 2)).toEqual([
      "https://api.github.com/repos/example/workflows/releases?per_page=100&page=1",
      "https://api.github.com/repos/example/workflows/releases?per_page=100&page=2",
    ]);
  });

  it("normalizes the immutable initial cohort descriptor without rebuilding its assets", async () => {
    const implementation = bytes("original-implementation");
    const systemDesign = bytes("original-system-design");
    const descriptorUrl = "https://example.test/workflow-package-release-0.3.0.json";
    const implementationUrl = "https://example.test/workflow-package-implementation-workflow-0.3.0.tar.gz";
    const descriptor = {
      schemaVersion: "workflow-package.release@1.0.0", revision: "e".repeat(40), tag: "0.3.0",
      assets: [
        { name: "workflow-package-implementation-workflow-0.3.0.tar.gz", sha256: sha256(implementation), bytes: implementation.byteLength, package: "implementation-workflow", version: "0.3.0", packageDigest: `sha256:${"1".repeat(64)}` },
        { name: "workflow-package-system-design-workflow-0.3.0.tar.gz", sha256: sha256(systemDesign), bytes: systemDesign.byteLength, package: "system-design-workflow", version: "0.3.0", packageDigest: `sha256:${"2".repeat(64)}` },
      ],
    };
    const release = {
      tag_name: "0.3.0", draft: false, prerelease: false,
      assets: [
        { name: "workflow-package-release-0.3.0.json", browser_download_url: descriptorUrl },
        { name: "workflow-package-implementation-workflow-0.3.0.tar.gz", browser_download_url: implementationUrl },
        { name: "workflow-package-system-design-workflow-0.3.0.tar.gz", browser_download_url: "https://example.test/system-design.tar.gz" },
      ],
    };
    const source = new GitHubWorkflowPackageSource({
      kind: "github", repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    }, Object.freeze({ request: async (url: string) => {
      if (url.includes("?per_page=")) return { status: 200, body: bytes([release]) };
      if (url === descriptorUrl) return { status: 200, body: bytes(descriptor) };
      if (url === implementationUrl) return { status: 200, body: implementation };
      return { status: 404, body: bytes("missing") };
    } }));
    await expect(source.fetch({ name: "implementation-workflow", version: { kind: "EXACT", value: "0.3.0" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { exactVersion: "0.3.0", archiveDigest: sha256(implementation) },
    });
  });

  it("fails closed on malformed metadata, transport failure, or checksum mismatch", async () => {
    const configuration = {
      kind: "github", repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    } as const;
    const request = { name: "demo", version: { kind: "EXACT", value: "1.0.0" } } as const;
    const source = (response: () => Promise<{ status: number; body: Uint8Array }>) =>
      new GitHubWorkflowPackageSource(configuration, Object.freeze({ request: response }));
    await expect(source(async () => { throw new Error("offline"); }).fetch(request)).resolves.toEqual({ kind: "UNAVAILABLE" });
    await expect(source(async () => ({ status: 200, body: bytes("{bad") })).fetch(request)).resolves.toEqual({ kind: "INVALID" });
  });

  it("fails closed at every scoped descriptor, checksum, and archive trust boundary", async () => {
    const archive = bytes("trusted");
    const archiveUrl = "https://example.test/demo.tar.gz";
    const descriptorUrl = "https://example.test/demo.json";
    const checksumUrl = "https://example.test/demo.sha256";
    const configuration = {
      kind: "github", repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    } as const;
    const request = { name: "demo", version: { kind: "EXACT", value: "1.0.0" } } as const;
    const releaseBody = bytes([scopedRelease("demo", "1.0.0", descriptorUrl, archiveUrl, checksumUrl)]);
    const descriptorBody = bytes({
      schemaVersion: "workflow-package.package-release@1.0.0", revision: "a".repeat(40),
      tag: "workflow-package/demo/v1.0.0",
      package: { name: "demo", version: "1.0.0", digest: `sha256:${"b".repeat(64)}` },
      archive: { name: "workflow-package-demo-1.0.0.tar.gz", sha256: sha256(archive), bytes: archive.byteLength },
      checksum: { name: "workflow-package-demo-1.0.0.tar.gz.sha256" },
    });
    const run = async (responses: Readonly<Record<string, { status: number; body: Uint8Array }>>) => {
      const source = new GitHubWorkflowPackageSource(configuration, Object.freeze({ request: async (url: string) =>
        url.includes("?per_page=") ? { status: 200, body: releaseBody } : responses[url] ?? { status: 404, body: bytes("missing") },
      }));
      return source.fetch(request);
    };
    await expect(run({ [descriptorUrl]: { status: 200, body: bytes({ bad: true }) } })).resolves.toEqual({ kind: "INVALID" });
    await expect(run({ [descriptorUrl]: { status: 503, body: bytes("outage") } })).resolves.toEqual({ kind: "UNAVAILABLE" });
    await expect(run({
      [descriptorUrl]: { status: 200, body: descriptorBody },
      [checksumUrl]: { status: 200, body: bytes("wrong checksum\n") },
    })).resolves.toEqual({ kind: "DIGEST_MISMATCH" });
    await expect(run({
      [descriptorUrl]: { status: 200, body: descriptorBody },
      [checksumUrl]: { status: 503, body: bytes("outage") },
    })).resolves.toEqual({ kind: "UNAVAILABLE" });
    await expect(run({
      [descriptorUrl]: { status: 200, body: descriptorBody },
      [checksumUrl]: { status: 200, body: bytes(`${sha256(archive).slice(7)}  workflow-package-demo-1.0.0.tar.gz\n`) },
      [archiveUrl]: { status: 200, body: bytes("tampered") },
    })).resolves.toEqual({ kind: "DIGEST_MISMATCH" });
  });

  it("rejects malformed release assets and a release collection beyond its bounded pagination", async () => {
    const configuration = {
      kind: "github", repository: "example/workflows",
      releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    } as const;
    const request = { name: "demo", version: { kind: "EXACT", value: "1.0.0" } } as const;
    const malformed = new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async () => ({ status: 200, body: bytes([{ tag_name: "workflow-package/demo/v1.0.0", draft: false, prerelease: false, assets: [{ name: "x", browser_download_url: "http://unsafe.test/x" }] }]) }),
    }));
    await expect(malformed.fetch(request)).resolves.toEqual({ kind: "INVALID" });
    const nonArray = new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async () => ({ status: 200, body: bytes({}) }),
    }));
    await expect(nonArray.fetch(request)).resolves.toEqual({ kind: "INVALID" });
    const incomplete = new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async () => ({ status: 200, body: bytes([{
        ...scopedRelease("demo", "1.0.0", "https://example.test/d", "https://example.test/a", "https://example.test/c"),
        assets: [],
      }]) }),
    }));
    await expect(incomplete.fetch(request)).resolves.toEqual({ kind: "INVALID" });
    const legacyDescriptorUrl = "https://example.test/legacy.json";
    const invalidLegacy = new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async (url: string) => url.includes("?per_page=")
        ? { status: 200, body: bytes([{ tag_name: "1.0.0", draft: false, prerelease: false, assets: [
          { name: "workflow-package-release-1.0.0.json", browser_download_url: legacyDescriptorUrl },
        ] }]) }
        : { status: 200, body: bytes({ schemaVersion: "workflow-package.release@1.0.0", revision: "a".repeat(40), tag: "1.0.0", assets: [null] }) },
    }));
    await expect(invalidLegacy.fetch(request)).resolves.toEqual({ kind: "INVALID" });
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      ...scopedRelease("other", `1.0.${index}`, "https://example.test/d", "https://example.test/a", "https://example.test/c"),
      draft: true,
    }));
    let pages = 0;
    const unbounded = new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async () => { pages += 1; return { status: 200, body: bytes(fullPage) }; },
    }));
    await expect(unbounded.fetch(request)).resolves.toEqual({ kind: "UNAVAILABLE" });
    expect(pages).toBe(10);
  });
});
