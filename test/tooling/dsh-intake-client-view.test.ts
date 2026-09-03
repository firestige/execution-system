import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const clientPath = path.resolve(import.meta.dirname, "../../packages/dsh-intake/lib/client.js");

async function loadClient(sessionSnapshot?: unknown) {
  const source = await readFile(clientPath, "utf8");
  let definition: any;
  const copied: string[] = [];
  let reactState: unknown;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: unknown) { definition = value; } } },
    navigator: { clipboard: { async writeText(value: string) { copied.push(value); } } },
  });
  const React = Object.freeze({
    createElement(type: unknown, props: unknown, ...children: unknown[]) { return { type, props, children }; },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); },
    useState(value: unknown) {
      reactState ??= value;
      return [reactState, (next: unknown) => { reactState = next; }];
    },
  });
  const primitives = Object.freeze({
    Tooltip: "Tooltip",
    IconCopyOutline16: "IconCopyOutline16",
    async writeClipboard(value: string) { copied.push(value); return true; },
  });
  const client = definition.factory((name: string) => {
    if (name === "react") return React;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new TypeError(`UNEXPECTED_CLIENT_IMPORT:${name}`);
  });
  const components = new Map<string, (props: unknown) => any>();
  const definitions: any[] = [];
  const commands: string[] = [];
  client.apply({ slots: {
    inject(name: string, install: () => void) {
      install();
    },
    register(descriptor: any, value: (props: unknown) => any) {
      components.set(descriptor.name, value);
    },
  }, sessions: {
    binding(id: string) {
      return id !== "session-1" || sessionSnapshot === undefined ? undefined : {
        session: {
          subscribe() { return () => undefined; },
          getSnapshot() { return sessionSnapshot; },
          async command(line: string) { commands.push(line); return { ok: true, value: { matched: true } }; },
        },
      };
    },
  }, conversationEvents: { register(value: unknown) { definitions.push(value); return () => undefined; } } });
  return { components, definitions, commands, copied };
}

async function loadViews(sessionSnapshot?: unknown): Promise<ReadonlyMap<string, (props: unknown) => any>> {
  return (await loadClient(sessionSnapshot)).components;
}

async function loadCommandView(): Promise<(props: unknown) => any> {
  const component = (await loadViews()).get("conversation.chat.commandview");
  if (component === undefined) throw new TypeError("WSR_COMMAND_VIEW_MISSING");
  return component;
}

function textOf(element: any): string {
  return element === null || element === undefined ? ""
    : typeof element === "string" ? element
      : Array.isArray(element) ? element.map(textOf).join("")
        : textOf(element.children);
}

function elementsOf(element: any): any[] {
  if (element === null || element === undefined || typeof element === "string") return [];
  if (Array.isArray(element)) return element.flatMap(elementsOf);
  return [element, ...elementsOf(element.children)];
}

