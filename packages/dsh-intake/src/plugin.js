import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { IntakeSessionBindingRepository } from "./binding-repository.js";
import { parseWsrCommand } from "./command.js";

export const name = "workflow-execution";
export const inject = ["commands", "tools", "attachments", "agents", "workspaceRegistry"];

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

function workspaceUnauthorized() {
  return Object.assign(new TypeError("DSH_INTAKE_WORKSPACE_UNAUTHORIZED"), { code: "DSH_INTAKE_WORKSPACE_UNAUTHORIZED" });
}

export async function resolveConversationWorkspace(ctx, agent) {
  const sessionKey = agent !== null && typeof agent === "object" && typeof agent.id === "string" && agent.id.length > 0
    ? agent.id
    : undefined;
  if (ctx === null || typeof ctx !== "object" || typeof ctx.agents?.get !== "function"
    || typeof ctx.workspaceRegistry?.resolveByPath !== "function" || typeof sessionKey !== "string" || sessionKey.length === 0) {
    throw workspaceUnauthorized();
  }
  const liveAgent = ctx.agents.get(sessionKey);
  const cwd = agent?.session?.header?.cwd;
  if (liveAgent !== agent || typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw workspaceUnauthorized();
  }
  let workspace;
  try { workspace = await ctx.workspaceRegistry.resolveByPath(cwd); }
  catch { throw workspaceUnauthorized(); }
  if (workspace === undefined || typeof workspace.id !== "string" || typeof workspace.path !== "string"
    || !path.isAbsolute(workspace.path) || !Array.isArray(workspace.sessionIds)
    || !workspace.sessionIds.some((candidate) => String(candidate) === sessionKey)) {
    throw workspaceUnauthorized();
  }
  let canonicalCwd;
  let canonicalWorkspace;
  try { [canonicalCwd, canonicalWorkspace] = await Promise.all([realpath(cwd), realpath(workspace.path)]); }
  catch { throw workspaceUnauthorized(); }
  if (canonicalCwd !== canonicalWorkspace || workspace.path !== canonicalWorkspace) throw workspaceUnauthorized();
  return Object.freeze({ sessionKey, workspaceId: String(workspace.id), path: canonicalWorkspace });
}

export function recordConsumedActionReply(agent, message) {
  if (agent === null || typeof agent !== "object" || typeof agent.session?.append !== "function"
    || message === null || typeof message !== "object" || message.source?.kind !== "user") {
    throw new TypeError("DSH_INTAKE_USER_INPUT_INVALID");
  }
  agent.session.append("user/message", message, { surfaceOp: "append" });
}

const PRESENTATION_VERSION = "wsr.presentation@1.0.0";
const PRESENTATION_KINDS = new Set(["command-accepted", "delivery-running", "delivery-list", "delivery-status", "action-output", "action-input-request", "terminal-result", "error"]);

function boundedPresentation(presentation) {
  const valid = presentation !== null && typeof presentation === "object" && !Array.isArray(presentation)
    && presentation.schemaVersion === PRESENTATION_VERSION
    && typeof presentation.correlation === "string" && presentation.correlation.length > 0
    && PRESENTATION_KINDS.has(presentation.kind)
    && presentation.data !== null && typeof presentation.data === "object" && !Array.isArray(presentation.data);
  const safe = valid ? presentation : Object.freeze({
    schemaVersion: PRESENTATION_VERSION,
    correlation: "presentation-invalid",
    kind: "error",
    data: Object.freeze({ code: "WSR_PRESENTATION_INVALID", message: "WSR_PRESENTATION_INVALID" }),
  });
  const text = JSON.stringify(safe);
  if (Buffer.byteLength(text, "utf8") <= 4096) return text;
  return JSON.stringify({ schemaVersion: PRESENTATION_VERSION, correlation: safe.correlation, kind: "error", data: { code: "OUTPUT_TRUNCATED", message: "OUTPUT_TRUNCATED" } });
}

