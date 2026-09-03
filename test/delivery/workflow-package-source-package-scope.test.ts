import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { NetworkPort } from "../../src/bootstrap/index.js";
import { GitHubWorkflowPackageSource } from "../../src/delivery/index.js";

const bytes = (value: unknown): Uint8Array => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const sha256 = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const configuration = {
  kind: "github", repository: "example/workflows",
  releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
  assetPattern: "workflow-package-{name}-{version}.tar.gz",
} as const;

type PackageSpec = Readonly<{ name: string; version: string; prerelease?: boolean; draft?: boolean }>;

function packageRelease(spec: PackageSpec) {
  const prefix = `workflow-package-${spec.name}-${spec.version}`;
  const archive = bytes(`${spec.name}@${spec.version}`);
  const urls = {
    archive: `https://example.test/${prefix}.tar.gz`,
    descriptor: `https://example.test/${prefix}.json`,
    checksum: `https://example.test/${prefix}.tar.gz.sha256`,
    provenance: `https://example.test/${prefix}.provenance.json`,
  };
  const provenance = bytes({
    schemaVersion: "workflow-package.provenance@1.0.0",
    subject: { name: `${prefix}.tar.gz`, sha256: sha256(archive) },
    source: { repository: "example/workflows", revision: "a".repeat(40) },
    contract: { repository: "firestige/wsr-contracts", revision: "b".repeat(40) },
    builder: { workflow: ".github/workflows/release-candidate.yml" },
  });
  const descriptor = bytes({
    schemaVersion: "workflow-package.package-release@2.0.0",
    tag: `workflow-package/${spec.name}/v${spec.version}`,
    package: { name: spec.name, version: spec.version, digest: `sha256:${"c".repeat(64)}` },
    archive: { name: `${prefix}.tar.gz`, sha256: sha256(archive), bytes: archive.byteLength },
    checksum: { name: `${prefix}.tar.gz.sha256` },
    provenance: { name: `${prefix}.provenance.json`, sha256: sha256(provenance) },
    contract: {
      repository: "firestige/wsr-contracts", revision: "b".repeat(40),
      minVersion: "1.1.0", maxVersion: "1.1.0",
    },
  });
  return {
    release: {
      tag_name: `workflow-package/${spec.name}/v${spec.version}`,
      draft: spec.draft ?? false,
      prerelease: spec.prerelease ?? false,
      assets: [
        { name: `${prefix}.tar.gz`, browser_download_url: urls.archive },
        { name: `${prefix}.json`, browser_download_url: urls.descriptor },
        { name: `${prefix}.tar.gz.sha256`, browser_download_url: urls.checksum },
        { name: `${prefix}.provenance.json`, browser_download_url: urls.provenance },
      ],
    },
    responses: new Map<string, Readonly<{ status: number; body: Uint8Array }>>([
      [urls.archive, { status: 200, body: archive }],
      [urls.descriptor, { status: 200, body: descriptor }],
      [urls.checksum, { status: 200, body: bytes(`${sha256(archive).slice(7)}  ${prefix}.tar.gz\n`) }],
      [urls.provenance, { status: 200, body: provenance }],
    ]),
  };
}

function source(specs: readonly PackageSpec[], calls: string[] = []) {
  const fixtures = specs.map(packageRelease);
  const responses = new Map(fixtures.flatMap((fixture) => [...fixture.responses]));
  const network: NetworkPort = Object.freeze({ request: async (url: string) => {
    calls.push(url);
    if (url.includes("?per_page=")) return { status: 200, body: bytes(fixtures.map((fixture) => fixture.release)) };
    return responses.get(url) ?? { status: 404, body: bytes("missing") };
  } });
  return new GitHubWorkflowPackageSource(configuration, network);
}

describe("package-scoped GitHub Workflow Source", () => {
  it("selects an exact package through the package-scoped V2 release", async () => {
    const calls: string[] = [];
    await expect(source([
      { name: "unrelated", version: "9.0.0" },
      { name: "demo", version: "1.0.0" },
      { name: "demo", version: "2.0.0" },
    ], calls).fetch({ name: "demo", version: { kind: "EXACT", value: "2.0.0" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { name: "demo", exactVersion: "2.0.0" },
    });
    expect(calls[0]).toBe("https://api.github.com/repos/example/workflows/releases?per_page=100&page=1");
    expect(calls).not.toContain("https://api.github.com/repos/example/workflows/releases/latest");
  });

  it("admits an exact prerelease but excludes all prereleases from latest", async () => {
    const candidate = source([{ name: "demo", version: "2.0.0-rc.2", prerelease: true }]);
    await expect(candidate.fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toEqual({ kind: "NOT_FOUND" });
    await expect(candidate.fetch({ name: "demo", version: { kind: "EXACT", value: "2.0.0-rc.2" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { exactVersion: "2.0.0-rc.2" },
    });
  });

  it("selects the highest stable SemVer and ignores drafts", async () => {
    const candidate = source([
      { name: "demo", version: "11.0.0", draft: true },
      { name: "demo", version: "2.9.0" },
      { name: "demo", version: "11.0.0-rc.1", prerelease: true },
      { name: "demo", version: "10.1.0" },
    ]);
    await expect(candidate.fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { exactVersion: "10.1.0" },
    });
  });

  it("paginates deterministically and rejects duplicate package versions", async () => {
    const fixture = packageRelease({ name: "demo", version: "1.0.0" });
    const filler = Array.from({ length: 100 }, (_, index) => ({
      ...packageRelease({ name: "other", version: `1.0.${index}` }).release,
      draft: true,
    }));
    const calls: string[] = [];
    const candidate = new GitHubWorkflowPackageSource(configuration, Object.freeze({ request: async (url: string) => {
      calls.push(url);
      return { status: 200, body: bytes(url.endsWith("page=1") ? filler : [fixture.release, fixture.release]) };
    } }));
    await expect(candidate.fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toEqual({ kind: "INVALID" });
    expect(calls.slice(0, 2)).toEqual([
      "https://api.github.com/repos/example/workflows/releases?per_page=100&page=1",
      "https://api.github.com/repos/example/workflows/releases?per_page=100&page=2",
    ]);
  });

  it("fails closed on malformed collections and bounds release enumeration", async () => {
    const request = { name: "demo", version: { kind: "EXACT", value: "1.0.0" } } as const;
    const withNetwork = (network: NetworkPort) => new GitHubWorkflowPackageSource(configuration, network);
    await expect(withNetwork(Object.freeze({ request: async () => ({ status: 200, body: bytes({}) }) })).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
    await expect(withNetwork(Object.freeze({ request: async () => ({
      status: 200,
      body: bytes([{ ...packageRelease({ name: "demo", version: "1.0.0" }).release, assets: [] }]),
    }) })).fetch(request)).resolves.toEqual({ kind: "INVALID" });
    let pages = 0;
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      ...packageRelease({ name: "other", version: `1.0.${index}` }).release,
      draft: true,
    }));
    await expect(withNetwork(Object.freeze({ request: async () => {
      pages += 1;
      return { status: 200, body: bytes(fullPage) };
    } })).fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toEqual({ kind: "UNAVAILABLE" });
    expect(pages).toBe(10);
  });
});
