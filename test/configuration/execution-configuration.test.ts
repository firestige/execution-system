import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  admitIntakeProfileConfiguration,
  canonicalConfigurationBytes,
  createDeliveryConfigProjection,
  createRunnerConfigurationProjection,
  loadExecutionInstallationConfig,
  loadExecutionInstallationConfigV2,
  initializeExecutionConfiguration,
  dumpEffectiveExecutionConfiguration,
  redactEffectiveConfiguration,
} from "../../src/configuration/index.js";
import { runExecutionConfigCli } from "../../src/configuration/cli.js";

const execFileAsync = promisify(execFile);

async function deployment() {
  const root = await mkdtemp(join(tmpdir(), "execution-config-"));
  const repositoryRoot = join(root, "repository");
  const workspaceRoot = join(root, "workspace");
  const worktreeRoot = join(workspaceRoot, "worktrees");
  const stateRoot = join(root, "state");
  const credentialStorePath = join(root, "credentials.json");
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(worktreeRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    writeFile(credentialStorePath, "secret material must not be read", { mode: 0o600 }),
  ]);
  return { root, repositoryRoot, workspaceRoot, worktreeRoot, stateRoot, credentialStorePath };
}

function input(paths: Awaited<ReturnType<typeof deployment>>) {
  return {
    schemaVersion: "execution.config@1.0.0",
    paths: {
      repositoryRoot: paths.repositoryRoot,
      workspaceRoot: paths.workspaceRoot,
      allowedWorktreeRoots: [paths.worktreeRoot],
      stateRoot: paths.stateRoot,
      credentialStorePath: paths.credentialStorePath,
    },
    workflowSource: {
      kind: "github",
      repository: "firestige/wsr-workflow-package",
      releasesBaseUrl: "https://api.github.com/repos/firestige/wsr-workflow-package/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    },
    runner: {
      implementationKey: "runner.v1",
      host: { engine: "langgraph" },
      provider: {
        key: "dsh",
        route: "openai-compatible",
        modelId: "fixture-model",
        baseUrl: "https://provider.example/v1",
        credentialRef: "provider.default",
        maxParallelToolCalls: 4,
      },
    },
    observation: {
      enabled: false,
      timeoutMs: 1000,
      maxBatchRecords: 512,
      maxBatchBytes: 4194304,
      flushIntervalMs: 1000,
      shutdownFlushMs: 3000,
      serviceName: "workflow-self-recursive-execution",
    },
    controls: {
      startupTimeoutMs: 30000,
      executionTimeoutMs: 3600000,
      shutdownTimeoutMs: 10000,
      maxConcurrentDeliveries: 4,
      allowExplicitRefresh: false,
      diagnosticMaxBytes: 4096,
    },
    intake: { maxCorrelationBytes: 256, maxOutputBytes: 8192 },
  } as const;
}

function inputV2(paths: Awaited<ReturnType<typeof deployment>>) {
  const legacy = input(paths);
  return {
    ...legacy,
    schemaVersion: "execution.config@2.0.0",
    paths: {
      repositoryRoot: legacy.paths.repositoryRoot,
      workspaceRoot: legacy.paths.workspaceRoot,
      allowedWorktreeRoots: legacy.paths.allowedWorktreeRoots,
      stateRoot: legacy.paths.stateRoot,
    },
    runner: { implementationKey: "runner.v2", host: { engine: "langgraph" }, maxParallelToolCalls: 4 },
  } as const;
}

async function loadDocument(extension: ".json" | ".yaml", document: unknown) {
  const paths = await deployment();
  const configPath = join(paths.root, `execution${extension}`);
  const text = extension === ".json"
    ? JSON.stringify(document)
    : (await import("yaml")).stringify(document);
  await writeFile(configPath, text);
  return loadExecutionInstallationConfig(configPath);
}

describe("execution installation configuration", () => {
  it("runs the configuration CLI through a package-manager-style bin symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "execution-config-bin-"));
    const bin = join(root, "execution-config");
    const output = join(root, "execution.yaml");
    await symlink(join(import.meta.dirname, "../../src/configuration/cli.ts"), bin);

    const result = await execFileAsync(process.execPath, ["--import", "tsx", bin, "init", output, "yaml"]);

    expect(result.stdout).toContain("initialized from execution.default@execution.config@2.0.0");
    expect(await readFile(output, "utf8")).toContain("schemaVersion: execution.config@2.0.0");
  });
  it("normalizes equivalent YAML and JSON to one frozen value and stable identities", async () => {
    const paths = await deployment();
    const value = input(paths);
    const jsonPath = join(paths.root, "execution.json");
    const yamlPath = join(paths.root, "execution.yaml");
    await writeFile(jsonPath, JSON.stringify(value));
    await writeFile(yamlPath, (await import("yaml")).stringify(value));

    const [json, yaml] = await Promise.all([
      loadExecutionInstallationConfig(jsonPath),
      loadExecutionInstallationConfig(yamlPath),
    ]);

    expect(json.config).toEqual(yaml.config);
    expect(json.installationConfigIdentity).toBe(yaml.installationConfigIdentity);
    expect(canonicalConfigurationBytes(json.config)).toEqual(canonicalConfigurationBytes(yaml.config));
    expect(Object.isFrozen(json.config)).toBe(true);
    expect(Object.isFrozen(json.config.paths)).toBe(true);
    const canonicalStateRoot = await realpath(paths.stateRoot);
    expect(json.config.paths.packageStoreRoot).toBe(join(canonicalStateRoot, "packages"));
    expect(json.config.paths.runner.sessionRoot).toBe(join(canonicalStateRoot, "runner", "sessions"));

    const jsonProjection = createDeliveryConfigProjection(json.config);
    const yamlProjection = createDeliveryConfigProjection(yaml.config);
    expect(jsonProjection).toEqual(yamlProjection);
    expect(jsonProjection.identity).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(jsonProjection.value)).not.toContain("workflowSource");
    expect(JSON.stringify(jsonProjection.value)).not.toContain("observation");
    expect(JSON.stringify(jsonProjection.value)).not.toContain("credentialStorePath");
    expect(JSON.stringify(jsonProjection.value)).not.toContain(paths.stateRoot);
    expect(jsonProjection.value.paths.runnerResources).toEqual({
      journal: "runner/journal",
      checkpoints: "runner/checkpoints",
      sessions: "runner/sessions",
      custody: "runner/custody",
    });
    expect(createRunnerConfigurationProjection(json.config)).toMatchObject({
      factory: {
        schemaVersion: "runner.factory@1.0.0",
        implementationIdentity: "runner.v1",
        stateDirectory: join(canonicalStateRoot, "runner"),
        host: { engine: "langgraph", checkpointDirectory: join(canonicalStateRoot, "runner", "checkpoints") },
        provider: {
          key: "dsh-headless",
          configuration: { providerIdentity: "dsh-headless", credentialStore: { watch: false } },
        },
      },
      admittedDriver: { providerRoute: "openai-compatible", modelId: "fixture-model", credentialRef: "provider.default" },
    });
  });

  it("canonicalizes filesystem aliases before identity and scope checks", async () => {
    const paths = await deployment();
    const workspaceAlias = join(paths.root, "workspace-alias");
    await symlink(paths.workspaceRoot, workspaceAlias);
    const direct = input(paths);
    const aliased = {
      ...direct,
      paths: {
        ...direct.paths,
        workspaceRoot: workspaceAlias,
        allowedWorktreeRoots: [join(workspaceAlias, "worktrees")],
      },
    };
    const [a, b] = await Promise.all([loadDocument(".json", direct), loadDocument(".json", aliased)]);
    expect(a).toEqual(b);
  });

  it("rejects parser ambiguity, duplicate/unknown keys, placeholders, and forbidden derived input", async () => {
    const paths = await deployment();
    const valid = input(paths);
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["execution.toml", JSON.stringify(valid), "CONFIG_EXTENSION_UNSUPPORTED"],
      ["execution.json", JSON.stringify({ ...valid, schemaVersionDuplicate: 0 }), "CONFIG_UNKNOWN_KEY"],
      ["duplicate.json", JSON.stringify(valid).replace('"schemaVersion":"execution.config@1.0.0"', '"schemaVersion":"execution.config@1.0.0","schemaVersion":"execution.config@1.0.0"'), "CONFIG_DUPLICATE_KEY"],
      ["yaml-in-json.json", "schemaVersion: execution.config@1.0.0", "CONFIG_PARSE_FAILED"],
      ["json-in-yaml.yaml", JSON.stringify(valid), "CONFIG_PARSE_FAILED"],
      ["alias.yaml", "base: &base { x: 1 }\ncopy: *base\n", "CONFIG_YAML_UNSAFE"],
      ["custom-tag.yaml", "schemaVersion: !execution execution.config@1.0.0\n", "CONFIG_YAML_UNSAFE"],
      ["merge-key.yaml", "base: &base { schemaVersion: execution.config@1.0.0 }\n<<: *base\n", "CONFIG_YAML_UNSAFE"],
      ["non-string-key.yaml", "? [schemaVersion]\n: execution.config@1.0.0\n", "CONFIG_YAML_UNSAFE"],
      ["timestamp.yaml", "schemaVersion: 2026-08-23\n", "CONFIG_YAML_UNSAFE"],
      ["binary.yaml", "schemaVersion: !!binary ZXhlY3V0aW9uLmNvbmZpZ0AxLjAuMA==\n", "CONFIG_YAML_UNSAFE"],
      ["nan.yaml", "schemaVersion: .nan\n", "CONFIG_YAML_UNSAFE"],
      ["placeholder.json", JSON.stringify({ ...valid, paths: { ...valid.paths, stateRoot: "__REQUIRED__:paths.stateRoot" } }), "CONFIG_REQUIRED_INPUT_MISSING"],
      ["derived.json", JSON.stringify({ ...valid, paths: { ...valid.paths, packageStoreRoot: join(paths.root, "packages") } }), "CONFIG_DERIVED_KEY_FORBIDDEN"],
    ];

    for (const [name, text, code] of cases) {
      const path = join(paths.root, name);
      await writeFile(path, text);
      await expect(loadExecutionInstallationConfig(path)).rejects.toMatchObject({ code });
    }
  });

  it("rejects invalid paths, source variants, URLs, ranges, and enabled remote observation", async () => {
    const paths = await deployment();
    const valid = input(paths);
    const candidates: ReadonlyArray<readonly [unknown, string]> = [
      [{ ...valid, schemaVersion: "execution.config@2.0.0" }, "CONFIG_SCHEMA_VERSION_UNSUPPORTED"],
      [(({ controls: _controls, ...rest }) => rest)(valid), "CONFIG_TYPE_INVALID"],
      [{ ...valid, paths: { ...valid.paths, repositoryRoot: "relative" } }, "CONFIG_PATH_INVALID"],
      [{ ...valid, paths: { ...valid.paths, credentialStorePath: join(paths.root, "missing-credentials.json") } }, "CONFIG_PATH_INVALID"],
      [{ ...valid, paths: { ...valid.paths, allowedWorktreeRoots: [join(paths.root, "outside")] } }, "CONFIG_PATH_OUT_OF_SCOPE"],
      [{ ...valid, workflowSource: { ...valid.workflowSource, releasesBaseUrl: "http://user:pass@example.com" } }, "CONFIG_URL_INVALID"],
      [{ ...valid, workflowSource: { ...valid.workflowSource, repository: "not-a-repository" } }, "CONFIG_SOURCE_INVALID"],
      [{ ...valid, workflowSource: { kind: "adapter", adapterKey: "fixture", adapterConfigFile: "relative" } }, "CONFIG_SOURCE_INVALID"],
      [{ ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, modelId: "" } } }, "CONFIG_REQUIRED_VALUE"],
      [{ ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, credentialRef: "" } } }, "CONFIG_REQUIRED_VALUE"],
      [{ ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, baseUrl: "ftp://provider.example" } } }, "CONFIG_URL_INVALID"],
      [{ ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, maxParallelToolCalls: 33 } } }, "CONFIG_RANGE_INVALID"],
      [{ ...valid, runner: { ...valid.runner, provider: { ...valid.runner.provider, maxParallelToolCalls: "4" } } }, "CONFIG_RANGE_INVALID"],
      [{ ...valid, controls: { ...valid.controls, maxConcurrentDeliveries: 0 } }, "CONFIG_RANGE_INVALID"],
      [{ ...valid, observation: { ...valid.observation, enabled: true, endpoint: "https://telemetry.example/v1" } }, "CONFIG_OBSERVATION_ENDPOINT_INVALID"],
    ];
    for (const [candidate, code] of candidates) {
      await expect(loadDocument(".json", candidate)).rejects.toMatchObject({ code });
    }
  });

  it("accepts enabled loopback Observation and one configured alternate Source", async () => {
    const paths = await deployment();
    const adapterConfigFile = join(paths.root, "alternate-source.json");
    await writeFile(adapterConfigFile, "{}");
    const valid = input(paths);
    const enabled = await loadDocument(".json", {
      ...valid,
      observation: { ...valid.observation, enabled: true, endpoint: "http://127.0.0.1:4318" },
    });
    expect(enabled.config.observation.endpoint).toBe("http://127.0.0.1:4318");
    const alternate = await loadDocument(".json", {
      ...valid,
      workflowSource: { kind: "adapter", adapterKey: "fixture", adapterConfigFile },
    });
    expect(alternate.config.workflowSource).toEqual({ kind: "adapter", adapterKey: "fixture", adapterConfigFile: await realpath(adapterConfigFile) });
  });

  it("redacts V2 paths and never introduces Provider credentials", async () => {
    const paths = await deployment();
    const configPath = join(paths.root, "redaction-v2.json");
    await writeFile(configPath, JSON.stringify(inputV2(paths)));
    const loaded = await loadExecutionInstallationConfigV2(configPath);
    const redacted = JSON.stringify(redactEffectiveConfiguration(loaded.config));
    expect(redacted).toContain("[sensitive-path]");
    for (const forbidden of [paths.credentialStorePath, "secret material", "credentialRef", "provider.default"]) expect(redacted).not.toContain(forbidden);
  });

  it("ships structurally equivalent YAML and JSON defaults with exact required markers", async () => {
    const yaml = await readFile(new URL("../../config/defaults/execution.default.yaml", import.meta.url), "utf8");
    const json = await readFile(new URL("../../config/defaults/execution.default.json", import.meta.url), "utf8");
    const parsedYaml = (await import("yaml")).parse(yaml);
    const parsedJson = JSON.parse(json) as unknown;
    expect(parsedYaml).toEqual(parsedJson);
    expect(new Set(json.match(/__REQUIRED__:[^"\]]+/gu))).toHaveLength(3);
    const schema = JSON.parse(await readFile(new URL("../../config/schema/execution.config.v2.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    });
  });

  it("separates installation identity from the config-only Delivery projection identity", async () => {
    const paths = await deployment();
    const original = input(paths);
    const observed = { ...original, observation: { ...original.observation, serviceName: "changed-installation-only" } };
    const model = { ...original, runner: { ...original.runner, provider: { ...original.runner.provider, modelId: "changed-model" } } };
    const [a, b, c] = await Promise.all([loadDocument(".json", original), loadDocument(".json", observed), loadDocument(".json", model)]);
    expect(a.installationConfigIdentity).not.toBe(b.installationConfigIdentity);
    expect(createDeliveryConfigProjection(a.config).identity).toBe(createDeliveryConfigProjection(b.config).identity);
    expect(createDeliveryConfigProjection(a.config).identity).not.toBe(createDeliveryConfigProjection(c.config).identity);
  });

  it("boots configuration preflight from each shipped default after only required replacements", async () => {
    const paths = await deployment();
    const replacements = new Map([
      ["paths.repositoryRoot", paths.repositoryRoot],
      ["paths.workspaceRoot", paths.workspaceRoot],
      ["paths.stateRoot", paths.stateRoot],
    ]);
    const fill = (document: string) => [...replacements].reduce(
      (result, [field, value]) => result.replaceAll(`__REQUIRED__:${field}`, value),
      document,
    );
    const jsonPath = join(paths.root, "from-default.json");
    const yamlPath = join(paths.root, "from-default.yaml");
    await writeFile(jsonPath, fill(await readFile(new URL("../../config/defaults/execution.default.json", import.meta.url), "utf8")));
    await writeFile(yamlPath, fill(await readFile(new URL("../../config/defaults/execution.default.yaml", import.meta.url), "utf8")));
    const [json, yaml] = await Promise.all([loadExecutionInstallationConfigV2(jsonPath), loadExecutionInstallationConfigV2(yamlPath)]);
    expect(json).toEqual(yaml);
  });

  it("uses typed redacted diagnostics", () => {
    const error = new ConfigurationError("CONFIG_RANGE_INVALID", ["runner.provider.maxParallelToolCalls"]);
    expect(error).toMatchObject({
      code: "CONFIG_RANGE_INVALID",
      fieldPaths: ["runner.provider.maxParallelToolCalls"],
    });
    expect(error.message).not.toContain("33");
    expect(error).not.toHaveProperty("cause");
  });

  it("admits an Intake profile containing only one absolute config path", () => {
    expect(admitIntakeProfileConfiguration({ configFile: "/etc/workflow-execution/config.yaml" }))
      .toEqual({ configFile: "/etc/workflow-execution/config.yaml" });
    expect(() => admitIntakeProfileConfiguration({ configFile: "relative.yaml" })).toThrow();
    expect(() => admitIntakeProfileConfiguration({ configFile: "/tmp/config.yaml", provider: {} })).toThrow();
  });

  it("initializes without overwrite and dumps only redacted effective values", async () => {
    const paths = await deployment();
    const target = join(paths.root, "new-config.yaml");
    await initializeExecutionConfiguration(target, "yaml");
    const initialized = await readFile(target, "utf8");
    expect(initialized).toContain("execution.config@2.0.0");
    await expect(initializeExecutionConfiguration(target, "yaml")).rejects.toMatchObject({ code: "CONFIG_PATH_INVALID" });

    const configPath = join(paths.root, "effective.json");
    await writeFile(configPath, JSON.stringify(inputV2(paths)));
    const dumped = await dumpEffectiveExecutionConfiguration(configPath);
    expect(dumped).toContain('"requiredComplete":true');
    expect(dumped).toContain("execution.default@execution.config@2.0.0");
    expect(dumped).not.toContain("credential");
  });

  it("provides init, validate, and dump-effective CLI operations without nested overrides", async () => {
    const paths = await deployment();
    const initializedPath = join(paths.root, "cli-default.json");
    expect(await runExecutionConfigCli(["init", initializedPath, "json"])).toContain("execution.default@execution.config@2.0.0");

    const configPath = join(paths.root, "cli-effective.json");
    await writeFile(configPath, JSON.stringify(inputV2(paths)));
    expect(await runExecutionConfigCli(["validate", configPath])).toMatch(/^sha256:[0-9a-f]{64}\n$/u);
    expect(await runExecutionConfigCli(["dump-effective", configPath])).toContain('"requiredComplete":true');
    await expect(runExecutionConfigCli([])).rejects.toThrow("usage: execution-config");
    await expect(runExecutionConfigCli(["init", join(paths.root, "invalid"), "toml"])).rejects.toThrow("format must be yaml or json");
    await expect(runExecutionConfigCli(["validate", configPath, "runner.provider.modelId=override"])).rejects.toThrow("does not accept nested overrides");
    await expect(runExecutionConfigCli(["unknown", configPath])).rejects.toThrow("unknown execution-config command");
  });
});
