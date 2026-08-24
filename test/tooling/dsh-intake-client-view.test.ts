import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const clientPath = path.resolve(import.meta.dirname, "../../packages/dsh-intake/lib/client.js");

async function loadClient(sessionSnapshot?: unknown) {
  const source = await readFile(clientPath, "utf8");
  let definition: any;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: unknown) { definition = value; } } },
  });
  const React = Object.freeze({
    createElement(type: unknown, props: unknown, ...children: unknown[]) { return { type, props, children }; },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); },
    useState(value: unknown) { return [value, () => undefined]; },
  });
  const client = definition.factory((name: string) => {
    if (name !== "react") throw new TypeError(`UNEXPECTED_CLIENT_IMPORT:${name}`);
    return React;
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
  return { components, definitions, commands };
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

describe("DSH official WSR command view", () => {
  it("hides generic WSR command rows so list/status stay out of chat", async () => {
    const view = await loadCommandView();
    expect(view({ node: { commandId: "command-1", outcome: null } })).toBeNull();
    expect(view({ node: { outcome: { text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-1", kind: "delivery-list", data: { items: [] },
    }) } } })).toBeNull();
  });

  it.each([
    ["delivery-running", { deliveryId: "delivery-1" }, "Workflow delivery running · delivery-1"],
    ["delivery-status", { state: "RUNNING_CORRELATED" }, "Workflow delivery status · RUNNING_CORRELATED"],
    ["action-output", { content: { text: "hello" } }, "Action output"],
    ["action-input-request", { prompt: { question: "Continue?" } }, "Action input requested"],
    ["terminal-result", { outcome: "SUCCEEDED" }, "Workflow finished · SUCCEEDED"],
  ])("renders the %s presentation", async (kind, data, expected) => {
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
    expect(rendered.props["data-wsr-kind"]).toBe(kind);
    expect(textOf(rendered)).toContain(expected);
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
});