export function presentToDshSession(agent, presentation, createId = () => `cmd-workflow-execution-${randomUUID()}`) {
  if (agent === null || typeof agent !== "object" || typeof agent.session?.append !== "function"
    || typeof createId !== "function") {
    throw new TypeError("DSH_INTAKE_PRESENTATION_INVALID");
  }
  const text = boundedPresentation(presentation);
  const commandId = createId();
  agent.session.append("command/run", {
    commandId,
    name: "wsr",
    source: { kind: "plugin", plugin: "workflow-execution" },
  });
  agent.session.append("command/done", { commandId, kind: presentation?.kind === "error" ? "error" : "success", text });
}

export function createSessionPresentationRouter(agents) {
  if (agents === null || typeof agents !== "object" || typeof agents.get !== "function") {
    throw new TypeError("DSH_INTAKE_SESSION_UNAVAILABLE");
  }
  const retained = new Map();
  return Object.freeze({
    retain(sessionKey, agent) {
      if (typeof sessionKey !== "string" || sessionKey.length === 0 || agent === null || typeof agent !== "object"
        || String(agent.id) !== sessionKey || typeof agent.session?.append !== "function") {
        throw new TypeError("DSH_INTAKE_SESSION_UNAVAILABLE");
      }
      retained.set(sessionKey, agent);
    },
    release(sessionKey) { retained.delete(sessionKey); },
    present({ sessionKey, presentation }) {
      const agent = agents.get(sessionKey) ?? retained.get(sessionKey);
      if (agent === undefined) throw new TypeError("DSH_INTAKE_SESSION_UNAVAILABLE");
      try { presentToDshSession(agent, presentation); }
      finally {
        if (["terminal-result", "error"].includes(presentation?.kind)) retained.delete(sessionKey);
      }
    },
  });
}

export function presentationForDshOperation(api, correlation, operation, result, maxBytes = 4096) {
  if (operation?.operation === "create" && result?.kind === "RECOVERY") {
    return api.createIntakePresentation(correlation, "delivery-status", {
      worktree: result.worktree,
      deliveryId: result.deliveryId,
      state: result.state,
      created: false,
      reason: "CURRENT_DELIVERY_EXISTS",
    });
  }
  return api.presentationForIntakeResult(correlation, result, maxBytes);
}

