import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { IntakeSessionBindingRepository } from "./binding-repository.js";
import { parseWsrCommand } from "./command.js";

export const name = "workflow-execution";
export const inject = ["commands", "tools", "attachments", "agents"];

function profile(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)
    || Object.keys(candidate).sort().join(",") !== "bindingFile,configFile"
    || typeof candidate.configFile !== "string" || !path.isAbsolute(candidate.configFile)
    || typeof candidate.bindingFile !== "string" || !path.isAbsolute(candidate.bindingFile)) {
    throw new TypeError("DSH_INTAKE_CONFIG_INVALID");
  }
  return Object.freeze({ configFile: path.resolve(candidate.configFile), bindingFile: path.resolve(candidate.bindingFile) });
}

function defaultDependencies(attachmentBytes, present) {
  return Object.freeze({
    clock: Object.freeze({ now: () => Date.now() }),
    ids: Object.freeze({ create: () => `delivery-${randomUUID()}` }),
    filesystem: Object.freeze({
      read: async (file, maxBytes) => {
        const bytes = Uint8Array.from(await readFile(file));
        if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new TypeError("FILESYSTEM_READ_BOUND_EXCEEDED");
        return bytes;
      },
      writeImmutable: async (file, bytes) => writeFile(file, bytes, { flag: "wx", mode: 0o600 }),
      list: async (directory) => Object.freeze(await readdir(directory)),
      inspect: async (file) => {
        try {
          const value = await stat(file);
          return Object.freeze({ kind: value.isFile() ? "file" : value.isDirectory() ? "directory" : "missing" });
        } catch (cause) {
          if (cause?.code === "ENOENT") return Object.freeze({ kind: "missing" });
          throw cause;
        }
      },
    }),
    network: Object.freeze({ request: async (url) => {
      const response = await fetch(url);
      return Object.freeze({ status: response.status, body: new Uint8Array(await response.arrayBuffer()) });
    } }),
    intake: Object.freeze({ publish: present }),
    attachments: Object.freeze({ read: async (contentRef) => {
      const bytes = attachmentBytes.get(contentRef);
      if (bytes === undefined) throw new TypeError("ATTACHMENT_REFERENCE_UNAVAILABLE");
      return Uint8Array.from(bytes);
    } }),
  });
}

function error(code) {
  return Object.freeze({ kind: "ERROR", code, message: code });
}

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

function turnFromAgent(agent) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
  const event = [...events].reverse().find((candidate) => candidate?.type === "user/message" && candidate?.data?.message?.source?.kind === "user");
  const message = event?.data?.message;
  return Object.freeze({ text: textOf(message?.content), images: Object.freeze((message?.content ?? []).filter((block) => block?.type === "image")) });
}

export function presentToDshSession(agent, text, createId = () => `cmd-workflow-execution-${randomUUID()}`) {
  if (agent === null || typeof agent !== "object" || typeof agent.session?.append !== "function"
    || typeof text !== "string" || text.length === 0 || typeof createId !== "function") {
    throw new TypeError("DSH_INTAKE_PRESENTATION_INVALID");
  }
  const commandId = createId();
  agent.session.append("command/run", {
    commandId,
    name: "wsr",
    source: { kind: "plugin", plugin: "workflow-execution" },
  });
  agent.session.append("command/done", { commandId, kind: "success", text });
}