describe("DSH official WSR command view", () => {
  it("hides every internal WSR command lifecycle because native user/output nodes own the chat timeline", async () => {
    const view = await loadCommandView();
    expect(view({ node: {
      commandId: "command-create", name: "wsr",
      args: " create hello-world-workflow@0.1.0\n向我问好，并提及本 conversation 描述的任务。",
      outcome: { kind: "error", text: "SOURCE_FAILED" },
    } })).toBeNull();

    for (const args of [null, " recover delivery-1", " abandon delivery-1", " action finish\nfinal answer", " list", " status"]) {
      expect(view({ node: { commandId: `command-${String(args)}`, name: "wsr", args, outcome: null } })).toBeNull();
    }
  });

  it.each([
    ["delivery-running", { deliveryId: "delivery-1" }, "Workflow delivery running · delivery-1"],
    ["delivery-status", { state: "RUNNING_CORRELATED" }, "Workflow delivery status · RUNNING_CORRELATED"],
    ["delivery-status", { state: "RESULT_UNRESOLVED", created: false, reason: "CURRENT_DELIVERY_EXISTS" }, "No new Workflow Delivery created · CURRENT_DELIVERY_EXISTS · RESULT_UNRESOLVED"],
    ["delivery-status", { state: "RESULT_UNRESOLVED", diagnostic: { stage: "HOST_START", causeCode: "CHECKPOINT_ORDER_VIOLATION" } }, "Workflow delivery status · RESULT_UNRESOLVED\nFailure stage: HOST_START\nCause: CHECKPOINT_ORDER_VIOLATION"],
    ["action-output", { content: { text: "hello" } }, "Action output"],
    ["action-input-request", { prompt: { question: "Continue?" } }, "Action input requested"],
    ["terminal-result", { outcome: "SUCCEEDED" }, "Workflow finished · SUCCEEDED"],
  ])("renders the %s presentation", async (kind, data, expected) => {
    const fields = data as any;
    const { components, definitions } = await loadClient();
    const definition = definitions.find((candidate) => candidate.kind === "wsr-interaction");
    expect(definition, "WSR chat conversation definition").toBeDefined();
    const run = { type: "command/run", seq: 10, time: 20, data: {
      commandId: "presentation-command-1", name: "wsr", source: { kind: "plugin", plugin: "workflow-execution" },
    } };
    const done = { type: "command/done", seq: 11, time: 21, data: { commandId: "presentation-command-1", kind: "success", text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-1", kind, data,
    }) } };
    expect(definition.match(run)).toEqual({ id: "presentation-command-1", role: "start" });
    expect(definition.match(done)).toEqual({ id: "presentation-command-1", role: "update" });
    const startMatch = { event: run, location: { kind: "session" }, role: "start" };
    const initial = definition.start({ key: "wsr-interaction:presentation-command-1" }, startMatch);
    const state = definition.update({ state: initial }, { event: done, location: { kind: "session" }, role: "update" });
    const node = definition.buildViewNode({
      key: "wsr-interaction:presentation-command-1", id: "presentation-command-1", state,
      start: startMatch, matches: [], current: new Map(),
    });
    expect(node).toMatchObject({ kind: "wsr-interaction", target: "chat", anchorSeq: 10, visibility: "visible" });
    const view = components.get("conversation.chat.node");
    expect(view, "WSR chat node renderer").toBeTypeOf("function");
    const rendered = view!({ node });
    expect(rendered.props["data-wsr-surface"]).toBe("chat");
    expect(rendered.props["data-wsr-chat-role"]).toBe("assistant");
    expect(rendered.props["data-wsr-kind"]).toBe(kind);
    expect(rendered.props["data-wsr-state"]).toBe(typeof fields.state === "string" ? fields.state : undefined);
    expect(rendered.props["data-wsr-failure-stage"]).toBe(typeof fields.diagnostic?.stage === "string" ? fields.diagnostic.stage : undefined);
    expect(rendered.props["data-wsr-cause-code"]).toBe(typeof fields.diagnostic?.causeCode === "string" ? fields.diagnostic.causeCode : undefined);
    expect(rendered.type).toBe("article");
    expect(rendered.children[0].type).toBe("div");
    expect(rendered.children[0].props.style.fontFamily).toBe("inherit");
    expect(textOf(rendered)).toContain(expected);
  });

  it("defensively renders only visible text from a native Action block array", async () => {
    const { components, definitions, copied } = await loadClient();
    const definition = definitions.find((candidate) => candidate.kind === "wsr-interaction");
    const run = { type: "command/run", seq: 10, time: 20, data: {
      commandId: "presentation-command-1", name: "wsr", source: { kind: "plugin", plugin: "workflow-execution" },
    } };
    const done = { type: "command/done", seq: 11, time: 21, data: { commandId: "presentation-command-1", kind: "success", text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-1", kind: "action-output", data: { content: [
        { type: "text", text: "你好！我先概括您的请求，然后为您完成这个操作。" },
        { type: "tool-call", id: "call-secret", name: "workflow_complete", arguments: "{\"result\":{\"success\":true,\"greeting\":\"您好！我已收到并概括您的请求。\"}}" },
      ] },
    }) } };
    const startMatch = { event: run, location: { kind: "session" }, role: "start" };
    const initial = definition.start({ key: "wsr-interaction:presentation-command-1" }, startMatch);
    const state = definition.update({ state: initial }, { event: done, location: { kind: "session" }, role: "update" });
    const node = definition.buildViewNode({
      key: "wsr-interaction:presentation-command-1", id: "presentation-command-1", state,
      start: startMatch, matches: [], current: new Map(),
    });
    const rendered = components.get("conversation.chat.node")!({ node });
    const text = textOf(rendered);

    expect(text).toContain("您好！我已收到并概括您的请求。");
    expect(text).not.toContain("为您完成这个操作");
    expect(text).not.toContain("tool-call");
    expect(text).not.toContain("workflow_complete");
    expect(text).not.toContain("call-secret");
    expect(text).not.toContain("arguments");
    const actions = elementsOf(rendered).find((child: any) => child?.props?.["data-wsr-answer-actions"] === "true");
    expect(actions, "DSH-shaped answer actions row").toBeDefined();
    const copy = elementsOf(actions).find((child: any) => child?.type === "button");
    expect(copy, "Action output copy button").toBeDefined();
    expect(copy.props["aria-label"]).toBe("复制");
    expect(copy.props.className).toBe("wsr-answer-action");
    expect(elementsOf(copy).some((child: any) => child?.type === "IconCopyOutline16")).toBe(true);
    expect(textOf(copy)).not.toContain("⧉");
    await copy.props.onClick();
    expect(copied).toEqual(["您好！我已收到并概括您的请求。"]);
  });
});