export async function createPluginRuntime(config, options = {}) {
  const admitted = profile(config);
  const api = await (options.moduleLoader?.() ?? import("wsr-execution"));
  const attachmentBytes = new Map();
  const bindings = options.bindings ?? new IntakeSessionBindingRepository(admitted.bindingFile);
  const sessionByCorrelation = new Map();
  const present = async (presentation) => {
    const sessionKey = sessionByCorrelation.get(presentation.correlation);
    if (sessionKey !== undefined) await options.present?.(Object.freeze({ sessionKey, presentation }));
  };
  const dependencies = options.dependencies ?? defaultDependencies(attachmentBytes, present);
  const factory = options.factory ?? new api.DefaultExecutionApplicationFactory();
  const application = await factory.create(admitted.configFile, dependencies);
  const control = options.control ?? api.getExecutionApplicationControl(application);
  const bindingInventory = () => typeof control.bindingInventory === "function" ? control.bindingInventory() : control.list();
  try {
    await application.start();
    const inventory = await bindingInventory();
    await bindings.start(inventory);
    for (const binding of await bindings.list()) {
      const sameDelivery = inventory.filter((item) => item.deliveryId === binding.deliveryId || item.worktree === binding.worktree);
      const matches = sameDelivery.filter((item) => item.deliveryId === binding.deliveryId && item.worktree === binding.worktree
        && item.deliveryBindingIdentity === binding.deliveryBindingIdentity);
      if (matches.length === 0 && sameDelivery.length === 0) {
        await bindings.detach(binding.deliveryId);
        continue;
      }
      if (matches.length !== 1 || sameDelivery.length !== 1) {
        throw Object.assign(new Error("INTAKE_BINDING_INVARIANT_VIOLATION"), { code: "INTAKE_BINDING_INVARIANT_VIOLATION" });
      }
      if (options.sessionAvailable !== undefined && !await options.sessionAvailable(binding.sessionKey)) {
        await bindings.markDetached(binding.deliveryId);
        continue;
      }
      control.attach(binding.deliveryId, binding.correlation);
      sessionByCorrelation.set(binding.correlation, binding.sessionKey);
    }
  } catch (cause) {
    try { await application.close(); } catch { /* preserve the first startup failure */ }
    throw cause;
  }
  const service = new api.WorkflowIntakeService(Object.freeze({
    application,
    control,
    ...(typeof control.executeFromConversationWorkspace !== "function" ? {} : {
      execute: (request, authorization) => control.executeFromConversationWorkspace(request, authorization),
    }),
  }));
  const active = new Set();
  let accepting = true;
  let closePromise;

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

  async function awaitRegistrationOrResult(execution, correlation) {
    const result = execution.then((value) => Object.freeze({ kind: "result", result: value }));
    while (true) {
      const first = await Promise.race([
        result,
        control.waitForDelivery(correlation, options.deliveryRegistrationTimeoutMs ?? 10_000)
          .then((delivery) => Object.freeze({ kind: "delivery", delivery })),
      ]);
      if (first.kind === "result" || first.delivery !== undefined) return first;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function invokeForSession(input) {
    if (!accepting) return error("APPLICATION_CLOSING");
    const candidateBinding = await bindings.bySession(input.sessionKey);
    const existing = candidateBinding?.state === "BOUND" ? candidateBinding : undefined;
    const correlation = existing?.correlation ?? `intake-${randomUUID()}`;
    const attachments = await captureImages(input.images ?? [], input.attachmentStore, input.signal);
    const turn = Object.freeze({ text: input.turnText ?? "", attachments });
    const operation = input.operation;
    async function conversationAuthorization() {
      try {
        if (options.resolveConversationWorkspace === undefined || input.agent === null || typeof input.agent !== "object"
          || String(input.agent.id) !== input.sessionKey) return undefined;
        const authority = await options.resolveConversationWorkspace(input.agent);
        if (authority === null || typeof authority !== "object" || authority.sessionKey !== input.sessionKey
          || typeof authority.workspaceId !== "string" || authority.workspaceId.length === 0
          || typeof authority.path !== "string" || !path.isAbsolute(authority.path)) return undefined;
        const canonical = await realpath(authority.path);
        if (canonical !== authority.path) return undefined;
        return Object.freeze({
          schemaVersion: "execution.conversation-workspace-authorization@1.0.0",
          sessionKey: input.sessionKey,
          workspaceId: authority.workspaceId,
          path: canonical,
        });
      } catch { return undefined; }
    }
    if (operation.operation === "create") {
      if (candidateBinding !== undefined) return error("SESSION_INTAKE_BOUND");
      const authorization = await conversationAuthorization();
      if (authorization === undefined) return error("DSH_INTAKE_WORKSPACE_UNAUTHORIZED");
      sessionByCorrelation.set(correlation, input.sessionKey);
      const execution = track(service.invoke(Object.freeze({ operation: "create", selector: operation.selector, worktree: authorization.path, directive: operation.directive, turn, correlation }), authorization));
      const first = await awaitRegistrationOrResult(execution, correlation);
      if (first.kind === "result") {
        if (first.result.kind === "ERROR" || first.result.kind === "TERMINAL" || first.result.kind === "RECOVERY") sessionByCorrelation.delete(correlation);
        return first.result;
      }
      const delivery = first.delivery;
      await bindings.claim(Object.freeze({ sessionKey: input.sessionKey, correlation, deliveryId: delivery.deliveryId, worktree: delivery.worktree, deliveryBindingIdentity: delivery.deliveryBindingIdentity }));
      control.attach(delivery.deliveryId, correlation);
      void track(execution.then(async (result) => {
        try { await options.present?.(Object.freeze({
          sessionKey: input.sessionKey,
          presentation: api.presentationForIntakeResult(correlation, result, 4096),
        })); }
        catch { /* presentation is not Delivery control */ }
        if (result.kind === "TERMINAL" || result.kind === "ERROR") {
          await bindings.detach(delivery.deliveryId);
          sessionByCorrelation.delete(correlation);
        }
      })).catch(() => undefined);
      return Object.freeze({ kind: "START_UNCERTAIN", worktree: delivery.worktree, deliveryId: delivery.deliveryId });
    }
    if (operation.operation === "list") return service.invoke(Object.freeze({ operation: "list", correlation }));
    if (operation.operation === "recover") {
      if (existing !== undefined) return error("SESSION_INTAKE_BOUND");
      const authorization = await conversationAuthorization();
      if (authorization === undefined) return error("DSH_INTAKE_WORKSPACE_UNAUTHORIZED");
      const recoverable = (await bindingInventory()).filter((item) => operation.deliveryId === undefined
        ? item.worktree === authorization.path
        : item.deliveryId === operation.deliveryId);
      if (operation.deliveryId !== undefined && recoverable.length === 1 && recoverable[0].worktree !== authorization.path) {
        return error("DSH_INTAKE_WORKSPACE_UNAUTHORIZED");
      }
      if (recoverable.length === 1) {
        const claimed = await bindings.byDelivery(recoverable[0].deliveryId);
        if (claimed?.state === "BOUND") return error("DELIVERY_INTAKE_BOUND");
      }
      const result = await service.invoke(Object.freeze({ operation: "recover", worktree: authorization.path, ...(operation.deliveryId === undefined ? {} : { deliveryId: operation.deliveryId }), correlation }));
      if (result.kind === "RECOVERY") {
        const recovered = (await bindingInventory()).filter((item) => item.deliveryId === result.deliveryId && item.worktree === result.worktree);
        if (recovered.length !== 1) return error("INTAKE_BINDING_INVARIANT_VIOLATION");
        await bindings.claim(Object.freeze({ sessionKey: input.sessionKey, correlation, deliveryId: result.deliveryId, worktree: result.worktree, deliveryBindingIdentity: recovered[0].deliveryBindingIdentity }));
        control.attach(result.deliveryId, correlation);
        sessionByCorrelation.set(correlation, input.sessionKey);
      }
      return result;
    }
    if (operation.operation === "status") {
      const deliveryId = operation.deliveryId ?? existing?.deliveryId;
      const authorization = deliveryId === undefined ? await conversationAuthorization() : undefined;
      const worktree = authorization?.path;
      if (deliveryId === undefined && worktree === undefined) return error("DSH_INTAKE_WORKSPACE_UNAUTHORIZED");
      return service.invoke(Object.freeze({ operation: "status", ...(worktree === undefined ? {} : { worktree }), ...(deliveryId === undefined ? {} : { deliveryId }), correlation }));
    }
    if (operation.operation === "action-finish") {
      if (existing === undefined) return error("DELIVERY_UNKNOWN");
      return service.invoke(Object.freeze({ operation: "action-finish", ...(operation.remainder === undefined && attachments.length === 0 ? {} : { turn: Object.freeze({ text: operation.remainder ?? "", attachments }) }), correlation: existing.correlation }));
    }
    const deliveryId = operation.deliveryId ?? existing?.deliveryId;
    if (deliveryId === undefined) return error("WSR_COMMAND_INVALID");
    const result = await service.invoke(Object.freeze({ operation: "abandon", deliveryId, correlation }));
    if (result.kind === "TERMINAL") {
      const detached = await bindings.byDelivery(deliveryId);
      await bindings.detach(deliveryId);
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

  function close() {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      accepting = false;
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise((resolve) => setTimeout(resolve, options.quiesceTimeoutMs ?? 10_000)),
      ]);
      await application.close();
      attachmentBytes.clear();
    })();
    return closePromise;
  }

  return Object.freeze({ application, service, control, bindings, invokeForSession, answerForSession, close });
}

