import { describe, expect, it } from "vitest";

import {
  WSR_PRESENTATION_VERSION,
  actionOutputPresentation,
  createIntakePresentation,
  presentationForIntakeResult,
  serializeIntakePresentation,
} from "../../src/index.js";

describe("WSR host-neutral presentation contract", () => {
  it("serializes each closed event kind in one versioned envelope", () => {
    const events = [
      createIntakePresentation("correlation-1", "command-accepted", { operation: "list" }),
      createIntakePresentation("correlation-1", "delivery-running", { worktree: "/workspace", deliveryId: "delivery-1" }),
      createIntakePresentation("correlation-1", "delivery-list", { items: [] }),
      createIntakePresentation("correlation-1", "delivery-status", { worktree: "/workspace", deliveryId: "delivery-1", state: "RUNNING_CORRELATED" }),
      createIntakePresentation("correlation-1", "action-output", { content: { text: "hello" } }),
      createIntakePresentation("correlation-1", "action-input-request", { prompt: { question: "Continue?" } }),
      createIntakePresentation("correlation-1", "terminal-result", { worktree: "/workspace", deliveryId: "delivery-1", outcome: "SUCCEEDED" }),
      createIntakePresentation("correlation-1", "error", { code: "DELIVERY_UNKNOWN", message: "DELIVERY_UNKNOWN" }),
    ];

    expect(WSR_PRESENTATION_VERSION).toBe("wsr.presentation@1.0.0");
    expect(events.map((event) => event.kind)).toEqual([
      "command-accepted", "delivery-running", "delivery-list", "delivery-status",
      "action-output", "action-input-request", "terminal-result", "error",
    ]);
    for (const event of events) {
      expect(Object.isFrozen(event)).toBe(true);
      expect(JSON.parse(serializeIntakePresentation(event, 4096))).toEqual(event);
    }
  });

  it("maps empty list, running, status, terminal, and error results without leaking extra fields", () => {
    expect(presentationForIntakeResult("correlation-1", { kind: "LIST", deliveries: [] }, 4096)).toMatchObject({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "correlation-1", kind: "delivery-list", data: { items: [] },
    });
    expect(presentationForIntakeResult("correlation-1", { kind: "START_UNCERTAIN", worktree: "/workspace", deliveryId: "delivery-1" }, 4096).kind)
      .toBe("delivery-running");
    expect(presentationForIntakeResult("correlation-1", { kind: "RECOVERY", worktree: "/workspace", deliveryId: "delivery-1", state: "RUNNING_CORRELATED" }, 4096).kind)
      .toBe("delivery-status");
    expect(presentationForIntakeResult("correlation-1", { kind: "TERMINAL", worktree: "/workspace", deliveryId: "delivery-1", outcome: "SUCCEEDED", summary: "done", credential: "secret" } as never, 4096))
      .toMatchObject({ kind: "terminal-result", data: { worktree: "/workspace", deliveryId: "delivery-1", outcome: "SUCCEEDED", summary: "done" } });
    expect(serializeIntakePresentation(
      presentationForIntakeResult("correlation-1", { kind: "ERROR", code: "DELIVERY_UNKNOWN", message: "DELIVERY_UNKNOWN", nativePayload: "secret" } as never, 4096),
      4096,
    )).not.toContain("nativePayload");
  });

  it("projects native assistant blocks to visible text without publishing completion tool protocol", () => {
    const event = actionOutputPresentation("correlation-1", [
      { type: "text", text: "你好！我先概括您的请求，然后为您完成这个操作。" },
      {
        type: "tool-call",
        id: "call-secret",
        name: "workflow_complete",
        arguments: JSON.stringify({ result: { success: true, greeting: "您好！我已收到并概括您的请求。" } }),
      },
    ]);

    expect(event).toMatchObject({
      kind: "action-output",
      data: { content: { text: "您好！我已收到并概括您的请求。" } },
    });
    const serialized = serializeIntakePresentation(event, 4096);
    expect(serialized).not.toContain("tool-call");
    expect(serialized).not.toContain("workflow_complete");
    expect(serialized).not.toContain("call-secret");
    expect(serialized).not.toContain("为您完成这个操作");
  });

  it.each([
    ["plain assistant text", "plain assistant text"],
    [{ type: "text", text: "single text block" }, "single text block"],
    [{ result: { greeting: "nested visible result" } }, "nested visible result"],
    [["first", { type: "text", text: "second" }, null], "first\n\nsecond"],
    [{ type: "tool-call", name: "workflow_complete", arguments: "secret" }, "WSR content unavailable"],
  ])("normalizes Action output %j to public text", (content, expected) => {
    expect(actionOutputPresentation("correlation-1", content as never).data)
      .toEqual({ content: { text: expected } });
  });

  it("fails closed to a bounded error when public presentation content exceeds its bound", () => {
    const event = presentationForIntakeResult("correlation-1", {
      kind: "TERMINAL", worktree: "/workspace", deliveryId: "delivery-1", outcome: "FAILED", summary: "x".repeat(10_000),
    }, 256);
    const serialized = serializeIntakePresentation(event, 256);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(256);
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: "wsr.presentation@1.0.0", correlation: "correlation-1", kind: "error", data: { code: "OUTPUT_TRUNCATED" },
    });
  });

  it("rejects invalid values and bounds direct envelopes without exposing oversized content", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createIntakePresentation("", "error", {})).toThrow("INTAKE_PRESENTATION_INVALID");
    expect(() => createIntakePresentation("correlation-1", "error", cyclic as never)).toThrow("INTAKE_PRESENTATION_INVALID");

    const oversized = createIntakePresentation("correlation-1", "action-output", { content: "secret".repeat(1_000) });
    const bounded = serializeIntakePresentation(oversized, 256);
    expect(bounded).toContain("OUTPUT_TRUNCATED");
    expect(bounded).not.toContain("secret");
    expect(() => serializeIntakePresentation(oversized, 128)).toThrow("INTAKE_PRESENTATION_BOUND_INVALID");
    expect(() => serializeIntakePresentation(oversized, 127)).toThrow("INTAKE_PRESENTATION_BOUND_INVALID");
    expect(() => presentationForIntakeResult("correlation-1", { kind: "LIST", deliveries: [] }, 127))
      .toThrow("INTAKE_PRESENTATION_BOUND_INVALID");
  });
});