describe("DSH official WSR sidebar projection", () => {
  it("queries list/status from tabs and projects only control-plane results", async () => {
    const outcome = { text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-1", kind: "delivery-list", data: { items: [] },
    }) };
    const actionOutcome = { text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-action", kind: "action-output", data: { content: "chat only" },
    }) };
    const { components, commands } = await loadClient({
      composerPhase: "blank",
      chat: { order: ["command-1", "command-2"], nodes: new Map([["command-1", {
        kind: "command", data: { commandId: "command-1", name: "wsr", outcome },
      }], ["command-2", { kind: "command", data: { commandId: "command-2", name: "wsr", outcome: actionOutcome } }]]) },
    });
    const sidebar = components.get("sidebar.footer.action");
    expect(sidebar, "sidebar.footer.action contribution").toBeTypeOf("function");
    const rendered = sidebar!({ wide: true, useSessions: (select: (value: unknown) => unknown) => select({ current: "session-1" }) });
    expect(rendered.props).toMatchObject({
      "data-wsr-sidebar": "true",
      "data-wsr-presentation": "true",
      "data-wsr-version": "wsr.presentation@1.0.0",
      "data-wsr-kind": "delivery-list",
      "data-wsr-surface": "sidebar",
    });
    expect(textOf(rendered)).toContain("No Workflow Deliveries");
    expect(textOf(rendered)).not.toContain("chat only");
    const buttons = rendered.children.filter((child: any) => child?.type === "button");
    expect(buttons.map((button: any) => textOf(button))).toEqual(["Deliveries", "Current status"]);
    await buttons[0].props.onClick();
    await buttons[1].props.onClick();
    expect(commands).toEqual(["/wsr list", "/wsr status"]);
  });

  it("renders the same bounded unresolved diagnostic in the sidebar status and semantic tags", async () => {
    const outcome = { text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-unresolved", kind: "delivery-status", data: {
        deliveryId: "delivery-1", state: "RESULT_UNRESOLVED",
        diagnostic: { stage: "HOST_START", causeCode: "GIT_STATE_MISMATCH" },
      },
    }) };
    const { components } = await loadClient({
      composerPhase: "blank",
      chat: { order: ["command-1"], nodes: new Map([["command-1", {
        kind: "command", data: { commandId: "command-1", name: "wsr", outcome },
      }]]) },
    });
    const rendered = components.get("sidebar.footer.action")!({
      wide: true,
      useSessions: (select: (value: unknown) => unknown) => select({ current: "session-1" }),
    });
    const statusButton = rendered.children.filter((child: any) => child?.type === "button")[1];
    await statusButton.props.onClick();
    const updated = components.get("sidebar.footer.action")!({
      wide: true,
      useSessions: (select: (value: unknown) => unknown) => select({ current: "session-1" }),
    });
    expect(textOf(updated)).toContain("Workflow delivery status · RESULT_UNRESOLVED\nFailure stage: HOST_START\nCause: GIT_STATE_MISMATCH");
    expect(updated.props).toMatchObject({
      "data-wsr-state": "RESULT_UNRESOLVED",
      "data-wsr-failure-stage": "HOST_START",
      "data-wsr-cause-code": "GIT_STATE_MISMATCH",
    });
  });
});
