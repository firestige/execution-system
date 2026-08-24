import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { DeliveryConfigProjection } from "../../src/configuration/index.js";
import {
  captureTaskPromptSnapshot,
  createDeliveryManifest,
  DeliveryAdmissionProjector,
} from "../../src/delivery/index.js";
import { EXECUTION_RUNTIME_ADAPTER_VERSION } from "../../src/execution/runtime-adapter.js";
import { RunnerFactory, type RunnerFactoryConfig } from "../../src/index.js";

const repositoryRoot = path.dirname(fileURLToPath(new URL("../..", import.meta.url)));
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hello-world Workflow model smoke", () => {
  it("projects the current TaskPrompt into a zero-authority model Action and returns structured success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hello-world-model-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "runner@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Runner Fixture"], { cwd: workspace });
    await writeFile(path.join(workspace, "README.md"), "hello model smoke\n");
    execFileSync("git", ["add", "README.md"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
    const requests: string[] = [];
    const endpoint = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ id: "hello-completion", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "hello-call", type: "function", function: { name: "workflow_complete", arguments: JSON.stringify({ result: { success: true, greeting: "Hello from the configured model." } }) } }] }, finish_reason: "tool_calls" }] })}`,
          "", "data: [DONE]", "", "",
        ].join("\n"));
      });
    });
    servers.push(endpoint);
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    if (address === null || typeof address === "string") throw new Error("model endpoint unavailable");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const credentialPath = path.join(root, "credentials.yml");
    await writeFile(credentialPath, "version: 1\nrefs:\n  HELLO_KEY: synthetic-secret\n");
    await chmod(credentialPath, 0o600);

    const definition = path.join(repositoryRoot, "workflow-package", "hello-world-workflow", "definition");
    const pkg = JSON.parse(await readFile(path.join(definition, "package.json"), "utf8"));
    const workflow = JSON.parse(await readFile(path.join(definition, "workflow.json"), "utf8"));
    const promptSnapshot = await captureTaskPromptSnapshot({
      root: path.join(root, "prompt-snapshots"),
      deliveryId: "delivery-hello",
      prompt: Object.freeze({ text: "Greet Codex", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }),
    });
    const projection = Object.freeze({
      identity: `sha256:${"a".repeat(64)}`,
      value: Object.freeze({
        schemaVersion: "execution.delivery-config@1.0.0",
        paths: Object.freeze({ repositoryRoot: workspace, workspaceRoot: workspace, allowedWorktreeRoots: Object.freeze([workspace]), runnerResources: Object.freeze({ journal: "runner/journal", checkpoints: "runner/checkpoints", sessions: "runner/sessions", custody: "runner/custody" }) }),
        runner: Object.freeze({ implementationKey: "runner.v1", host: Object.freeze({ engine: "langgraph" }), provider: Object.freeze({ key: "dsh", route: "deepseek", modelId: "fixture-model", baseUrl, credentialRef: "HELLO_KEY", maxParallelToolCalls: 1 }) }),
        controls: Object.freeze({ executionTimeoutMs: 30_000, maxConcurrentDeliveries: 1, allowExplicitRefresh: false }),
      }),
    }) as unknown as DeliveryConfigProjection;
    const manifest = createDeliveryManifest({
      deliveryId: "delivery-hello", taskId: "task-hello", createdAt: 1, canonicalWorktree: workspace,
      resolvedPackage: Object.freeze({ name: pkg.package.name, exactVersion: pkg.package.version, packageDigest: pkg.package.digest, localPath: definition, workflowId: workflow.workflow.id }),
      promptSnapshot, deliveryConfigProjection: projection,
    });
    const activation = await new DeliveryAdmissionProjector().project(manifest);
    const agent = Object.values(activation.program.execution.agents)[0]!;
    expect(agent.session.tools).toEqual([]);
    expect(agent.turn.access).toEqual([]);
    expect(activation.initial.state.values.__deliveryTaskPrompt).toEqual({ prompt: { text: "Greet Codex", attachments: [] } });

    const config = Object.freeze({
      schemaVersion: "runner.factory@1.0.0",
      stateDirectory: path.join(root, "coordinator"),
      custody: Object.freeze({ recordsDirectory: path.join(root, "custody"), publication: Object.freeze({ targetIdentity: "publication-target.hello", repositoryPath: workspace, ref: "refs/heads/hello-candidate" }) }),
      provider: Object.freeze({ key: "dsh-headless", configuration: Object.freeze({ providerIdentity: "dsh-headless", workspaceDirectory: workspace, sessionStorageDirectory: path.join(root, "sessions"), credentialStore: Object.freeze({ path: credentialPath, watch: false }), maxParallelToolCalls: 1 }) }),
      invocation: Object.freeze({ journalDirectory: path.join(root, "journals") }),
      host: Object.freeze({ engine: "langgraph", checkpointDirectory: path.join(root, "checkpoints") }),
      implementationIdentity: "implementation.runner.langgraph-dsh",
    }) satisfies RunnerFactoryConfig;
    const factory = new RunnerFactory();
    const adapter = await factory.create(config, Object.freeze({
      interaction: Object.freeze({ async publish() { return { ok: true as const, value: undefined }; }, async requestInput() { throw new Error("not used"); } }),
      workflow: Object.freeze({ async request() { throw new Error("not used"); } }),
      observation: Object.freeze({ async observe() {} }),
      startCorrelation: Object.freeze({ async acknowledge() { return { ok: true as const, value: undefined }; } }),
      hostOperations: Object.freeze({}),
    }));
    try {
      await expect(adapter.execute({ interfaceVersion: EXECUTION_RUNTIME_ADAPTER_VERSION, activation })).resolves.toMatchObject({
        ok: true, value: { kind: "terminal", outcome: "COMPLETED" },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("Greet Codex");
      expect(requests[0]).not.toMatch(/workspace_repo|workspace_git|synthetic-secret/);
    } finally {
      await factory.dispose(adapter);
    }
  }, 20_000);
});
