import { createHash } from "node:crypto";

import type { NetworkPort, WorkflowPackageCandidate, WorkflowPackageSource, WorkflowPackageSourceRequest, WorkflowPackageSourceResult } from "../bootstrap/index.js";
import { SourceFactorySelectionError } from "../bootstrap/index.js";
import type { WorkflowSourceConfiguration } from "../configuration/index.js";
import { isExactWorkflowVersion } from "./selector.js";

export type { WorkflowPackageSource } from "../bootstrap/index.js";

const MAX_ARCHIVE_BYTES = 134_217_728;
const PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 10;
type Asset = Readonly<{ name: string; url: string }>;
type Release = Readonly<{ tag: string; draft: boolean; prerelease: boolean; assets: readonly unknown[] }>;
type PackageRecord = Readonly<{
  name: string; version: string; archive: Asset; descriptor: Asset; checksum: Asset; provenance: Asset;
}>;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function json(body: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch { return undefined; }
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join("\0") === [...keys].sort().join("\0");
}

function asset(value: unknown): Asset | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.browser_download_url !== "string") return undefined;
  try {
    const url = new URL(record.browser_download_url);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? Object.freeze({ name: record.name, url: url.href })
      : undefined;
  } catch { return undefined; }
}

function release(value: unknown): Release | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || typeof record.draft !== "boolean"
    || typeof record.prerelease !== "boolean" || !Array.isArray(record.assets)) return undefined;
  return Object.freeze({ tag: record.tag_name, draft: record.draft, prerelease: record.prerelease, assets: Object.freeze([...record.assets]) });
}

type Semver = Readonly<{ major: bigint; minor: bigint; patch: bigint; prerelease: boolean }>;
function semver(value: string): Semver | undefined {
  if (!isExactWorkflowVersion(value)) return undefined;
  const separator = value.indexOf("-");
  const core = separator === -1 ? value : value.slice(0, separator);
  const [major, minor, patch] = core.split(".").map(BigInt);
  return Object.freeze({ major: major!, minor: minor!, patch: patch!, prerelease: separator !== -1 });
}

