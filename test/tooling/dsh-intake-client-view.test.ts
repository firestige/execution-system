import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const clientPath = path.resolve(import.meta.dirname, "../../packages/dsh-intake/lib/client.js");

async function loadViews(sessionSnapshot?: unknown): Promise<ReadonlyMap<string, (props: unknown) => any>> {
  const source = await readFile(clientPath, "utf8");
  let definition: any;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: unknown) { definition = value; } } },
  });
  const React = Object.freeze({
    createElement(type: unknown, props: unknown, ...children: unknown[]) { return { type, props, children }; },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); },
  });
  const client = definition.factory((name: string) => {
    if (name !== "react") throw new TypeError(`UNEXPECTED_CLIENT_IMPORT:${name}`);
    return React;
  });
  const components = new Map<string, (props: unknown) => any>();
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
        session: { subscribe() { return () => undefined; }, getSnapshot() { return sessionSnapshot; } },
      };
    },
  } });
  return components;
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
  it("renders a stable same-session acknowledgement while the command is pending", async () => {
    const view = await loadCommandView();
    const rendered = view({ node: { commandId: "command-1", outcome: null } });
    expect(rendered.props).toMatchObject({
      "data-wsr-presentation": "true",
      "data-wsr-version": "wsr.presentation@1.0.0",
      "data-wsr-kind": "command-accepted",
      "data-wsr-correlation": "command-1",
      role: "status",
    });
    expect(textOf(rendered)).toBe("WSR command accepted");
  });

  it("renders the empty list and replaces malformed host payloads with one bounded error", async () => {
    const view = await loadCommandView();
    const list = view({ node: { outcome: { text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-1", kind: "delivery-list", data: { items: [] },
    }) } } });
    expect(list.props["data-wsr-kind"]).toBe("delivery-list");
    expect(textOf(list)).toBe("No Workflow Deliveries");

    const malformed = view({ node: { outcome: { text: "raw-secret-payload" } } });
    expect(malformed.props).toMatchObject({ "data-wsr-kind": "error", role: "alert" });
    expect(textOf(malformed)).toContain("WSR_PRESENTATION_INVALID");
    expect(textOf(malformed)).not.toContain("raw-secret-payload");
  });

  it.each([
    ["delivery-running", { deliveryId: "delivery-1" }, "Workflow delivery running · delivery-1"],
    ["delivery-status", { state: "RUNNING_CORRELATED" }, "Workflow delivery status · RUNNING_CORRELATED"],
    ["action-output", { content: { text: "hello" } }, "Action output"],
    ["action-input-request", { prompt: { question: "Continue?" } }, "Action input requested"],
    ["terminal-result", { outcome: "SUCCEEDED" }, "Workflow finished · SUCCEEDED"],
  ])("renders the %s presentation", async (kind, data, expected) => {
    const view = await loadCommandView();
    const rendered = view({ node: { outcome: { text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-1", kind, data,
    }) } } });
    expect(rendered.props["data-wsr-kind"]).toBe(kind);
    expect(textOf(rendered)).toContain(expected);
  });
});

describe("DSH official WSR sidebar projection", () => {
  it("renders the latest WSR presentation while the current session remains blank", async () => {
    const outcome = { text: JSON.stringify({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "presentation-1", kind: "delivery-list", data: { items: [] },
    }) };
    const views = await loadViews({
      composerPhase: "blank",
      chat: { order: ["command-1"], nodes: new Map([["command-1", {
        kind: "command", data: { commandId: "command-1", name: "wsr", outcome },
      }]]) },
    });
    const sidebar = views.get("sidebar.footer.action");
    expect(sidebar, "sidebar.footer.action contribution").toBeTypeOf("function");
    const rendered = sidebar!({ wide: true, useSessions: (select: (value: unknown) => unknown) => select({ current: "session-1" }) });
    expect(rendered.props).toMatchObject({
      "data-wsr-sidebar": "true",
      "data-wsr-presentation": "true",
      "data-wsr-version": "wsr.presentation@1.0.0",
      "data-wsr-kind": "delivery-list",
    });
    expect(textOf(rendered)).toContain("No Workflow Deliveries");
  });
});
