import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DefaultExecutionApplicationFactory,
  ProductionHostOperationRegistryError,
  createProductionHostOperationHandlers,
  getExecutionApplicationControl,
  type ExecutionBootstrapDependencies,
} from "../../src/index.js";
import { ProductionInteractionBroker } from "../../src/bootstrap/interaction-broker.js";

const roots: string[] = [];
const servers: Server[] = [];
const repositoryRoot = path.dirname(fileURLToPath(new URL("../..", import.meta.url)));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: Readonly<{
  baseUrl?: string;
  deliveryId?: string;
  deliveryIds?: readonly string[];
  observationEndpoint?: string;
  network?: (url: string) => Promise<Readonly<{ status: number; body: Uint8Array }>>;
}> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "execution-bootstrap-")));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const worktree = path.join(workspaceRoot, "worktree");
  await mkdir(worktree, { recursive: true });
  await mkdir(path.join(root, "state"));
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  const configFile = path.join(root, "execution.json");
  await writeFile(configFile, `${JSON.stringify({
    schemaVersion: "execution.config@1.0.0",
    paths: {
      repositoryRoot: worktree,
      workspaceRoot,
      allowedWorktreeRoots: [workspaceRoot],
      stateRoot: path.join(root, "state"),
      credentialStorePath: path.join(root, "credentials.yml"),
    },
    workflowSource: {
      kind: "github",
      repository: "firestige/workflow-package",
      releasesBaseUrl: "https://api.github.example.test/repos/firestige/workflow-package/releases",
      assetPattern: "workflow-package-{name}-{version}.tar.gz",
    },
    runner: {
      implementationKey: "runner.v1",
      host: { engine: "langgraph" },
      provider: {
        key: "dsh", route: "deepseek", modelId: "fixture-model",
        baseUrl: options.baseUrl ?? "http://127.0.0.1:9", credentialRef: "PROVIDER_KEY", maxParallelToolCalls: 1,
      },
    },
    observation: {
      enabled: options.observationEndpoint !== undefined,
      ...(options.observationEndpoint === undefined ? {} : { endpoint: options.observationEndpoint }),
      timeoutMs: 100, maxBatchRecords: 512, maxBatchBytes: 4_194_304,
      flushIntervalMs: 1_000, shutdownFlushMs: 1_000, serviceName: "execution-fixture",
    },
    controls: {
      startupTimeoutMs: 10_000, executionTimeoutMs: 10_000, shutdownTimeoutMs: 10_000,
      maxConcurrentDeliveries: 2, allowExplicitRefresh: false, diagnosticMaxBytes: 512,
    },
    intake: { maxCorrelationBytes: 256, maxOutputBytes: 1_024 },
  })}\n`, "utf8");
  await writeFile(path.join(root, "credentials.yml"), "version: 1\nrefs:\n  PROVIDER_KEY: fixture\n", { mode: 0o600 });
  const requested: string[] = [];
  let deliverySequence = 0;
  const dependencies: ExecutionBootstrapDependencies = Object.freeze({
    clock: Object.freeze({ now: () => 1 }),
    ids: Object.freeze({ create: () => options.deliveryIds?.[deliverySequence++] ?? options.deliveryId ?? "delivery-production" }),
    filesystem: Object.freeze({
      read: async () => new Uint8Array(), writeImmutable: async () => undefined,
      list: async () => [], inspect: async () => Object.freeze({ kind: "missing" as const }),
    }),
    network: Object.freeze({ request: async (url: string) => {
      requested.push(url);
      return options.network?.(url) ?? Object.freeze({ status: 404, body: new Uint8Array() });
    } }),
    intake: Object.freeze({ publish: async () => undefined }),
    attachments: Object.freeze({ read: async () => { throw new Error("not requested"); } }),
  });
  return { configFile, dependencies, requested, worktree };
}

