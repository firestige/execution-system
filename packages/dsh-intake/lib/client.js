window.__ModuleLoader__.load({
  id: "@workflow-self-recursive/dsh-intake",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const VERSION = "wsr.presentation@1.0.0";
    const KINDS = new Set([
      "command-accepted", "delivery-running", "delivery-list", "delivery-status",
      "action-output", "action-input-request", "terminal-result", "error",
    ]);
    const EMPTY_SESSION = Object.freeze({ chat: Object.freeze({ order: Object.freeze([]), nodes: new Map() }) });
    const subscribeEmpty = () => () => undefined;
    const readEmptySession = () => EMPTY_SESSION;

    function invalidPresentation() {
      return { schemaVersion: VERSION, correlation: "presentation-invalid", kind: "error", data: {
        code: "WSR_PRESENTATION_INVALID", message: "WSR presentation unavailable",
      } };
    }

    function parsePresentation(text) {
      if (typeof text !== "string" || text.length === 0 || text.length > 4096) return invalidPresentation();
      try {
        const value = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).sort().join(",") !== "correlation,data,kind,schemaVersion"
          || value.schemaVersion !== VERSION || typeof value.correlation !== "string" || value.correlation.length === 0
          || !KINDS.has(value.kind) || value.data === null || typeof value.data !== "object" || Array.isArray(value.data)) {
          return invalidPresentation();
        }
        return value;
      } catch {
        return invalidPresentation();
      }
    }

    function stringField(data, name) {
      return typeof data[name] === "string" ? data[name] : undefined;
    }

    function contentText(value) {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch { return "WSR content unavailable"; }
    }

    function presentationText(event) {
      const data = event.data;
      if (event.kind === "command-accepted") return "WSR command accepted";
      if (event.kind === "delivery-list") {
        if (!Array.isArray(data.items)) return "WSR presentation unavailable";
        if (data.items.length === 0) return "No Workflow Deliveries";
        return `Workflow Deliveries (${data.items.length})\n${data.items.map((item) => {
          if (item === null || typeof item !== "object") return "Delivery";
          return [item.deliveryId, item.package, item.lifecycle].filter((part) => typeof part === "string").join(" · ") || "Delivery";
        }).join("\n")}`;
      }
      if (event.kind === "delivery-running") return `Workflow delivery running${stringField(data, "deliveryId") === undefined ? "" : ` · ${stringField(data, "deliveryId")}`}`;
      if (event.kind === "delivery-status") return `Workflow delivery status${stringField(data, "state") === undefined ? "" : ` · ${stringField(data, "state")}`}`;
      if (event.kind === "action-output") return `Action output\n${contentText(data.content)}`;
      if (event.kind === "action-input-request") return `Action input requested\n${contentText(data.prompt)}`;
      if (event.kind === "terminal-result") return `Workflow finished${stringField(data, "outcome") === undefined ? "" : ` · ${stringField(data, "outcome")}`}`;
      return `${stringField(data, "code") ?? "WSR_ERROR"}: ${stringField(data, "message") ?? "WSR presentation unavailable"}`;
    }

    function presentationElement(event, surface) {
      return React.createElement("section", {
        "data-wsr-presentation": "true",
        "data-wsr-version": event.schemaVersion,
        "data-wsr-kind": event.kind,
        "data-wsr-correlation": event.correlation,
        ...(surface === "sidebar" ? { "data-wsr-sidebar": "true" } : {}),
        role: event.kind === "error" ? "alert" : "status",
      }, React.createElement("pre", { style: { margin: 0, whiteSpace: "pre-wrap" } }, presentationText(event)));
    }

    function eventForCommand(node) {
      return node?.outcome === null
        ? { schemaVersion: VERSION, correlation: String(node.commandId ?? "command-running"), kind: "command-accepted", data: {} }
        : parsePresentation(node?.outcome?.text);
    }

    function WsrCommandView({ node }) {
      return presentationElement(eventForCommand(node), "command");
    }

    function latestWsrCommand(snapshot) {
      const order = snapshot?.chat?.order;
      const nodes = snapshot?.chat?.nodes;
      if (!Array.isArray(order) || typeof nodes?.get !== "function") return undefined;
      for (let index = order.length - 1; index >= 0; index -= 1) {
        const node = nodes.get(order[index]);
        if (node?.kind === "command" && node.data?.name === "wsr") return node.data;
      }
      return undefined;
    }

    function createWsrSidebar(ctx) {
      return function WsrSidebar({ wide, useSessions }) {
        const sessionId = useSessions((state) => state.current);
        const session = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)?.session;
        const snapshot = React.useSyncExternalStore(
          session === undefined ? subscribeEmpty : (notify) => session.subscribe(notify),
          session === undefined ? readEmptySession : () => session.getSnapshot(),
          readEmptySession,
        );
        const command = latestWsrCommand(snapshot);
        if (command === undefined) return React.createElement("section", {
          "data-wsr-sidebar": "true",
          "data-wsr-kind": "idle",
          role: "status",
        }, wide ? "WSR ready" : "WSR");
        return presentationElement(eventForCommand(command), "sidebar");
      };
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register({
        name: "conversation.chat.commandview",
        key: "wsr",
      }, WsrCommandView));
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "workflow-execution",
        order: 50,
        label: "WSR",
      }, createWsrSidebar(ctx)));
    }

    exports.apply = apply;
    exports.inject = ["sessions", "slots"];
    exports.name = "workflow-execution-client";
    return module.exports;
  },
});