export async function createPluginRuntime(config, options = {}) {
  const admitted = profile(config);
  const api = await (options.moduleLoader?.() ?? import("@workflow-self-recursive/execution-system"));
  const attachmentBytes = new Map();
  const bindings = options.bindings ?? new IntakeSessionBindingRepository(admitted.bindingFile);
  await bindings.start();
  const sessionByCorrelation = new Map();
  const present = async (message) => {
    const sessionKey = sessionByCorrelation.get(message.correlation);
    if (sessionKey !== undefined) await options.present?.(Object.freeze({ sessionKey, text: message.text }));
  };
  const dependencies = options.dependencies ?? defaultDependencies(attachmentBytes, present);
  const factory = options.factory ?? new api.DefaultExecutionApplicationFactory();
  const application = await factory.create(admitted.configFile, dependencies);
  const control = options.control ?? api.getExecutionApplicationControl(application);
  const inventory = await control.list();
  for (const binding of await bindings.list()) {
    const matches = inventory.filter((item) => item.deliveryId === binding.deliveryId && item.worktree === binding.worktree);
    if (matches.length !== 1) throw Object.assign(new Error("INTAKE_BINDING_INVARIANT_VIOLATION"), { code: "INTAKE_BINDING_INVARIANT_VIOLATION" });
    if (options.sessionAvailable !== undefined && !await options.sessionAvailable(binding.sessionKey)) {
      await bindings.markDetached(binding.deliveryId);
      continue;
    }
    control.attach(binding.deliveryId, binding.correlation);
    sessionByCorrelation.set(binding.correlation, binding.sessionKey);
  }
  await application.start();
  const service = new api.WorkflowIntakeService(Object.freeze({ application, control }));
  const active = new Set();
  let accepting = true;

  async function captureImages(images, attachmentStore, signal) {
    const captured = [];
    for (const block of images ?? []) {
      const stored = await attachmentStore.readImage(block.attachment, signal);
      const bytes = Uint8Array.from(stored.data);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const contentRef = `intake-attachment-${randomUUID()}`;
      attachmentBytes.set(contentRef, bytes);
      captured.push(Object.freeze({ identity: `attachment-${randomUUID()}`, filename: stored.ref.name ?? "attachment", mediaType: stored.ref.mediaType, byteLength: bytes.byteLength, digest, contentRef }));
    }
    return Object.freeze(captured);
  }

  function track(promise) {
    active.add(promise);
    void promise.finally(() => active.delete(promise)).catch(() => undefined);
    return promise;
  }

  async function invokeForSession(input) {
    if (!accepting) return error("APPLICATION_CLOSING");
    const worktree = await realpath(input.worktree);
    const candidateBinding = await bindings.bySession(input.sessionKey);
    const existing = candidateBinding?.state === "BOUND" ? candidateBinding : undefined;
    const correlation = existing?.correlation ?? `intake-${randomUUID()}`;
    const attachments = await captureImages(input.images ?? [], input.attachmentStore, input.signal);
    const turn = Object.freeze({ text: input.turnText ?? "", attachments });
    const operation = input.operation;
    if (operation.operation === "create") {
      if (candidateBinding !== undefined) return error("INTAKE_BINDING_INVARIANT_VIOLATION");
      sessionByCorrelation.set(correlation, input.sessionKey);
      const execution = track(service.invoke(Object.freeze({ operation: "create", selector: operation.selector, worktree, directive: operation.directive, turn, correlation })));
      const first = await Promise.race([
        execution.then((result) => Object.freeze({ kind: "result", result })),
        control.waitForDelivery(correlation, options.deliveryRegistrationTimeoutMs ?? 10_000)
          .then((delivery) => Object.freeze({ kind: "delivery", delivery })),
      ]);
      if (first.kind === "result") {
        if (first.result.kind === "ERROR" || first.result.kind === "TERMINAL" || first.result.kind === "RECOVERY") sessionByCorrelation.delete(correlation);
        return first.result;
      }
      const delivery = first.delivery;
      if (delivery === undefined) {
        const result = await execution;
        if (result.kind === "ERROR" || result.kind === "TERMINAL") sessionByCorrelation.delete(correlation);
        return result;
      }
      await bindings.claim(Object.freeze({ sessionKey: input.sessionKey, correlation, deliveryId: delivery.deliveryId, worktree: delivery.worktree }));
      void execution.then(async (result) => {
        try { await options.present?.(Object.freeze({ sessionKey: input.sessionKey, text: api.renderIntakeResult(result, 4096) })); }
        catch { /* presentation is not Delivery control */ }
        if (result.kind === "TERMINAL" || result.kind === "ERROR") {
          await bindings.detach(delivery.deliveryId);
          sessionByCorrelation.delete(correlation);
        }
      }).catch(() => undefined);
      return Object.freeze({ kind: "START_UNCERTAIN", worktree: delivery.worktree, deliveryId: delivery.deliveryId });
    }
    if (operation.operation === "list") return service.invoke(Object.freeze({ operation: "list", correlation }));
    if (operation.operation === "recover") {
      if (existing !== undefined) return error("INTAKE_BINDING_INVARIANT_VIOLATION");
      const recoverable = (await control.list()).filter((item) => operation.deliveryId === undefined
        ? item.worktree === worktree
        : item.deliveryId === operation.deliveryId);
      if (recoverable.length === 1) {
        const claimed = await bindings.byDelivery(recoverable[0].deliveryId);
        if (claimed?.state === "BOUND") return error("DELIVERY_INTAKE_BOUND");
      }
      const result = await service.invoke(Object.freeze({ operation: "recover", worktree, ...(operation.deliveryId === undefined ? {} : { deliveryId: operation.deliveryId }), correlation }));
      if (result.kind === "RECOVERY") {
        await bindings.claim(Object.freeze({ sessionKey: input.sessionKey, correlation, deliveryId: result.deliveryId, worktree: result.worktree }));
        sessionByCorrelation.set(correlation, input.sessionKey);
      }
      return result;
    }
    if (operation.operation === "status") {
      const deliveryId = operation.deliveryId ?? existing?.deliveryId;
      return service.invoke(Object.freeze({ operation: "status", worktree, ...(deliveryId === undefined ? {} : { deliveryId }), correlation }));
    }
    if (operation.operation === "action-finish") {
      if (existing === undefined) return error("DELIVERY_UNKNOWN");
      return service.invoke(Object.freeze({ operation: "action-finish", ...(operation.remainder === undefined && attachments.length === 0 ? {} : { turn: Object.freeze({ text: operation.remainder ?? "", attachments }) }), correlation: existing.correlation }));
    }
    const result = await service.invoke(Object.freeze({ operation: "abandon", deliveryId: operation.deliveryId, correlation }));
    if (result.kind === "TERMINAL") {
      const detached = await bindings.byDelivery(operation.deliveryId);
      await bindings.detach(operation.deliveryId);
      if (detached !== undefined) sessionByCorrelation.delete(detached.correlation);
    }
    return result;
  }

  async function answerForSession(input) {
    if (!accepting) return error("APPLICATION_CLOSING");
    const binding = await bindings.bySession(input.sessionKey);
    if (binding === undefined) return error("DELIVERY_UNKNOWN");
    const attachments = await captureImages(input.images ?? [], input.attachmentStore, input.signal);
    return control.answerAction(Object.freeze({ correlation: binding.correlation, prompt: Object.freeze({ text: input.text, attachments }) }));
  }

  return Object.freeze({ application, service, control, bindings, invokeForSession, answerForSession,
    async close() {
      if (!accepting) return;
      accepting = false;
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise((resolve) => setTimeout(resolve, options.quiesceTimeoutMs ?? 10_000)),
      ]);
      await application.close();
      attachmentBytes.clear();
    },
  });
}

