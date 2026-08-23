import { cp, readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { DeliveryConfigProjection } from "../../src/configuration/index.js";
import { compileRunnerActivation } from "../../src/interpreter/compile-runner-activation.js";
import {
  captureTaskPromptSnapshot,
  createDeliveryManifest,
  DeliveryAdmissionProjector,
} from "../../src/delivery/index.js";

const repositoryRoot = path.dirname(fileURLToPath(new URL("../..", import.meta.url)));

function projection(baseUrl = "https://api.example.test"): DeliveryConfigProjection {
  return Object.freeze({
    identity: `sha256:${"a".repeat(64)}`,
    value: Object.freeze({
      schemaVersion: "execution.delivery-config@1.0.0",
      paths: Object.freeze({ repositoryRoot, workspaceRoot: repositoryRoot, allowedWorktreeRoots: Object.freeze([repositoryRoot]), runnerResources: Object.freeze({ journal: "runner/journal", checkpoints: "runner/checkpoints", sessions: "runner/sessions", custody: "runner/custody" }) }),
      runner: Object.freeze({ implementationKey: "runner.v1", host: Object.freeze({ engine: "langgraph" }), provider: Object.freeze({ key: "dsh", route: "deepseek", modelId: "deepseek-chat", baseUrl, credentialRef: "PROVIDER_KEY", maxParallelToolCalls: 1 }) }),
      controls: Object.freeze({ executionTimeoutMs: 60_000, maxConcurrentDeliveries: 2, allowExplicitRefresh: false }),
    }),
  }) as unknown as DeliveryConfigProjection;
}

describe("frozen Delivery Admission 1.0.0 production projection", () => {
  it.each([
    ["implementation", path.join(repositoryRoot, "workflow-package", "implementation", "definition")],
    ["system-design", path.join(repositoryRoot, "workflow-package", "system-design", "definition")],
    ["contributed", path.join(repositoryRoot, "system-contracts", "workflow-dsl", "examples", "minimal")],
  ])("projects the exact %s Package and persisted Manifest without raw admission inputs", async (name, definition) => {
    const packageDocument = JSON.parse(await readFile(path.join(definition, "package.json"), "utf8"));
    const workflowDocument = JSON.parse(await readFile(path.join(definition, "workflow.json"), "utf8"));
    const snapshotDocument = JSON.parse(await readFile(path.join(definition, "snapshot.json"), "utf8"));
    const root = await mkdtemp(path.join(tmpdir(), "delivery-projector-"));
    const snapshot = await captureTaskPromptSnapshot({
      root: path.join(root, "snapshots"),
      deliveryId: `delivery-${name}`,
      prompt: Object.freeze({ text: "execute the admitted task", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }),
    });
    const manifest = createDeliveryManifest({
      deliveryId: `delivery-${name}`,
      taskId: `task-${name}`,
      createdAt: 1,
      canonicalWorktree: repositoryRoot,
      resolvedPackage: Object.freeze({
        name: packageDocument.package.name,
        exactVersion: packageDocument.package.version,
        packageDigest: packageDocument.package.digest,
        localPath: definition,
        workflowId: workflowDocument.workflow.id,
      }),
      promptSnapshot: snapshot,
      deliveryConfigProjection: projection(),
    });

    const activation = await new DeliveryAdmissionProjector().project(manifest);
    expect(Object.isFrozen(activation)).toBe(true);
    expect(Object.isFrozen(activation.program.execution.agents)).toBe(true);
    expect(activation).toMatchObject({
      schemaVersion: "runner.activation@1.0.0",
      correlation: {
        deliveryIdentity: `delivery-${name}`,
        taskIdentity: `task-${name}`,
        manifestBindingIdentity: manifest.deliveryBindingIdentity,
        packageDigest: packageDocument.package.digest,
        snapshotIdentity: snapshotDocument.snapshot.id,
        snapshotDigest: snapshotDocument.snapshot.digest,
      },
      admission: { deliveryAdmissionContractIdentity: "agentops.delivery-admission@1.0.0" },
    });
    expect(compileRunnerActivation(activation).ok).toBe(true);
    const serialized = JSON.stringify(activation);
    expect(serialized).not.toMatch(/"contentRef"|"workflowSource"|"packageStore"|"credentialStore"|"nativeSession"|"checkpointIdentity"/);
    expect(serialized).not.toContain('"schemaVersion":"agentops.workflow-dsl@1.1.0","package"');
  });

  it("binds the admitted entry input using only its declared JSON field formats", async () => {
    const source = path.join(repositoryRoot, "system-contracts", "workflow-dsl", "examples", "minimal");
    const root = await mkdtemp(path.join(tmpdir(), "delivery-projector-formats-"));
    const definition = path.join(root, "definition");
    await cp(source, definition, { recursive: true });
    const actionsPath = path.join(definition, "actions.json");
    const actionsDocument = JSON.parse(await readFile(actionsPath, "utf8"));
    actionsDocument.actions[0].inputSchema = {
      type: "object",
      properties: {
        request: { type: "string" },
        repository: { type: "string" },
        label: { type: "string" },
        accepted: { type: "boolean" },
        count: { type: "integer" },
        items: { type: "array" },
        metadata: { type: "object" },
      },
      required: ["request", "repository", "label", "accepted", "count", "items", "metadata"],
    };
    await writeFile(actionsPath, `${JSON.stringify(actionsDocument, null, 2)}\n`, "utf8");

    const packageDocument = JSON.parse(await readFile(path.join(definition, "package.json"), "utf8"));
    const workflowDocument = JSON.parse(await readFile(path.join(definition, "workflow.json"), "utf8"));
    const promptSnapshot = await captureTaskPromptSnapshot({
      root: path.join(root, "snapshots"),
      deliveryId: "delivery-formats",
      prompt: Object.freeze({ text: "format-only prompt", attachments: Object.freeze([]) }),
      attachments: Object.freeze({ read: async () => { throw new Error("not called"); } }),
    });
    const manifest = createDeliveryManifest({
      deliveryId: "delivery-formats",
      taskId: "task-formats",
      createdAt: 1,
      canonicalWorktree: repositoryRoot,
      resolvedPackage: Object.freeze({
        name: packageDocument.package.name,
        exactVersion: packageDocument.package.version,
        packageDigest: packageDocument.package.digest,
        localPath: definition,
        workflowId: workflowDocument.workflow.id,
      }),
      promptSnapshot,
      deliveryConfigProjection: projection(),
    });

    const activation = await new DeliveryAdmissionProjector().project(manifest);
    expect(activation.initial.state.values.__deliveryTaskPrompt).toEqual({
      request: "format-only prompt",
      repository: repositoryRoot,
      label: "",
      accepted: false,
      count: 0,
      items: [],
      metadata: {},
    });
    expect(compileRunnerActivation(activation).ok).toBe(true);
  });
});