function commandTurn(rawInput) {
  const normalized = rawInput.startsWith(" ") ? rawInput.slice(1) : rawInput;
  return `/wsr ${normalized}`;
}

export async function recordWsrCommandInput(agent, rawInput, attachments = [], createId = () => `message-workflow-execution-${randomUUID()}`) {
  if (agent === null || typeof agent !== "object" || typeof agent.followup !== "function" || typeof agent.whenIdle !== "function"
    || typeof rawInput !== "string" || !Array.isArray(attachments) || typeof createId !== "function") {
    throw new TypeError("DSH_INTAKE_USER_INPUT_INVALID");
  }
  const message = Object.freeze({
    id: createId(),
    role: "user",
    source: Object.freeze({ kind: "user", workflowCommand: "wsr" }),
    content: Object.freeze([
      Object.freeze({ type: "text", text: commandTurn(rawInput) }),
      ...attachments,
    ]),
  });
  agent.followup(message);
  await agent.whenIdle();
  return message;
}

export function mapIntakeToolOperation(args) {
  const operationNames = ["list", "create", "recover", "status", "action-finish", "abandon"];
  if (args === null || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some((key) => !["operation", "selector", "deliveryId"].includes(key))
    || !operationNames.includes(args.operation)
    || (args.operation === "create") !== (typeof args.selector === "string" && args.selector.length > 0)
    || (args.operation === "abandon" && args.deliveryId !== undefined
      && (typeof args.deliveryId !== "string" || args.deliveryId.length === 0))
    || (!["recover", "status", "abandon"].includes(args.operation) && args.deliveryId !== undefined)) {
    throw new TypeError("INTAKE_OPERATION_INVALID");
  }
  return Object.freeze({ operation: args.operation, ...(args.selector === undefined ? {} : { selector: args.selector }), ...(args.deliveryId === undefined ? {} : { deliveryId: args.deliveryId }), ...(args.operation === "create" ? { directive: "/workflow-execution" } : {}) });
}

