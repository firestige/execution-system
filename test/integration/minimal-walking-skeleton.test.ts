import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { RunnerFactory, type RunnerFactoryConfig, type RunnerFactoryDependencies } from "../../src/index.js";
import { createRunnerOwnerFactPort, type RunnerSettlementOwnerFact } from "../../src/observation/index.js";
import { EXECUTION_RUNTIME_ADAPTER_VERSION } from "../../src/execution/runtime-adapter.js";
import { buildMinimalRunnerActivation } from "../support/wave4/minimal-admitted-activation.js";
import {
  createMinimalValidationActionAdapter,
  minimalValidationExpectations,
  type ValidationActionBehavior,
} from "../support/wave4/validation-action-adapter.js";

const roots: string[] = [];
const servers: Server[] = [];
const minimalCorpus = path.join(
  path.dirname(fileURLToPath(new URL("../..", import.meta.url))),
  "system-contracts/workflow-dsl/examples/minimal",
);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function completion(result: unknown, index: number): string {
  const args = JSON.stringify({ result });
  return [
    `data: ${JSON.stringify({ id: `completion-${index}`, object: "chat.completion.chunk", created: index, model: "deepseek-chat", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: { name: "workflow_complete", arguments: args } }] }, finish_reason: "tool_calls" }] })}`,
    "", "data: [DONE]", "", "",
  ].join("\n");
}

