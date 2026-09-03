import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { NetworkPort } from "../../src/bootstrap/index.js";
import { GitHubWorkflowPackageSource } from "../../src/delivery/index.js";

const body = (value: unknown): Uint8Array => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const digest = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function fixture(overrides: Readonly<{
  checksum?: string;
  provenanceDigest?: string;
  provenanceRepository?: string;
  provenanceSchemaVersion?: string;
  provenanceStatus?: number;
  contractMaxVersion?: string;
  archiveUrl?: string;
  descriptorChecksumName?: string;
  descriptorChecksumObject?: boolean;
  includeProvenanceAsset?: boolean;
}> = {}) {
  const archive = body("exact archive");
  const archiveName = "workflow-package-demo-1.2.3.tar.gz";
  const descriptorName = "workflow-package-demo-1.2.3.json";
  const checksumName = `${archiveName}.sha256`;
  const provenanceName = "workflow-package-demo-1.2.3.provenance.json";
  const urls = Object.freeze({
    descriptor: "https://github.example/assets/descriptor",
    archive: overrides.archiveUrl ?? "https://github.example/assets/archive",
    checksum: "https://github.example/assets/checksum",
    provenance: "https://github.example/assets/provenance",
  });
  const provenance = body({
    schemaVersion: overrides.provenanceSchemaVersion ?? "workflow-package.provenance@1.0.0",
    subject: { name: archiveName, sha256: digest(archive) },
    source: { repository: overrides.provenanceRepository ?? "firestige/wsr-workflow-package", revision: "a".repeat(40) },
    contract: { repository: "firestige/wsr-contracts", revision: "b".repeat(40) },
    builder: { workflow: ".github/workflows/release-candidate.yml" },
  });
  const descriptor = body({
    schemaVersion: "workflow-package.package-release@2.0.0",
    tag: "workflow-package/demo/v1.2.3",
    package: { name: "demo", version: "1.2.3", digest: `sha256:${"c".repeat(64)}` },
    archive: { name: archiveName, sha256: digest(archive), bytes: archive.byteLength },
    checksum: overrides.descriptorChecksumObject === false ? null : { name: overrides.descriptorChecksumName ?? checksumName },
    provenance: { name: provenanceName, sha256: overrides.provenanceDigest ?? digest(provenance) },
    contract: {
      repository: "firestige/wsr-contracts", revision: "b".repeat(40),
      minVersion: "1.1.0", maxVersion: overrides.contractMaxVersion ?? "1.1.0",
    },
  });
  const releases = body([{
    tag_name: "workflow-package/demo/v1.2.3", draft: false, prerelease: false,
    assets: [
      { name: archiveName, browser_download_url: urls.archive },
      { name: descriptorName, browser_download_url: urls.descriptor },
      { name: checksumName, browser_download_url: urls.checksum },
      ...(overrides.includeProvenanceAsset === false ? [] : [{ name: provenanceName, browser_download_url: urls.provenance }]),
    ],
  }]);
  const network: NetworkPort = Object.freeze({ request: async (url: string) => {
    if (url.includes("?per_page=")) return { status: 200, body: releases };
    if (url === urls.descriptor) return { status: 200, body: descriptor };
    if (url === urls.provenance) return { status: overrides.provenanceStatus ?? 200, body: provenance };
    if (url === urls.checksum) return { status: 200, body: body(overrides.checksum ?? `${digest(archive).slice(7)}  ${archiveName}\n`) };
    if (url === urls.archive) return { status: 200, body: archive };
    return { status: 404, body: body("missing") };
  } });
  return new GitHubWorkflowPackageSource({
    kind: "github", repository: "firestige/wsr-workflow-package",
    releasesBaseUrl: "https://api.github.com/repos/firestige/wsr-workflow-package/releases",
    assetPattern: "workflow-package-{name}-{version}.tar.gz",
  }, network);
}

