import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  AgentProviderFactoryRegistry,
  CodexCliProviderRealmFactory,
  type CodexCliProviderConfiguration,
} from "../../../src/index.js";
import type {
  AgentProviderDeliveryRealmRequest,
  NativeTurnEvent,
} from "../../../src/providers/provider.js";

const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

type Scenario = "success" | "refused" | "hang" | "start-unknown" | "result-unknown" | "protocol-anomaly" | "crash" | "invalid-result" | "oversized-result" | "resume-mismatch";

async function fixture(scenario: Scenario, overrides: Partial<{ version: string; login: boolean; models: readonly string[] }> = {}) {
  const root = await mkdtemp(join(tmpdir(), "wsr-codex-provider-"));
  const worktreeCandidate = join(root, "worktree");
  const state = join(root, "state");
  await mkdir(worktreeCandidate);
  const worktree = await realpath(worktreeCandidate);
  await mkdir(state);
  const instructions = "Perform the admitted action and return only its typed result.";
  const instructionPath = join(root, "instructions.md");
  await writeFile(instructionPath, instructions);
  const executable = join(root, "codex-fixture");
  const capture = join(root, "capture.json");
  const killed = join(root, "killed.log");
  const version = overrides.version ?? "0.144.5";
  const login = overrides.login ?? true;
  const models = overrides.models ?? ["gpt-5.6-sol"];
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const scenario = ${JSON.stringify(scenario)};
const capture = ${JSON.stringify(capture)};
const killed = ${JSON.stringify(killed)};
if (process.argv.includes("--version")) { console.log("codex-cli ${version}"); process.exit(0); }
if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(${login ? 0 : 1});
if (process.argv[2] === "debug" && process.argv[3] === "models") { console.log(JSON.stringify({ models: ${JSON.stringify(models)}.map(slug => ({ slug })) })); process.exit(0); }
if (process.argv[2] === "exec" && process.argv[3] === "resume" && process.argv.includes("--help")) { console.log("--json --model --config --ignore-user-config --output-schema --output-last-message"); process.exit(0); }
if (process.argv[2] === "exec" && process.argv.includes("--help")) { console.log("--sandbox --json --model --config --ignore-user-config --output-schema --output-last-message --cd"); process.exit(0); }
if (process.argv[2] !== "exec") process.exit(90);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  const schemaIndex = process.argv.indexOf("--output-schema");
  fs.writeFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input, schema: JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1], "utf8")), secretVisible: process.env.WSR_TEST_SECRET !== undefined }));
  process.on("SIGTERM", () => { fs.appendFileSync(killed, String(process.pid) + "\\n"); process.exit(143); });
  if (scenario === "hang") { setInterval(() => {}, 1000); return; }
  if (scenario === "refused") { process.stderr.write("request refused"); process.exit(7); }
  if (scenario === "start-unknown") process.exit(0);
  const resumed = process.argv[3] === "resume";
  const threadId = scenario === "resume-mismatch" && resumed ? "019c0000-0000-7000-8000-000000000002" : "019c0000-0000-7000-8000-000000000001";
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  if (scenario === "crash") { process.stderr.write("process crashed"); process.exit(9); }
  if (scenario === "result-unknown") { console.log(JSON.stringify({ type: "turn.completed", usage: {} })); process.exit(0); }
  if (scenario === "protocol-anomaly") { console.log(JSON.stringify({ type: "unexpected.event" })); process.exit(0); }
  fs.writeFileSync(process.argv[outputIndex + 1], scenario === "invalid-result" ? "not-json" : JSON.stringify({ accepted: true, cwd: scenario === "oversized-result" ? "x".repeat(4 * 1024 * 1024 + 1) : process.cwd() }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
});
`);
  await chmod(executable, 0o755);
  const configuration: CodexCliProviderConfiguration = Object.freeze({
    executablePath: executable,
    requiredVersion: "0.144.5",
    stateDirectory: state,
    startupTimeoutMs: 10_000,
    executionTimeoutMs: 5_000,
    shutdownTimeoutMs: 100,
  });
  const request: AgentProviderDeliveryRealmRequest = Object.freeze({
    schemaVersion: "execution.agent-provider-delivery-realm-request@2.0.0",
    deliveryId: "delivery-85",
    manifestBindingIdentity: `sha256:${"a".repeat(64)}`,
    canonicalWorktree: worktree,
    providerIdentity: "provider.codex",
    providerVersion: "0.144.5",
    providerDescriptorDigest: `sha256:${"b".repeat(64)}`,
    maxParallelToolCalls: 2,
    roleBindings: Object.freeze([
      Object.freeze({ roleId: "role.reviewer", modelProviderId: "openai", modelId: "gpt-5.6-sol" }),
    ]),
  });
  function dispatch(options: Partial<{ model: string; tools: unknown[]; workspace: "none" | "read" | "write" }> = {}) {
    const workspace = options.workspace ?? "read";
    return Object.freeze({
      action: Object.freeze({ identity: "action.review", purpose: "Review the implementation", resultSchema: Object.freeze({ type: "object", properties: Object.freeze({ accepted: Object.freeze({ type: "boolean" }), cwd: Object.freeze({ type: "string" }) }), required: Object.freeze(["accepted", "cwd"]), additionalProperties: false }) }),
      executor: Object.freeze({
        session: Object.freeze({
          roleIdentity: "role.reviewer",
          model: Object.freeze({ providerModelIdentity: options.model ?? "gpt-5.6-sol", configuration: Object.freeze({ reasoningEffort: "medium" }) }),
          driver: Object.freeze({ providerIdentity: "codex-cli", configuration: Object.freeze({ approvalPolicy: "never", sandbox: workspace === "write" ? "workspace-write" : "read-only" }) }),
          instructions: Object.freeze({ localReadOnlyPath: instructionPath, contentIdentity: sha(instructions) }),
          tools: Object.freeze(options.tools ?? []),
          providedCapabilities: Object.freeze(["structured-completion"]),
        }),
        turn: Object.freeze({ access: workspace === "none" ? Object.freeze([]) : Object.freeze([{ mode: workspace, path: "." }]) }),
      }),
      input: Object.freeze({ objective: "Return a typed review" }),
      workspace: Object.freeze({ kind: workspace }),
    }) as never;
  }
  return { root, worktree, state, executable, capture, killed, configuration, request, dispatch };
}

async function acquire(value: Awaited<ReturnType<typeof fixture>>) {
  return new CodexCliProviderRealmFactory(value.configuration).acquire(value.request);
}

describe("Codex CLI Agent Provider", () => {
  it("registers the production factory through the frozen Delivery registry contract", async () => {
    const value = await fixture("success");
    const factory = new CodexCliProviderRealmFactory(value.configuration);

    const registry = new AgentProviderFactoryRegistry([factory]);

    expect(registry.admit({ identity: "provider.codex", version: "0.144.5" }, ["structured-completion"]))
      .toMatchObject({ identity: "provider.codex", version: "0.144.5", adapterKey: "codex-cli" });
  });

  it("pins the qualified Codex CLI payload as an exact production dependency", async () => {
    const packageDocument = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(packageDocument.dependencies?.["@openai/codex"]).toBe("0.144.5");
  });

  it("publishes the exact frozen factory descriptor and acquires a credential-free Delivery realm", async () => {
    const value = await fixture("success");
    const factory = new CodexCliProviderRealmFactory(value.configuration);

    expect(factory.descriptor).toEqual({
      schemaVersion: "execution.agent-provider-factory@1.0.0",
      identity: "provider.codex",
      version: "0.144.5",
      adapterKey: "codex-cli",
      capabilities: ["structured-completion"],
    });
    expect(Object.isFrozen(factory.descriptor)).toBe(true);
    const lease = await factory.acquire(value.request);
    expect(lease.adapter.key).toBe("codex-cli");
    expect(lease.adapter).not.toHaveProperty("credentials");
    await lease.dispose();
  });

  it("rejects inexact configuration, realm authority, executable, and canonical-worktree admission", async () => {
    const value = await fixture("success");
    expect(() => new CodexCliProviderRealmFactory({ ...value.configuration, requiredVersion: "0.145.0" as never }))
      .toThrowError(expect.objectContaining({ code: "CODEX_CONFIGURATION_INVALID" }));
    expect(() => new CodexCliProviderRealmFactory({ ...value.configuration, extra: true } as never))
      .toThrowError(expect.objectContaining({ code: "CODEX_CONFIGURATION_INVALID" }));
    await expect(new CodexCliProviderRealmFactory(value.configuration).acquire({ ...value.request, providerIdentity: "provider.other" }))
      .rejects.toMatchObject({ code: "CODEX_ADMISSION_FAILED" });
    await expect(new CodexCliProviderRealmFactory({ ...value.configuration, executablePath: join(value.root, "missing") }).acquire(value.request))
      .rejects.toMatchObject({ code: "CODEX_ADMISSION_FAILED" });
    await expect(new CodexCliProviderRealmFactory(value.configuration).acquire({ ...value.request, canonicalWorktree: join(value.root, "missing") }))
      .rejects.toMatchObject({ code: "CODEX_ADMISSION_FAILED" });
  });

  it.each([
    ["version", { version: "0.145.0" }],
    ["login", { login: false }],
    ["model", { models: ["gpt-other"] }],
  ] as const)("fails closed when exact %s admission is unavailable", async (_kind, overrides) => {
    const value = await fixture("success", overrides);
    await expect(acquire(value)).rejects.toMatchObject({ code: "CODEX_ADMISSION_FAILED" });
  });

  it("runs exact JSONL typed output in the canonical worktree with frozen model, sandbox, approval, and Action scope", async () => {
    const value = await fixture("success");
    const lease = await acquire(value);
    const session = await lease.adapter.sessions.open({ dispatch: value.dispatch(), signal: new AbortController().signal });
    process.env.WSR_TEST_SECRET = "must-not-reach-codex";
    let events;
    try {
      events = await session.run({ objective: "Return a typed review" });
      await session.persist();
    } finally {
      delete process.env.WSR_TEST_SECRET;
    }

    expect(events).toEqual([
      { kind: "output", content: { accepted: true, cwd: value.worktree } },
      { kind: "structured-completion", result: { accepted: true, cwd: value.worktree } },
    ]);
    const capture = JSON.parse(await readFile(value.capture, "utf8"));
    expect(capture.cwd).toBe(value.worktree);
    expect(capture.argv).toEqual(expect.arrayContaining([
      "--json", "--ignore-user-config", "--model", "gpt-5.6-sol", "--sandbox", "read-only",
      "--config", "approval_policy=\"never\"", "--config", "model_reasoning_effort=\"medium\"",
      "--config", "shell_environment_policy.inherit=\"none\"",
      "--cd", value.worktree,
    ]));
    expect(capture.secretVisible).toBe(false);
    expect(capture.input).toContain("action.review");
    expect(capture.input).toContain("role.reviewer");
    expect(capture.input).toContain("Return a typed review");
    expect(capture.schema).toEqual((value.dispatch() as { action: { resultSchema: unknown } }).action.resultSchema);
    await lease.dispose();
  });

  it("closes admitted inline object schemas for Codex structured output without changing the admitted result contract", async () => {
    const value = await fixture("success");
    const dispatch = structuredClone(value.dispatch()) as any;
    delete dispatch.action.resultSchema.additionalProperties;
    dispatch.action.resultSchema.properties.review = {
      type: "object",
      properties: {
        reviewed: { type: "boolean" },
        findings: {
          type: "array",
          items: {
            allOf: [
              { type: "object", properties: { message: { type: "string" } } },
              { not: { type: "object", properties: { ignored: { type: "boolean" } } } },
            ],
          },
        },
        verdict: {
          anyOf: [
            { type: "object", properties: { accepted: { type: "boolean" } } },
            { oneOf: [{ type: "string" }, { type: "null" }] },
          ],
        },
      },
      required: ["reviewed"],
    };
    const lease = await acquire(value);
    const session = await lease.adapter.sessions.open({ dispatch, signal: new AbortController().signal });

    await session.run({ objective: "Return a typed review" });

    const capture = JSON.parse(await readFile(value.capture, "utf8"));
    expect(capture.schema.additionalProperties).toBe(false);
    expect(capture.schema.properties.review.additionalProperties).toBe(false);
    expect(capture.schema.properties.review.properties.findings.items.allOf[0].additionalProperties).toBe(false);
    expect(capture.schema.properties.review.properties.findings.items.allOf[1].not.additionalProperties).toBe(false);
    expect(capture.schema.properties.review.properties.verdict.anyOf[0].additionalProperties).toBe(false);
    expect(capture.schema.properties.review.properties.verdict.anyOf[1].oneOf).toEqual([
      { type: "string" },
      { type: "null" },
    ]);
    expect(dispatch.action.resultSchema).not.toHaveProperty("additionalProperties");
    await lease.dispose();
  });

  it("refuses unprojectable tools and bindings without invoking a fallback Provider", async () => {
    const value = await fixture("success");
    const lease = await acquire(value);
    await expect(lease.adapter.sessions.open({ dispatch: value.dispatch({ tools: [{ resourceIdentity: "tool.ambient" }] }), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "CODEX_BINDING_REJECTED" });
    await expect(lease.adapter.sessions.open({ dispatch: value.dispatch({ model: "gpt-other" }), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "CODEX_BINDING_REJECTED" });
    const narrowScope = structuredClone(value.dispatch({ workspace: "write" })) as any;
    narrowScope.executor.turn.access = [{ mode: "write", path: "src/**" }];
    await expect(lease.adapter.sessions.open({ dispatch: narrowScope, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "CODEX_BINDING_REJECTED" });
    await lease.dispose();
  });

  it.each([
    ["refused", "provider-failed", "PROVIDER_EXITED"],
    ["crash", "provider-failed", "PROVIDER_EXITED"],
    ["start-unknown", "provider-uncertain", undefined],
    ["result-unknown", "provider-uncertain", undefined],
    ["invalid-result", "provider-uncertain", undefined],
    ["oversized-result", "provider-uncertain", undefined],
    ["protocol-anomaly", "provider-uncertain", undefined],
  ] as const)("classifies %s without treating it as a typed completion", async (scenario, kind, code) => {
    const value = await fixture(scenario);
    const lease = await acquire(value);
    const session = await lease.adapter.sessions.open({ dispatch: value.dispatch(), signal: new AbortController().signal });

    const events = await session.run({ objective: scenario });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind, ...(code === undefined ? {} : { code }) });
    expect(events.some((event: NativeTurnEvent) => event.kind === "structured-completion")).toBe(false);
    await lease.dispose();
  });

  it("classifies execution timeout and caller cancellation, terminating the child process", async () => {
    const timed = await fixture("hang");
    const timedLease = await new CodexCliProviderRealmFactory({ ...timed.configuration, executionTimeoutMs: 30 }).acquire(timed.request);
    const timedSession = await timedLease.adapter.sessions.open({ dispatch: timed.dispatch(), signal: new AbortController().signal });
    await expect(timedSession.run({ objective: "timeout" })).resolves.toEqual([
      expect.objectContaining({ kind: "provider-failed", code: "PROVIDER_TIMED_OUT" }),
    ]);
    await timedLease.dispose();

    const cancelled = await fixture("hang");
    const cancelledLease = await acquire(cancelled);
    const controller = new AbortController();
    const cancelledSession = await cancelledLease.adapter.sessions.open({ dispatch: cancelled.dispatch(), signal: controller.signal });
    const running = cancelledSession.run({ objective: "cancel" });
    setTimeout(() => controller.abort(), 20);
    await expect(running).resolves.toEqual([
      expect.objectContaining({ kind: "provider-failed", code: "PROVIDER_CANCELLED" }),
    ]);
    await cancelledLease.dispose();

    const preCancelled = await fixture("success");
    const preCancelledLease = await acquire(preCancelled);
    const preCancelledController = new AbortController();
    preCancelledController.abort();
    const preCancelledSession = await preCancelledLease.adapter.sessions.open({ dispatch: preCancelled.dispatch(), signal: preCancelledController.signal });
    await expect(preCancelledSession.run({ objective: "must not spawn" })).resolves.toEqual([
      expect.objectContaining({ kind: "provider-failed", code: "PROVIDER_CANCELLED" }),
    ]);
    await preCancelledLease.dispose();
  });

  it("restores only a compatible persisted Codex identity and uses exact CLI resume", async () => {
    const value = await fixture("success");
    const lease = await acquire(value);
    const first = await lease.adapter.sessions.open({ dispatch: value.dispatch(), signal: new AbortController().signal });
    await first.run({ objective: "first" });
    await first.persist();
    const restored = await lease.adapter.sessions.restore({ opaqueIdentity: first.opaqueIdentity, dispatch: value.dispatch(), signal: new AbortController().signal });
    await restored.run({ objective: "second" });
    const capture = JSON.parse(await readFile(value.capture, "utf8"));
    expect(capture.argv.slice(0, 3)).toEqual(["exec", "resume", "019c0000-0000-7000-8000-000000000001"]);
    await expect(lease.adapter.sessions.restore({ opaqueIdentity: first.opaqueIdentity, dispatch: value.dispatch({ workspace: "write" }), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "CODEX_RESUME_INCOMPATIBLE" });
    await expect(lease.adapter.sessions.restore({ opaqueIdentity: "codex:missing", dispatch: value.dispatch(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "CODEX_RESUME_INCOMPATIBLE" });
    const [deliveryState] = await readdir(value.state);
    const stateDirectory = join(value.state, deliveryState!);
    const [recordName] = (await readdir(stateDirectory)).filter((name) => name.endsWith(".json"));
    const recordPath = join(stateDirectory, recordName!);
    const corrupt = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, JSON.stringify({ ...corrupt, schemaVersion: "unknown" }));
    await expect(lease.adapter.sessions.restore({ opaqueIdentity: first.opaqueIdentity, dispatch: value.dispatch(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "CODEX_RESUME_INCOMPATIBLE" });
    await lease.dispose();
    await expect(first.persist()).rejects.toMatchObject({ code: "CODEX_SESSION_DISPOSED" });
    await expect(lease.adapter.sessions.open({ dispatch: value.dispatch(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "CODEX_SESSION_DISPOSED" });
  });

  it("marks a resume that reports a different native thread identity uncertain", async () => {
    const value = await fixture("resume-mismatch");
    const lease = await acquire(value);
    const first = await lease.adapter.sessions.open({ dispatch: value.dispatch(), signal: new AbortController().signal });
    await first.run({ objective: "first" });
    const restored = await lease.adapter.sessions.restore({ opaqueIdentity: first.opaqueIdentity, dispatch: value.dispatch(), signal: new AbortController().signal });
    await expect(restored.run({ objective: "second" })).resolves.toEqual([
      expect.objectContaining({ kind: "provider-uncertain", phase: "result" }),
    ]);
    await lease.dispose();
  });

  it("Delivery teardown terminates all live Codex processes without crossing into another realm", async () => {
    const left = await fixture("hang");
    const right = await fixture("hang");
    const leftLease = await acquire(left);
    const rightLease = await acquire(right);
    const leftSession = await leftLease.adapter.sessions.open({ dispatch: left.dispatch(), signal: new AbortController().signal });
    const rightSession = await rightLease.adapter.sessions.open({ dispatch: right.dispatch(), signal: new AbortController().signal });
    const leftRun = leftSession.run({ objective: "left" });
    const rightRun = rightSession.run({ objective: "right" });
    await expect.poll(() => readFile(left.capture, "utf8").then(() => true, () => false)).toBe(true);
    await expect.poll(() => readFile(right.capture, "utf8").then(() => true, () => false)).toBe(true);

    await leftLease.dispose();
    await leftRun;
    expect((await readFile(left.killed, "utf8")).trim()).not.toBe("");
    await expect(readFile(right.killed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rightLease.dispose();
    await rightRun;
    expect((await readFile(right.killed, "utf8")).trim()).not.toBe("");
  }, 15_000);
});