function oneAsset(assets: readonly Asset[], name: string): Asset | undefined {
  const matches = assets.filter((entry) => entry.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function scopedCoordinates(tag: string): Readonly<{ name: string; version: string }> | undefined {
  if (!tag.startsWith("workflow-package/")) return undefined;
  const marker = tag.lastIndexOf("/v");
  if (marker <= "workflow-package/".length) return undefined;
  const name = tag.slice("workflow-package/".length, marker);
  const version = tag.slice(marker + 2);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && isExactWorkflowVersion(version)
    ? Object.freeze({ name, version })
    : undefined;
}

function scopedRecord(item: Release, coordinates: Readonly<{ name: string; version: string }>): PackageRecord | undefined {
  const parsedAssets = item.assets.map(asset);
  if (parsedAssets.some((entry) => entry === undefined)) return undefined;
  const assets = parsedAssets as Asset[];
  const archiveName = `workflow-package-${coordinates.name}-${coordinates.version}.tar.gz`;
  const descriptorName = `workflow-package-${coordinates.name}-${coordinates.version}.json`;
  if (assets.length !== 4) return undefined;
  const archive = oneAsset(assets, archiveName);
  const descriptor = oneAsset(assets, descriptorName);
  const checksum = oneAsset(assets, `${archiveName}.sha256`);
  const provenance = oneAsset(assets, `workflow-package-${coordinates.name}-${coordinates.version}.provenance.json`);
  const version = semver(coordinates.version);
  return archive !== undefined && descriptor !== undefined && checksum !== undefined && provenance !== undefined
    && version?.prerelease === item.prerelease
    ? Object.freeze({ ...coordinates, archive, descriptor, checksum, provenance })
    : undefined;
}

type ScopedMetadata = Readonly<{
  digest: string; bytes: number;
  provenance?: Readonly<{ name: string; digest: string; contractRevision: string }>;
}>;

function scopedDescriptor(record: PackageRecord, body: Uint8Array): ScopedMetadata | undefined {
  const descriptor = json(body);
  if (descriptor === undefined
    || descriptor.tag !== `workflow-package/${record.name}/v${record.version}`
    || descriptor.schemaVersion !== "workflow-package.package-release@2.0.0"
    || !exactKeys(descriptor, ["schemaVersion", "tag", "package", "archive", "checksum", "provenance", "contract"])) return undefined;
  const packageValue = descriptor.package as Record<string, unknown> | null;
  const archiveValue = descriptor.archive as Record<string, unknown> | null;
  const checksumValue = descriptor.checksum as Record<string, unknown> | null;
  if (packageValue === null || archiveValue === null || checksumValue === null
    || typeof packageValue !== "object" || Array.isArray(packageValue)
    || typeof archiveValue !== "object" || Array.isArray(archiveValue)
    || typeof checksumValue !== "object" || Array.isArray(checksumValue)) return undefined;
  if (!exactKeys(packageValue, ["name", "version", "digest"])
    || packageValue.name !== record.name || packageValue.version !== record.version
    || typeof packageValue.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(packageValue.digest)
    || !exactKeys(archiveValue, ["name", "sha256", "bytes"]) || archiveValue.name !== record.archive.name
    || typeof archiveValue.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(archiveValue.sha256)
    || typeof archiveValue.bytes !== "number" || !Number.isSafeInteger(archiveValue.bytes)
    || archiveValue.bytes <= 0 || archiveValue.bytes > MAX_ARCHIVE_BYTES
    || !exactKeys(checksumValue, ["name"]) || checksumValue.name !== record.checksum?.name) return undefined;
  const provenanceValue = descriptor.provenance as Record<string, unknown> | null;
  const contractValue = descriptor.contract as Record<string, unknown> | null;
  if (provenanceValue === null || contractValue === null
    || typeof provenanceValue !== "object" || Array.isArray(provenanceValue)
    || typeof contractValue !== "object" || Array.isArray(contractValue)
    || !exactKeys(provenanceValue, ["name", "sha256"])
    || provenanceValue.name !== record.provenance?.name
    || typeof provenanceValue.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(provenanceValue.sha256)
    || !exactKeys(contractValue, ["repository", "revision", "minVersion", "maxVersion"])
    || contractValue.repository !== "firestige/wsr-contracts"
    || typeof contractValue.revision !== "string" || !/^[a-f0-9]{40}$/u.test(contractValue.revision)
    || typeof contractValue.minVersion !== "string" || semver(contractValue.minVersion) === undefined
    || typeof contractValue.maxVersion !== "string" || semver(contractValue.maxVersion) === undefined) return undefined;
  return Object.freeze({
    digest: archiveValue.sha256,
    bytes: archiveValue.bytes,
    provenance: Object.freeze({
      name: provenanceValue.name as string,
      digest: provenanceValue.sha256 as string,
      contractRevision: contractValue.revision as string,
    }),
  });
}

function validProvenance(record: PackageRecord, metadata: ScopedMetadata, body: Uint8Array, repository: string): boolean {
  if (record.provenance === undefined || metadata.provenance === undefined) return false;
  if (digest(body) !== metadata.provenance.digest) return false;
  const value = json(body);
  if (value === undefined || !exactKeys(value, ["schemaVersion", "subject", "source", "contract", "builder"])
    || value.schemaVersion !== "workflow-package.provenance@1.0.0") return false;
  const subject = value.subject as Record<string, unknown> | null;
  const source = value.source as Record<string, unknown> | null;
  const contract = value.contract as Record<string, unknown> | null;
  const builder = value.builder as Record<string, unknown> | null;
  return subject !== null && source !== null && contract !== null && builder !== null
    && typeof subject === "object" && !Array.isArray(subject) && exactKeys(subject, ["name", "sha256"])
    && subject.name === record.archive.name && subject.sha256 === metadata.digest
    && typeof source === "object" && !Array.isArray(source) && exactKeys(source, ["repository", "revision"])
    && source.repository === repository
    && typeof source.revision === "string" && /^[a-f0-9]{40}$/u.test(source.revision)
    && typeof contract === "object" && !Array.isArray(contract) && exactKeys(contract, ["repository", "revision"])
    && contract.repository === "firestige/wsr-contracts" && contract.revision === metadata.provenance.contractRevision
    && typeof builder === "object" && !Array.isArray(builder) && exactKeys(builder, ["workflow"])
    && builder.workflow === ".github/workflows/release-candidate.yml";
}

export class GitHubWorkflowPackageSource implements WorkflowPackageSource {
  constructor(
    readonly configuration: Extract<WorkflowSourceConfiguration, { kind: "github" }>,
    readonly network: NetworkPort,
  ) {}

  async #request(url: string): Promise<Readonly<{ status: number; body: Uint8Array }> | undefined> {
    try { return await this.network.request(url); } catch { return undefined; }
  }

  async fetch(request: WorkflowPackageSourceRequest): Promise<WorkflowPackageSourceResult> {
    const releases: Release[] = [];
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const response = await this.#request(`${this.configuration.releasesBaseUrl}?per_page=${PAGE_SIZE}&page=${page}`);
      if (response?.status === 404) return Object.freeze({ kind: "NOT_FOUND" });
      if (response === undefined || response.status < 200 || response.status >= 300) return Object.freeze({ kind: "UNAVAILABLE" });
      let values: unknown;
      try { values = JSON.parse(Buffer.from(response.body).toString("utf8")); } catch { return Object.freeze({ kind: "INVALID" }); }
      if (!Array.isArray(values)) return Object.freeze({ kind: "INVALID" });
      const parsed = values.map(release);
      if (parsed.some((entry) => entry === undefined)) return Object.freeze({ kind: "INVALID" });
      if (request.version.kind === "LATEST"
        && (parsed as Release[]).some((entry) => entry.assets.some((value) => asset(value) === undefined))) {
        return Object.freeze({ kind: "INVALID" });
      }
      releases.push(...(parsed as Release[]).filter((entry) => !entry.draft));
      if (values.length < PAGE_SIZE) break;
      if (page === MAX_RELEASE_PAGES) return Object.freeze({ kind: "UNAVAILABLE" });
    }

    const records: PackageRecord[] = [];
    for (const releaseItem of releases) {
      const coordinates = scopedCoordinates(releaseItem.tag);
      if (coordinates !== undefined) {
        if (coordinates.name !== request.name) continue;
        if (request.version.kind === "EXACT" && coordinates.version !== request.version.value) continue;
        if (request.version.kind === "LATEST" && releaseItem.prerelease) continue;
        const record = scopedRecord(releaseItem, coordinates);
        if (record === undefined) return Object.freeze({ kind: "INVALID" });
        records.push(record);
        continue;
      }
    }

    const versions = new Map<string, PackageRecord>();
    for (const record of records) {
      if (versions.has(record.version)) return Object.freeze({ kind: "INVALID" });
      versions.set(record.version, record);
    }
    const selected = request.version.kind === "EXACT"
      ? versions.get(request.version.value)
      : [...versions.values()]
        .filter((record) => semver(record.version)?.prerelease === false)
        .sort((left, right) => {
          const a = semver(left.version)!;
          const b = semver(right.version)!;
          return a.major < b.major ? 1 : a.major > b.major ? -1
            : a.minor < b.minor ? 1 : a.minor > b.minor ? -1
              : a.patch < b.patch ? 1 : a.patch > b.patch ? -1 : 0;
        })[0];
    if (selected === undefined) return Object.freeze({ kind: "NOT_FOUND" });

    const descriptorResponse = await this.#request(selected.descriptor.url);
    if (descriptorResponse === undefined || descriptorResponse.status < 200 || descriptorResponse.status >= 300) return Object.freeze({ kind: "UNAVAILABLE" });
    const metadata = scopedDescriptor(selected, descriptorResponse.body);
    if (metadata === undefined) return Object.freeze({ kind: "INVALID" });
    const provenanceResponse = await this.#request(selected.provenance.url);
    if (provenanceResponse === undefined || provenanceResponse.status < 200 || provenanceResponse.status >= 300) return Object.freeze({ kind: "UNAVAILABLE" });
    if (digest(provenanceResponse.body) !== metadata.provenance?.digest) return Object.freeze({ kind: "DIGEST_MISMATCH" });
    if (!validProvenance(selected, metadata, provenanceResponse.body, this.configuration.repository)) return Object.freeze({ kind: "INVALID" });
    const checksumResponse = await this.#request(selected.checksum.url);
    if (checksumResponse === undefined || checksumResponse.status < 200 || checksumResponse.status >= 300) return Object.freeze({ kind: "UNAVAILABLE" });
    if (Buffer.from(checksumResponse.body).toString("utf8") !== `${metadata.digest.slice(7)}  ${selected.archive.name}\n`) return Object.freeze({ kind: "DIGEST_MISMATCH" });
    const archiveResponse = await this.#request(selected.archive.url);
    if (archiveResponse === undefined || archiveResponse.status < 200 || archiveResponse.status >= 300) return Object.freeze({ kind: "UNAVAILABLE" });
    if (archiveResponse.body.byteLength === 0 || archiveResponse.body.byteLength > MAX_ARCHIVE_BYTES
      || archiveResponse.body.byteLength !== metadata.bytes || digest(archiveResponse.body) !== metadata.digest) return Object.freeze({ kind: "DIGEST_MISMATCH" });
    const archive = Uint8Array.from(archiveResponse.body);
    const candidate: WorkflowPackageCandidate = Object.freeze({
      name: request.name, exactVersion: selected.version, archiveDigest: digest(archive), archive,
    });
    return Object.freeze({ kind: "FOUND", candidate });
  }
}

export type AlternateWorkflowPackageSourceFactory = (configurationFile: string) => WorkflowPackageSource;
export class WorkflowPackageSourceRegistry {
  readonly #factories: Readonly<Record<string, AlternateWorkflowPackageSourceFactory>>;
  constructor(factories: Readonly<Record<string, AlternateWorkflowPackageSourceFactory>>) { this.#factories = factories; }
  create(key: string, configurationFile: string): WorkflowPackageSource {
    const factory = this.#factories[key];
    if (factory === undefined) throw new SourceFactorySelectionError(key);
    return factory(configurationFile);
  }
}

export function createConfiguredWorkflowPackageSource(
  configuration: WorkflowSourceConfiguration,
  network: NetworkPort,
  alternates: WorkflowPackageSourceRegistry,
): WorkflowPackageSource {
  return configuration.kind === "github"
    ? new GitHubWorkflowPackageSource(configuration, network)
    : alternates.create(configuration.adapterKey, configuration.adapterConfigFile);
}
