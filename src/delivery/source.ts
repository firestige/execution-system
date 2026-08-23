import { createHash } from "node:crypto";

import type {
  NetworkPort,
  WorkflowPackageCandidate,
  WorkflowPackageSource,
  WorkflowPackageSourceRequest,
  WorkflowPackageSourceResult,
} from "../bootstrap/index.js";
import { SourceFactorySelectionError } from "../bootstrap/index.js";
import type { WorkflowSourceConfiguration } from "../configuration/index.js";
import { isExactWorkflowVersion } from "./selector.js";

export type { WorkflowPackageSource } from "../bootstrap/index.js";

const MAX_ARCHIVE_BYTES = 134_217_728;

function archiveDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function releaseMetadata(body: Uint8Array): Readonly<{ exactVersion: string; assets: readonly unknown[] }> | undefined {
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const tag = typeof record.tag_name === "string" ? record.tag_name : undefined;
    if (tag === undefined || !isExactWorkflowVersion(tag) || !Array.isArray(record.assets)) return undefined;
    return Object.freeze({ exactVersion: tag, assets: record.assets });
  } catch { return undefined; }
}

function assetMetadata(value: unknown): Readonly<{ name: string; url: string }> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.browser_download_url !== "string") return undefined;
  try {
    const url = new URL(record.browser_download_url);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    return Object.freeze({ name: record.name, url: url.href });
  } catch { return undefined; }
}

export class GitHubWorkflowPackageSource implements WorkflowPackageSource {
  constructor(
    readonly configuration: Extract<WorkflowSourceConfiguration, { kind: "github" }>,
    readonly network: NetworkPort,
  ) {}

  async fetch(request: WorkflowPackageSourceRequest): Promise<WorkflowPackageSourceResult> {
    const releaseUrl = request.version.kind === "LATEST"
      ? `${this.configuration.releasesBaseUrl}/latest`
      : `${this.configuration.releasesBaseUrl}/tags/${encodeURIComponent(request.version.value)}`;
    let releaseResponse: Awaited<ReturnType<NetworkPort["request"]>>;
    try { releaseResponse = await this.network.request(releaseUrl); }
    catch { return Object.freeze({ kind: "UNAVAILABLE" }); }
    if (releaseResponse.status === 404) return Object.freeze({ kind: "NOT_FOUND" });
    if (releaseResponse.status < 200 || releaseResponse.status >= 300) return Object.freeze({ kind: "UNAVAILABLE" });
    const release = releaseMetadata(releaseResponse.body);
    if (release === undefined || (request.version.kind === "EXACT" && release.exactVersion !== request.version.value)) {
      return Object.freeze({ kind: "INVALID" });
    }
    const expectedName = this.configuration.assetPattern
      .replace("{name}", request.name)
      .replace("{version}", release.exactVersion);
    const assets = release.assets.map(assetMetadata).filter((asset): asset is NonNullable<typeof asset> => asset !== undefined && asset.name === expectedName);
    if (assets.length !== 1) return Object.freeze({ kind: "INVALID" });
    let archiveResponse: Awaited<ReturnType<NetworkPort["request"]>>;
    try { archiveResponse = await this.network.request(assets[0]!.url); }
    catch { return Object.freeze({ kind: "UNAVAILABLE" }); }
    if (archiveResponse.status < 200 || archiveResponse.status >= 300) return Object.freeze({ kind: "UNAVAILABLE" });
    if (archiveResponse.body.byteLength === 0 || archiveResponse.body.byteLength > MAX_ARCHIVE_BYTES) return Object.freeze({ kind: "INVALID" });
    const archive = Uint8Array.from(archiveResponse.body);
    const candidate: WorkflowPackageCandidate = Object.freeze({
      name: request.name,
      exactVersion: release.exactVersion,
      archiveDigest: archiveDigest(archive),
      archive,
    });
    return Object.freeze({ kind: "FOUND", candidate });
  }
}

export type AlternateWorkflowPackageSourceFactory = (configurationFile: string) => WorkflowPackageSource;

export class WorkflowPackageSourceRegistry {
  readonly #factories: Readonly<Record<string, AlternateWorkflowPackageSourceFactory>>;
  constructor(factories: Readonly<Record<string, AlternateWorkflowPackageSourceFactory>>) {
    this.#factories = factories;
  }
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