async function environment() {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-walking-skeleton-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "minimal candidate\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  const credentialPath = path.join(root, "credentials.yml");
  await writeFile(credentialPath, "version: 1\nrefs:\n  WALKING_SKELETON_KEY: synthetic-secret\n", "utf8");
  await chmod(credentialPath, 0o600);
  const results = [
    { status: "confirmed", authorityMap: {} },
    { findings: [] },
    { findings: [] },
    { routing: "finalize", findingsCount: 0 },
  ];
  const authorization: string[] = [];
  const server = createServer((request, response) => {
    const result = results.shift();
    authorization.push(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(completion(result ?? { malformed: true }, authorization.length));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("local transport did not bind");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const config = Object.freeze({
    schemaVersion: "runner.factory@1.0.0",
    stateDirectory: path.join(root, "coordinator"),
    custody: Object.freeze({
      recordsDirectory: path.join(root, "custody"),
      publication: Object.freeze({ targetIdentity: "publication-target.walking-skeleton", repositoryPath: workspace, ref: "refs/heads/candidate" }),
    }),
    provider: Object.freeze({
      key: "dsh-headless",
      configuration: Object.freeze({
        providerIdentity: "dsh-headless", workspaceDirectory: workspace, sessionStorageDirectory: path.join(root, "sessions"),
        credentialStore: Object.freeze({ path: credentialPath, watch: false }), maxParallelToolCalls: 1,
      }),
    }),
    invocation: Object.freeze({ journalDirectory: path.join(root, "journals") }),
    host: Object.freeze({ engine: "langgraph", checkpointDirectory: path.join(root, "checkpoints") }),
    implementationIdentity: "implementation.runner.langgraph-dsh",
  }) satisfies RunnerFactoryConfig;
  return { root, workspace, baseURL, config, authorization, remaining: results };
}

const dependencies = Object.freeze({
  interaction: Object.freeze({
    async publish() { return { ok: true as const, value: undefined }; },
    async requestInput() { throw new Error("success path does not request Action input"); },
  }),
  workflow: Object.freeze({ async request() { throw new Error("success path does not enter Workflow Wait"); } }),
  observation: Object.freeze({ async observe() {} }),
  startCorrelation: Object.freeze({ async acknowledge() { return { ok: true as const, value: undefined }; } }),
  hostOperations: Object.freeze({}),
});

function creationDependencies(
  hostOperations: RunnerFactoryDependencies["hostOperations"],
  observation: RunnerFactoryDependencies["observation"] = dependencies.observation,
): RunnerFactoryDependencies {
  return Object.freeze({ ...dependencies, hostOperations, observation });
}

describe("Wave 4 real minimal walking skeleton", () => {
  it("executes admitted minimal topology through real DSH, Host, Custody and Coordinator", async () => {
    const fixture = await environment();
    const activation = await buildMinimalRunnerActivation({
      corpusDirectory: minimalCorpus,
      workspaceDirectory: fixture.workspace,
      baseURL: fixture.baseURL,
    });
    const validation = createMinimalValidationActionAdapter({
      correlation: activation.correlation,
      expectations: minimalValidationExpectations(),
    });
    const observed: unknown[] = [];
    const factory = new RunnerFactory();
    const adapter = await factory.create(fixture.config, creationDependencies(validation.hostOperations,
      createRunnerOwnerFactPort(Object.freeze({ emit(fact: RunnerSettlementOwnerFact) { observed.push(fact); } }))));
    try {
      const executed = await adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation });
      expect(executed).toMatchObject({ ok: true, value: {
        kind: "terminal",
        outcome: "COMPLETED",
        settlement: {
          publication: { kind: "published" },
          ownerRetirements: [
            { owner: "coordinator", state: "retired" },
            { owner: "host", state: "retired" },
            { owner: "invocation", state: "retired" },
            { owner: "custody", state: "retired" },
          ],
        },
      } });
      expect(fixture.authorization).toEqual(Array(4).fill("Bearer synthetic-secret"));
      expect(fixture.remaining).toEqual([]);
      expect(observed).toEqual([expect.objectContaining({ owner: "M02", phase: "RUNNER_TERMINAL_SETTLED" })]);
      expect(validation.remaining()).toEqual([]);
      expect(validation.records()).toEqual([
        expect.objectContaining({ validatorIdentity: "validator.intake-checks", actionIdentity: "action.intake", disposition: { kind: "accepted" } }),
        expect.objectContaining({ validatorIdentity: "validator.review-isolation", actionIdentity: "action.review.blackbox", disposition: { kind: "accepted" } }),
        expect.objectContaining({ validatorIdentity: "validator.review-isolation", actionIdentity: "action.review.whitebox", disposition: { kind: "accepted" } }),
        expect.objectContaining({ validatorIdentity: "validator.aggregation-rules", actionIdentity: "action.aggregate", disposition: { kind: "accepted" } }),
        expect.objectContaining({ validatorIdentity: "validator.finalize-checks", actionIdentity: "action.finalize", disposition: { kind: "accepted" } }),
      ]);
      expect(execFileSync("git", ["rev-parse", "refs/heads/candidate"], { cwd: fixture.workspace, encoding: "utf8" }).trim()).toMatch(/^[a-f0-9]{40}$/);
      const delivery = activation.correlation;
      const inspected = await adapter.inspect({
        deliveryIdentity: delivery.deliveryIdentity,
        manifestBindingIdentity: delivery.manifestBindingIdentity,
        activationBindingIdentity: activation.bindingIdentity,
      });
      expect(inspected).toMatchObject({ ok: true, value: { state: "terminal", result: { state: "known", value: executed.ok ? executed.value : undefined } } });
    } finally {
      await factory.dispose(adapter);
    }
  }, 20_000);

  it.each([
    ["rejected", "FAILED"],
    ["unavailable", "unknown"],
    ["throw", "unknown"],
    ["malformed", "unknown"],
  ] as const)("fails closed when the validation action is %s", async (behavior, expected) => {
    const fixture = await environment();
    const activation = await buildMinimalRunnerActivation({
      corpusDirectory: minimalCorpus,
      workspaceDirectory: fixture.workspace,
      baseURL: fixture.baseURL,
      deliveryIdentity: `delivery.validation-${behavior}`,
    });
    const validation = createMinimalValidationActionAdapter({
      correlation: activation.correlation,
      expectations: minimalValidationExpectations(),
      behavior: behavior as ValidationActionBehavior,
    });
    const factory = new RunnerFactory();
    const adapter = await factory.create(fixture.config, creationDependencies(validation.hostOperations));
    try {
      const executed = await adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation });
      expect(executed).toMatchObject(expected === "FAILED"
        ? { ok: true, value: { kind: "terminal", outcome: "FAILED" } }
        : { ok: true, value: { kind: "unknown" } });
      expect(fixture.authorization).toEqual(["Bearer synthetic-secret"]);
      expect(validation.records()).toHaveLength(behavior === "throw" || behavior === "malformed" ? 0 : 1);
    } finally {
      await factory.dispose(adapter);
    }
  }, 20_000);

  it("fails closed when a declared validator is not registered", async () => {
    const fixture = await environment();
    const activation = await buildMinimalRunnerActivation({
      corpusDirectory: minimalCorpus,
      workspaceDirectory: fixture.workspace,
      baseURL: fixture.baseURL,
      deliveryIdentity: "delivery.validation-unregistered",
    });
    const validation = createMinimalValidationActionAdapter({ correlation: activation.correlation, expectations: minimalValidationExpectations() });
    const operations = Object.freeze(Object.fromEntries(
      Object.entries(validation.hostOperations).filter(([identity]) => identity !== "validator.intake-checks"),
    ));
    const factory = new RunnerFactory();
    const adapter = await factory.create(fixture.config, creationDependencies(operations));
    try {
      await expect(adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation })).resolves.toMatchObject({
        ok: true, value: { kind: "terminal", outcome: "FAILED" },
      });
      expect(fixture.authorization).toEqual(["Bearer synthetic-secret"]);
      expect(validation.records()).toEqual([]);
    } finally {
      await factory.dispose(adapter);
    }
  }, 20_000);
});