function commandTurn(rawInput) {
  const normalized = rawInput.startsWith(" ") ? rawInput.slice(1) : rawInput;
  return `/wsr ${normalized}`;
}

export function mapIntakeToolOperation(args) {
  const operationNames = ["list", "create", "recover", "status", "action-finish", "abandon"];
  if (args === null || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some((key) => !["operation", "selector", "deliveryId"].includes(key))
    || !operationNames.includes(args.operation)
    || (args.operation === "create") !== (typeof args.selector === "string" && args.selector.length > 0)
    || (args.operation === "abandon" && (typeof args.deliveryId !== "string" || args.deliveryId.length === 0))
    || (!["recover", "status", "abandon"].includes(args.operation) && args.deliveryId !== undefined)) {
    throw new TypeError("INTAKE_OPERATION_INVALID");
  }
  return Object.freeze({ operation: args.operation, ...(args.selector === undefined ? {} : { selector: args.selector }), ...(args.deliveryId === undefined ? {} : { deliveryId: args.deliveryId }), ...(args.operation === "create" ? { directive: "/workflow-execution" } : {}) });
}

export async function apply(ctx, config) {
  const runtime = await createPluginRuntime(config, { present: async ({ sessionKey, text }) => {
    const agent = ctx.agents.get(sessionKey);
    if (agent === undefined) throw new TypeError("DSH_INTAKE_SESSION_UNAVAILABLE");
    presentToDshSession(agent, text);
  }, sessionAvailable: (sessionKey) => ctx.agents.get(sessionKey) !== undefined });
  const active = new Set();
  const attachmentStore = ctx.attachments;
  const worktree = () => process.cwd();
  const run = (task) => { active.add(task); void task.finally(() => active.delete(task)).catch(() => undefined); return task; };
  const command = ctx.commands.register({
    name: "wsr",
    description: "Create, list, recover, inspect, finish, or abandon a Workflow Delivery",
    input: { hint: "list | create <selector> | recover [delivery-id] | status [delivery-id] | action finish | abandon <delivery-id>", images: true },
    recordInput: false,
    async handler(invocation) {
      return run((async () => {
        try {
          const operation = parseWsrCommand(invocation.rawInput);
          if (invocation.attachments.length > 0 && !["create", "action-finish"].includes(operation.operation)) return { kind: "error", text: "WSR_COMMAND_INVALID" };
          const result = await runtime.invokeForSession({ sessionKey: String(invocation.agent.id), worktree: worktree(), operation, turnText: commandTurn(invocation.rawInput), images: invocation.attachments, attachmentStore, signal: invocation.signal });
          const { renderIntakeResult } = await import("@workflow-self-recursive/execution-system");
          return { kind: result.kind === "ERROR" ? "error" : "success", text: renderIntakeResult(result, 4096) };
        } catch (cause) {
          return { kind: "error", text: typeof cause?.code === "string" ? cause.code : cause instanceof Error ? cause.message : "DSH_INTAKE_FAILED" };
        }
      })());
    },
  });
  const { defineTool } = await import("@deepseek-ai/dsh-tools");
  const tool = ctx.tools.register(defineTool({
      name: "workflow_execution_intake",
      description: "Invoke exactly one closed Workflow Intake operation for the current DSH-I turn.",
      parameters: { operation: { type: "string", required: true }, selector: { type: "string" }, deliveryId: { type: "string" } },
      output: { schema: { type: "object", properties: { result: { type: "string", required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: "text", text: value.result }] },
      async execute(args, execution) {
        const agent = execution.agent;
        if (agent === undefined) throw new TypeError("DSH_INTAKE_SESSION_UNAVAILABLE");
        const turn = turnFromAgent(agent);
        const operation = mapIntakeToolOperation(args);
        const result = await runtime.invokeForSession({ sessionKey: String(agent.id), worktree: worktree(), operation, turnText: turn.text, images: turn.images, attachmentStore, signal: execution.signal });
        const { renderIntakeResult } = await import("@workflow-self-recursive/execution-system");
        return { result: renderIntakeResult(result, 4096) };
      },
    }));
  const preStep = ctx.on?.("agent/pre-step", async (payload, next) => {
    if (await runtime.bindings.bySession(String(payload.agent.id)) === undefined) return next();
    const messages = payload.messages.filter((message) => message.source?.kind === "user");
    if (messages.length !== 1) return next();
    const result = await runtime.answerForSession({ sessionKey: String(payload.agent.id), text: textOf(messages[0].content), images: messages[0].content.filter((block) => block.type === "image"), attachmentStore, signal: payload.signal });
    return result.kind === "ERROR" && result.code === "ACTION_NOT_AWAITING_INPUT" ? next() : { kind: "reject" };
  });
  ctx.effect(function* () {
    yield async () => {
      await command?.();
      await tool?.();
      await preStep?.();
      await Promise.allSettled([...active]);
      await runtime.close();
    };
  }, "workflow-execution intake lifecycle");
}