export async function apply(ctx, config) {
  const presentationRouter = createSessionPresentationRouter(ctx.agents);
  const runtime = await createPluginRuntime(config, { present: (value) => presentationRouter.present(value),
  sessionAvailable: (sessionKey) => ctx.agents.get(sessionKey) !== undefined,
  resolveConversationWorkspace: async (agent) => resolveConversationWorkspace(ctx, agent) });
  const active = new Set();
  const attachmentStore = ctx.attachments;
  const run = (task) => { active.add(task); void task.finally(() => active.delete(task)).catch(() => undefined); return task; };
  const command = ctx.commands.register({
    name: "wsr",
    description: "Create, list, recover, inspect, finish, or abandon a Workflow Delivery",
    input: { hint: "list | create <selector> | recover [delivery-id] | status [delivery-id] | action finish | abandon [delivery-id]", images: true },
    recordInput: true,
    async handler(invocation) {
      return run((async () => {
        let query = false;
        try {
          const operation = parseWsrCommand(invocation.rawInput);
          if (["create", "recover"].includes(operation.operation)) {
            presentationRouter.retain(String(invocation.agent.id), invocation.agent);
          }
          query = operation.operation === "list" || operation.operation === "status";
          const { createIntakePresentation, presentationForIntakeResult, serializeIntakePresentation } = await import("wsr-execution");
          if (!query) {
            await recordWsrCommandInput(invocation.agent, invocation.rawInput, invocation.attachments);
            presentToDshSession(invocation.agent, createIntakePresentation(
              String(invocation.commandId), "command-accepted", {},
            ));
          }
          if (invocation.attachments.length > 0 && !["create", "action-finish"].includes(operation.operation)) {
            const presentation = createIntakePresentation(
              `presentation-${randomUUID()}`, "error", { code: "WSR_COMMAND_INVALID", message: "WSR_COMMAND_INVALID" },
            );
            if (!query) presentToDshSession(invocation.agent, presentation);
            return { kind: "error", text: serializeIntakePresentation(presentation, 4096) };
          }
          const result = await runtime.invokeForSession({ sessionKey: String(invocation.agent.id), agent: invocation.agent, operation, turnText: commandTurn(invocation.rawInput), images: invocation.attachments, attachmentStore, signal: invocation.signal });
          if (["create", "recover"].includes(operation.operation) && !["START_UNCERTAIN", "RECOVERY"].includes(result.kind)) {
            presentationRouter.release(String(invocation.agent.id));
          }
          const presentation = presentationForDshOperation({ createIntakePresentation, presentationForIntakeResult }, `presentation-${randomUUID()}`, operation, result, 4096);
          if (!query) presentToDshSession(invocation.agent, presentation);
          return { kind: result.kind === "ERROR" ? "error" : "success", text: serializeIntakePresentation(presentation, 4096) };
        } catch (cause) {
          const { createIntakePresentation, serializeIntakePresentation } = await import("wsr-execution");
          const code = typeof cause?.code === "string" ? cause.code : "DSH_INTAKE_FAILED";
          const message = code === "WSR_COMMAND_INVALID" && typeof cause?.message === "string" ? cause.message : code;
          const presentation = createIntakePresentation(`presentation-${randomUUID()}`, "error", { code, message });
          if (!query) presentToDshSession(invocation.agent, presentation);
          return { kind: "error", text: serializeIntakePresentation(presentation, 4096) };
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
        if (["create", "recover"].includes(operation.operation)) presentationRouter.retain(String(agent.id), agent);
        const result = await runtime.invokeForSession({ sessionKey: String(agent.id), agent, operation, turnText: turn.text, images: turn.images, attachmentStore, signal: execution.signal });
        if (["create", "recover"].includes(operation.operation) && !["START_UNCERTAIN", "RECOVERY"].includes(result.kind)) {
          presentationRouter.release(String(agent.id));
        }
        const { createIntakePresentation, presentationForIntakeResult, serializeIntakePresentation } = await import("wsr-execution");
        return { result: serializeIntakePresentation(presentationForDshOperation(
          { createIntakePresentation, presentationForIntakeResult }, `presentation-${randomUUID()}`, operation, result, 4096,
        ), 4096) };
      },
  }));
  const preStep = ctx.on?.("agent/pre-step", async (payload, next) => {
    const messages = payload.messages.filter((message) => message.source?.kind === "user");
    const command = messages.find((message) => message.source?.workflowCommand === "wsr");
    if (command !== undefined) {
      recordConsumedActionReply(payload.agent, command);
      return { kind: "reject" };
    }
    if (await runtime.bindings.bySession(String(payload.agent.id)) === undefined) return next();
    if (messages.length !== 1) return next();
    try {
      presentationRouter.retain(String(payload.agent.id), payload.agent);
      const result = await runtime.answerForSession({ sessionKey: String(payload.agent.id), text: textOf(messages[0].content), images: messages[0].content.filter((block) => block.type === "image"), attachmentStore, signal: payload.signal });
      if (result.kind === "ERROR" && result.code === "ACTION_NOT_AWAITING_INPUT") return next();
      recordConsumedActionReply(payload.agent, messages[0]);
      return { kind: "reject" };
    } catch (cause) {
      recordConsumedActionReply(payload.agent, messages[0]);
      throw cause;
    }
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