describe("Wave 6 production bootstrap", () => {
  it("bridges Workflow Wait through the bound Intake with exact JSON correlation", async () => {
    const presentations: any[] = [];
    const broker = new ProductionInteractionBroker(Object.freeze({ async publish(message: any) { presentations.push(message); } }));
    broker.expect("/worktree", "intake-correlation");
    broker.register("delivery-wait", "/worktree", "fixture@1.0.0");
    const request = Object.freeze({
      controlIdentity: "control-1", correlationIdentity: "correlation-1", kind: "user",
      content: Object.freeze({ question: "Confirm?" }), contentIdentity: "sha256:request",
    }) as any;
    const waiting = broker.workflowBridge("delivery-wait").request(request);
    await expect.poll(() => presentations).toEqual([{
      schemaVersion: "wsr.presentation@1.0.0",
      correlation: "intake-correlation",
      kind: "action-input-request",
      data: { prompt: { question: "Confirm?" } },
    }]);
    expect(broker.respond("delivery-wait", "ACTION_FINISH_REQUESTED", { text: "", attachments: [] })).toBe(false);
    expect(broker.respond("delivery-wait", "ANSWER", { text: "not-json", attachments: [] })).toBe(false);
    expect(broker.respond("delivery-wait", "ANSWER", { text: '{"confirmed":true}', attachments: [] })).toBe(true);
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      value: { controlIdentity: "control-1", correlationIdentity: "correlation-1", content: { confirmed: true }, contentIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
    });
  });

  it("builds only exact admitted Host Operation handlers from installation factories", async () => {
    const formatFactory = Object.freeze({ create: () => Object.freeze({ async execute(input: any) { return { accepted: true, value: input }; } }) });
    const activation = Object.freeze({ program: Object.freeze({ execution: Object.freeze({
      hostOperations: Object.freeze({ selection: Object.freeze({ contractIdentity: "contract.selection", configuration: Object.freeze({ validator: "validator.select" }) }) }),
      actions: Object.freeze({ intake: Object.freeze({ gate: Object.freeze({ deterministic: Object.freeze(["validator.intake"]) }) }) }),
    }) }) }) as any;
    const handlers = createProductionHostOperationHandlers(activation, Object.freeze({
      "contract.selection": formatFactory,
      "host-operation.deterministic-validation.v1": formatFactory,
    }));
    expect(Object.keys(handlers)).toEqual(["contract.selection", "validator.intake"]);
    await expect(handlers["validator.intake"]!.execute(Object.freeze({ ok: true }), Object.freeze({})))
      .resolves.toEqual({ accepted: true, value: { ok: true } });
    expect(() => createProductionHostOperationHandlers(activation, Object.freeze({
      "host-operation.deterministic-validation.v1": formatFactory,
    }))).toThrow(ProductionHostOperationRegistryError);
    expect(() => new DefaultExecutionApplicationFactory({ hostOperationFactories: {
      "host-operation.deterministic-validation.v1": formatFactory,
    } })).toThrow(ProductionHostOperationRegistryError);
  });

  it("fails closed across pre-ready, unknown-control, and close-before-start paths", async () => {
    const { configFile, dependencies, worktree } = await fixture();
    expect(() => getExecutionApplicationControl(Object.freeze({}) as never)).toThrow("EXECUTION_APPLICATION_CONTROL_UNKNOWN");
    const application = await new DefaultExecutionApplicationFactory().create(configFile, dependencies);
    const control = getExecutionApplicationControl(application);
    await expect(application.execute({ worktree, selector: "x@1.0.0", prompt: { text: "x", attachments: [] } })).resolves.toMatchObject({ kind: "ERROR", code: "APPLICATION_NOT_READY" });
    await expect(application.inspect(worktree)).resolves.toMatchObject({ kind: "ERROR", code: "APPLICATION_NOT_READY" });
    await expect(application.cancel("missing")).resolves.toMatchObject({ kind: "ERROR", code: "APPLICATION_NOT_READY" });
    await expect(control.list()).resolves.toEqual([]);
    await expect(control.recover({ worktree, correlation: "c" })).resolves.toMatchObject({ kind: "ERROR", code: "DELIVERY_UNKNOWN" });
    await expect(control.status({ correlation: "c" })).resolves.toMatchObject({ kind: "ERROR", code: "DELIVERY_UNKNOWN" });
    await expect(control.finishAction({ correlation: "c" })).resolves.toMatchObject({ kind: "ERROR", code: "DELIVERY_UNKNOWN" });
    await expect(control.answerAction({ correlation: "c", prompt: { text: "x", attachments: [] } })).resolves.toMatchObject({ kind: "ERROR", code: "DELIVERY_UNKNOWN" });
    await expect(control.waitForDelivery("never", 1)).resolves.toBeUndefined();
    await application.close();
    await application.close();
    await application.start();
    expect(application.status()).toEqual({ state: "CLOSED" });
    await expect(application.execute({ worktree, selector: "x@1.0.0", prompt: { text: "x", attachments: [] } })).resolves.toMatchObject({ code: "APPLICATION_CLOSING" });
    await expect(application.inspect(worktree)).resolves.toMatchObject({ code: "APPLICATION_CLOSING" });
    await expect(application.cancel("missing")).resolves.toMatchObject({ code: "APPLICATION_CLOSING" });
  });

  it("owns the public lifecycle and exact configured Source without a second assembly path", async () => {
    const { configFile, dependencies, requested, worktree } = await fixture();
    const application = await new DefaultExecutionApplicationFactory().create(configFile, dependencies);

    expect(application.status()).toEqual({ state: "CREATED" });
    await application.start();
    await application.start();
    expect(application.status()).toEqual({ state: "READY" });
    await expect(application.inspect(worktree)).resolves.toMatchObject({ kind: "ERROR", code: "DELIVERY_UNKNOWN" });
    await expect(application.cancel("delivery-missing")).resolves.toMatchObject({ kind: "ERROR", code: "DELIVERY_UNKNOWN" });
    const control = getExecutionApplicationControl(application);
    await expect(control.status({ worktree, correlation: "c" })).resolves.toMatchObject({ kind: "ERROR", code: "DELIVERY_UNKNOWN" });

    await expect(application.execute({
      worktree, selector: "missing@1.0.0", prompt: { text: "run", attachments: [] },
    })).resolves.toMatchObject({ kind: "ERROR", code: "WORKFLOW_NOT_FOUND" });
    expect(requested).toEqual([
      "https://api.github.example.test/repos/firestige/workflow-package/releases/tags/1.0.0",
    ]);

    await application.close();
    await application.close();
    expect(application.status()).toEqual({ state: "CLOSED" });
    await expect(application.execute({
      worktree, selector: "missing@1.0.0", prompt: { text: "run", attachments: [] },
    })).resolves.toMatchObject({ kind: "ERROR", code: "APPLICATION_CLOSING" });
  });

  it("composes M01 through the pinned Runner and closes every Runner-owned DSH-E", async () => {
    const observedPaths: string[] = [];
    const observationEndpoint = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        observedPaths.push(request.url ?? "");
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      });
    });
    servers.push(observationEndpoint);
    await new Promise<void>((resolve) => observationEndpoint.listen(0, "127.0.0.1", resolve));
    const observationAddress = observationEndpoint.address();
    if (observationAddress === null || typeof observationAddress === "string") throw new Error("observation endpoint unavailable");
    const endpoint = createServer((_request, response) => {
      const result = { authorityBound: false, designIdentityExact: false, obligationRegisterBound: false, derivableFactMissing: true, routing: "unmatched" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ id: "completion-1", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "workflow_complete", arguments: JSON.stringify({ result }) } }] }, finish_reason: "tool_calls" }] })}`,
        "", "data: [DONE]", "", "",
      ].join("\n"));
    });
    servers.push(endpoint);
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    if (address === null || typeof address === "string") throw new Error("endpoint unavailable");

    const materialRoot = await realpath(await mkdtemp(path.join(tmpdir(), "production-release-")));
    roots.push(materialRoot);
    const material = path.join(materialRoot, "material");
    await mkdir(material);
    await cp(path.join(repositoryRoot, "workflow-package", "implementation"), path.join(material, "package"), { recursive: true });
    const archivePath = path.join(materialRoot, "workflow-package-implementation-workflow-0.3.0.tar.gz");
    const packed = spawnSync("tar", ["-czf", archivePath, "-C", material, "."], { encoding: "utf8", shell: false });
    if (packed.status !== 0) throw new Error(packed.stderr);
    const archive = Uint8Array.from(await readFile(archivePath));
    const assetUrl = "https://github.example.test/releases/download/0.3.0/workflow-package-implementation-workflow-0.3.0.tar.gz";
    const { configFile, dependencies, worktree } = await fixture({
      baseUrl: `http://127.0.0.1:${address.port}`,
      deliveryId: "delivery-production-smoke",
      observationEndpoint: `http://127.0.0.1:${observationAddress.port}`,
      network: async (url) => url === assetUrl
        ? Object.freeze({ status: 200, body: archive })
        : Object.freeze({ status: 200, body: Buffer.from(JSON.stringify({ tag_name: "0.3.0", assets: [{ name: path.basename(archivePath), browser_download_url: assetUrl }] })) }),
    });
    await writeFile(path.join(worktree, "README.md"), "production bootstrap\n", "utf8");
    execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: worktree });
    execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: worktree });
    execFileSync("git", ["add", "README.md"], { cwd: worktree });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: worktree });

    const application = await new DefaultExecutionApplicationFactory().create(configFile, dependencies);
    await application.start();
    await expect(application.execute({
      worktree,
      selector: "implementation-workflow@0.3.0",
      prompt: { text: "exercise production composition", attachments: [] },
    })).resolves.toMatchObject({ kind: "TERMINAL", deliveryId: "delivery-production-smoke", outcome: "FAILED" });
    await application.close();
    expect(application.status()).toEqual({ state: "CLOSED" });
    expect(observedPaths).toEqual(expect.arrayContaining(["/v1/traces", "/v1/logs"]));
  }, 30_000);

  it("keeps one correlated Action interaction open until target-free action finish", async () => {
    let requestCount = 0;
    const endpoint = createServer((_request, response) => {
      requestCount += 1;
      const tool = requestCount <= 3
        ? { name: "workflow_request_input", arguments: JSON.stringify({ requestIdentity: `grilling-${requestCount}`, prompt: { question: `Question ${requestCount}?` }, responseSchema: { type: "object" } }) }
        : { name: "workflow_complete", arguments: JSON.stringify({ result: { authorityBound: false, designIdentityExact: false, obligationRegisterBound: false, derivableFactMissing: true, routing: "unmatched" } }) };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ id: `completion-${requestCount}`, object: "chat.completion.chunk", created: requestCount, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requestCount}`, type: "function", function: tool }] }, finish_reason: "tool_calls" }] })}`,
        "", "data: [DONE]", "", "",
      ].join("\n"));
    });
    servers.push(endpoint);
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    if (address === null || typeof address === "string") throw new Error("endpoint unavailable");

    const materialRoot = await realpath(await mkdtemp(path.join(tmpdir(), "production-interaction-")));
    roots.push(materialRoot);
    const material = path.join(materialRoot, "material");
    await mkdir(material);
    await cp(path.join(repositoryRoot, "workflow-package", "implementation"), path.join(material, "package"), { recursive: true });
    const archivePath = path.join(materialRoot, "workflow-package-implementation-workflow-0.3.0.tar.gz");
    const packed = spawnSync("tar", ["-czf", archivePath, "-C", material, "."], { encoding: "utf8", shell: false });
    if (packed.status !== 0) throw new Error(packed.stderr);
    const archive = Uint8Array.from(await readFile(archivePath));
    const assetUrl = "https://github.example.test/releases/download/0.3.0/workflow-package-implementation-workflow-0.3.0.tar.gz";
    const { configFile, dependencies, worktree } = await fixture({
      baseUrl: `http://127.0.0.1:${address.port}`,
      deliveryIds: ["delivery-production-interaction", "delivery-production-parallel"],
      network: async (url) => url === assetUrl
        ? Object.freeze({ status: 200, body: archive })
        : Object.freeze({ status: 200, body: Buffer.from(JSON.stringify({ tag_name: "0.3.0", assets: [{ name: path.basename(archivePath), browser_download_url: assetUrl }] })) }),
    });
    await writeFile(path.join(worktree, "README.md"), "production interaction\n", "utf8");
    execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: worktree });
    execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: worktree });
    execFileSync("git", ["add", "README.md"], { cwd: worktree });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: worktree });

    const application = await new DefaultExecutionApplicationFactory().create(configFile, dependencies);
    const control = getExecutionApplicationControl(application);
    await application.start();
    const execution = application.execute({
      worktree,
      selector: "implementation-workflow@0.3.0",
      prompt: { text: "begin grilling", attachments: [] },
      intakeCorrelation: "intake-correlation-1",
    });
    await expect(control.waitForDelivery("intake-correlation-1", 5_000)).resolves.toMatchObject({ deliveryId: "delivery-production-interaction", worktree });
    await expect(control.status({ deliveryId: "delivery-production-interaction", correlation: "status-correlation" }))
      .resolves.toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-production-interaction", worktree });
    await expect.poll(async () => (await control.list())[0]?.action, { timeout: 10_000 }).toBe("AWAITING_INPUT");
    const secondWorktree = path.join(path.dirname(worktree), "worktree-parallel");
    await mkdir(secondWorktree);
    execFileSync("git", ["init", "-q"], { cwd: secondWorktree });
    await writeFile(path.join(secondWorktree, "README.md"), "parallel production interaction\n", "utf8");
    execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: secondWorktree });
    execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: secondWorktree });
    execFileSync("git", ["add", "README.md"], { cwd: secondWorktree });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: secondWorktree });
    const parallel = application.execute({
      worktree: secondWorktree,
      selector: "implementation-workflow@0.3.0",
      prompt: { text: "parallel grilling", attachments: [] },
      intakeCorrelation: "intake-correlation-2",
    });
    await expect(control.waitForDelivery("intake-correlation-2", 5_000)).resolves.toMatchObject({ deliveryId: "delivery-production-parallel", worktree: secondWorktree });
    await expect.poll(async () => (await control.list()).filter((item) => item.action === "AWAITING_INPUT").length, { timeout: 10_000 }).toBe(2);
    await expect(control.answerAction({ correlation: "intake-correlation-1", prompt: { text: "ordinary grilling answer", attachments: [] } }))
      .resolves.toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-production-interaction" });
    await expect.poll(async () => requestCount >= 3 && (await control.list()).find((item) => item.deliveryId === "delivery-production-interaction")?.action, { timeout: 10_000 }).toBe("AWAITING_INPUT");
    await expect(control.finishAction({ correlation: "intake-correlation-1", prompt: { text: "final grilling answer", attachments: [] } }))
      .resolves.toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-production-interaction" });
    await expect(execution).resolves.toMatchObject({ kind: "TERMINAL", deliveryId: "delivery-production-interaction" });
    await expect(control.finishAction({ correlation: "intake-correlation-1" }))
      .resolves.toMatchObject({ kind: "ERROR", code: "ACTION_NOT_AWAITING_INPUT" });
    await application.close();
    void parallel.catch(() => undefined);

    const restarted = await new DefaultExecutionApplicationFactory().create(configFile, dependencies);
    const restartedControl = getExecutionApplicationControl(restarted);
    expect(await restartedControl.list()).toHaveLength(1);
    restartedControl.attach("delivery-production-parallel", "intake-correlation-2");
    const restarting = restarted.start();
    await expect.poll(async () => (await restartedControl.list())[0]?.action, { timeout: 10_000 }).toBe("AWAITING_INPUT");
    const stateWhileAwaitingInput = restarted.status().state;
    await expect(restartedControl.finishAction({ correlation: "intake-correlation-2", prompt: { text: "parallel final answer", attachments: [] } }))
      .resolves.toMatchObject({ kind: "RECOVERY", deliveryId: "delivery-production-parallel" });
    await restarting;
    await expect.poll(async () => (await restartedControl.list()).length, { timeout: 10_000 }).toBe(0);
    await restarted.close();
    expect(stateWhileAwaitingInput).toBe("READY");
    expect(requestCount).toBe(5);
  }, 30_000);

  it("fails startup closed with one bounded redacted diagnostic", async () => {
    const { configFile, dependencies } = await fixture();
    const config = JSON.parse(await readFile(configFile, "utf8")) as { paths: { stateRoot: string } };
    const slots = path.join(config.paths.stateRoot, "current-slots");
    await mkdir(slots, { recursive: true });
    await writeFile(path.join(slots, "corrupt.json"), '{"credential":"must-not-leak"}\n', "utf8");
    const application = await new DefaultExecutionApplicationFactory().create(configFile, dependencies);

    await expect(application.start()).rejects.toMatchObject({ code: "BOOTSTRAP_RECOVERY_FAILED" });
    expect(application.status()).toMatchObject({
      state: "CLOSED",
      diagnostic: {
        code: "BOOTSTRAP_RECOVERY_FAILED",
        phase: "RECOVERING",
        installationIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(JSON.stringify(application.status())).not.toContain("credential");
    expect(JSON.stringify(application.status())).not.toContain("stack");
  });
});