describe("Iter6 official GitHub Workflow Package source", () => {
  it("admits exact and latest through the same four-asset provenance layout", async () => {
    await expect(fixture().fetch({ name: "demo", version: { kind: "EXACT", value: "1.2.3" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { name: "demo", exactVersion: "1.2.3" },
    });
    await expect(fixture().fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { name: "demo", exactVersion: "1.2.3" },
    });
  });

  it("distinguishes digest mismatch from structurally invalid provenance", async () => {
    await expect(fixture({ checksum: `0`.repeat(64) + "  workflow-package-demo-1.2.3.tar.gz\n" })
      .fetch({ name: "demo", version: { kind: "EXACT", value: "1.2.3" } })).resolves.toEqual({ kind: "DIGEST_MISMATCH" });
    await expect(fixture({ provenanceDigest: `sha256:${"0".repeat(64)}` })
      .fetch({ name: "demo", version: { kind: "EXACT", value: "1.2.3" } })).resolves.toEqual({ kind: "DIGEST_MISMATCH" });
  });

  it("fails closed on provenance authority drift, incompatible metadata, and provenance outage", async () => {
    const request = { name: "demo", version: { kind: "EXACT", value: "1.2.3" } } as const;
    await expect(fixture({ provenanceRepository: "other/workflow-package" }).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
    await expect(fixture({ contractMaxVersion: "latest" }).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
    await expect(fixture({ provenanceStatus: 503 }).fetch(request))
      .resolves.toEqual({ kind: "UNAVAILABLE" });
  });

  it("fails closed on a digest-valid unsupported provenance schema and malformed asset URL", async () => {
    const request = { name: "demo", version: { kind: "EXACT", value: "1.2.3" } } as const;
    await expect(fixture({ provenanceSchemaVersion: "workflow-package.provenance@2.0.0" }).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
    await expect(fixture({ archiveUrl: "not a URL" }).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
  });

  it("rejects v2 descriptors with absent provenance, non-object checksum, or checksum authority drift", async () => {
    const request = { name: "demo", version: { kind: "EXACT", value: "1.2.3" } } as const;
    await expect(fixture({ includeProvenanceAsset: false }).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
    await expect(fixture({ descriptorChecksumObject: false }).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
    await expect(fixture({ descriptorChecksumName: "other.sha256" }).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
  });

  it("does not admit unpublished v1 scoped or aggregate release layouts", async () => {
    const configuration = {
      kind: "github", repository: "firestige/wsr-workflow-package",
      releasesBaseUrl: "https://api.github.com/repos/firestige/wsr-workflow-package/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    } as const;
    const request = { name: "demo", version: { kind: "EXACT", value: "1.2.3" } } as const;
    const v1Scoped = new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async (url: string) => url.includes("?per_page=")
        ? { status: 200, body: body([{
          tag_name: "workflow-package/demo/v1.2.3", draft: false, prerelease: false,
          assets: [
            { name: "workflow-package-demo-1.2.3.tar.gz", browser_download_url: "https://example.test/archive" },
            { name: "workflow-package-demo-1.2.3.json", browser_download_url: "https://example.test/descriptor" },
            { name: "workflow-package-demo-1.2.3.tar.gz.sha256", browser_download_url: "https://example.test/checksum" },
          ],
        }]) }
        : { status: 200, body: body({
          schemaVersion: "workflow-package.package-release@1.0.0", revision: "a".repeat(40),
          tag: "workflow-package/demo/v1.2.3",
          package: { name: "demo", version: "1.2.3", digest: `sha256:${"b".repeat(64)}` },
          archive: { name: "workflow-package-demo-1.2.3.tar.gz", sha256: `sha256:${"c".repeat(64)}`, bytes: 7 },
          checksum: { name: "workflow-package-demo-1.2.3.tar.gz.sha256" },
        }) },
    }));
    const v1Aggregate = new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async (url: string) => url.includes("?per_page=")
        ? { status: 200, body: body([{
          tag_name: "1.2.3", draft: false, prerelease: false,
          assets: [{ name: "workflow-package-release-1.2.3.json", browser_download_url: "https://example.test/aggregate" }],
        }]) }
        : { status: 200, body: body({
          schemaVersion: "workflow-package.release@1.0.0", revision: "a".repeat(40), tag: "1.2.3", assets: [],
        }) },
    }));

    await expect(v1Scoped.fetch(request)).resolves.toEqual({ kind: "INVALID" });
    await expect(v1Aggregate.fetch(request)).resolves.toEqual({ kind: "NOT_FOUND" });
  });

  it("distinguishes an absent repository coordinate from GitHub unavailability", async () => {
    const configuration = {
      kind: "github", repository: "firestige/wsr-workflow-package",
      releasesBaseUrl: "https://api.github.com/repos/firestige/wsr-workflow-package/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    } as const;
    const request = { name: "demo", version: { kind: "EXACT", value: "1.2.3" } } as const;
    const source = (status: number) => new GitHubWorkflowPackageSource(configuration, Object.freeze({
      request: async () => ({ status, body: body("failure") }),
    }));
    await expect(source(404).fetch(request)).resolves.toEqual({ kind: "NOT_FOUND" });
    await expect(source(503).fetch(request)).resolves.toEqual({ kind: "UNAVAILABLE" });
  });
});
