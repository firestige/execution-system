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
