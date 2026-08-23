import { describe, expect, it } from "vitest";

import {
  WorkflowIntakeService,
  createInMemoryIntakeAdapter,
  renderIntakeResult,
  type ExecutionApplication,
  type ExecutionRequest,
} from "../../src/index.js";

function application(requests: ExecutionRequest[]): ExecutionApplication {
  return Object.freeze({
    async start() {},
    async execute(request: ExecutionRequest) {
      requests.push(request);
      return Object.freeze({ kind: "START_UNCERTAIN" as const, worktree: request.worktree, deliveryId: "delivery-1" });
    },
    async inspect(worktree: string) { return Object.freeze({ kind: "RECOVERY" as const, worktree, deliveryId: "delivery-1", state: "RUNNING_CORRELATED" as const }); },
    async cancel(deliveryId: string) { return Object.freeze({ kind: "TERMINAL" as const, worktree: "/workspace", deliveryId, outcome: "CANCELLED" as const }); },
    status() { return Object.freeze({ state: "READY" as const }); },
    async close() {},
  });
}

describe("Wave 6 host-neutral Intake contract", () => {
  it("makes command and Intake-only tool create byte-for-meaning equivalent requests", async () => {
    const requests: ExecutionRequest[] = [];
    const service = new WorkflowIntakeService(Object.freeze({ application: application(requests) }));
    const command = createInMemoryIntakeAdapter(service, "command");
    const tool = createInMemoryIntakeAdapter(service, "intake-tool");
    const attachment = Object.freeze({
      identity: "attachment-1", filename: "evidence.txt", mediaType: "text/plain", byteLength: 3,
      digest: `sha256:${"a".repeat(64)}`, contentRef: "attachment-ref-1",
    });

    await command.invoke(Object.freeze({
      operation: "create", selector: "implementation-workflow@0.3.0", worktree: "/workspace",
      directive: "/wsr create implementation-workflow@0.3.0",
      turn: Object.freeze({ text: "/wsr create implementation-workflow@0.3.0\nimplement the task", attachments: Object.freeze([attachment]) }),
      correlation: "session-safe-1",
    }));
    await tool.invoke(Object.freeze({
      operation: "create", selector: "implementation-workflow@0.3.0", worktree: "/workspace",
      directive: "/workflow-execution",
      turn: Object.freeze({ text: "/workflow-execution\nimplement the task", attachments: Object.freeze([attachment]) }),
      correlation: "session-safe-1",
    }));

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toEqual({
      worktree: "/workspace",
      selector: "implementation-workflow@0.3.0",
      prompt: { text: "implement the task", attachments: [attachment] },
      intakeCorrelation: "session-safe-1",
    });
  });

  it("rejects native host values and exposes only the closed operation union", async () => {
    const service = new WorkflowIntakeService(Object.freeze({ application: application([]) }));
    await expect(service.invoke(Object.freeze({ operation: "resume", ctx: {} }) as never)).resolves.toMatchObject({ kind: "ERROR", code: "INTAKE_OPERATION_INVALID" });
    await expect(service.invoke(Object.freeze({
      operation: "create", selector: "implementation-workflow@0.3.0", worktree: "/workspace",
      directive: "/wsr create implementation-workflow@0.3.0",
      turn: Object.freeze({ text: "/wsr create implementation-workflow@0.3.0 task", attachments: Object.freeze([]), nativeSessionId: "secret" }),
      correlation: "safe",
    }) as never)).resolves.toMatchObject({ kind: "ERROR", code: "INTAKE_OPERATION_INVALID" });
    expect(WorkflowIntakeService.operations).toEqual(["list", "create", "recover", "status", "action-finish", "abandon"]);
  });

  it("renders only bounded public result fields", () => {
    const rendered = renderIntakeResult(Object.freeze({
      kind: "TERMINAL", worktree: "/workspace", deliveryId: "delivery-1", outcome: "FAILED",
      summary: "x".repeat(10_000), credential: "must-not-render", nativeSessionId: "must-not-render",
    }) as never, 256);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(256);
    expect(rendered).toContain("delivery-1");
    expect(rendered).not.toContain("credential");
    expect(rendered).not.toContain("nativeSessionId");
  });

  it("routes every closed control operation and rejects malformed operation-specific shapes", async () => {
    const calls: any[] = [];
    const app = application(calls);
    const control = Object.freeze({
      async list() { calls.push(["list"]); return []; },
      async recover(request: any) { calls.push(["recover", request]); return { kind: "RECOVERY" as const, worktree: request.worktree, deliveryId: request.deliveryId ?? "delivery-current", state: "BOUND" as const }; },
      async status(request: any) { calls.push(["status", request]); return { kind: "RECOVERY" as const, worktree: request.worktree ?? "/workspace", deliveryId: request.deliveryId ?? "delivery-current", state: "BOUND" as const }; },
      async finishAction(request: any) { calls.push(["finish", request]); return { kind: "RECOVERY" as const, worktree: "/workspace", deliveryId: "delivery-current", state: "RUNNING_CORRELATED" as const }; },
    });
    const service = new WorkflowIntakeService(Object.freeze({ application: app, control }));

    await expect(service.invoke({ operation: "list", correlation: "c" })).resolves.toEqual({ kind: "LIST", deliveries: [] });
    await service.invoke({ operation: "recover", worktree: "/workspace", correlation: "c" });
    await service.invoke({ operation: "recover", worktree: "/workspace", deliveryId: "delivery-1", correlation: "c" });
    await service.invoke({ operation: "status", correlation: "c" });
    await service.invoke({ operation: "status", worktree: "/workspace", deliveryId: "delivery-1", correlation: "c" });
    await service.invoke({ operation: "action-finish", correlation: "c" });
    await service.invoke({ operation: "action-finish", turn: { text: "final", attachments: [] }, correlation: "c" });
    await expect(service.invoke({ operation: "abandon", deliveryId: "delivery-1", correlation: "c" })).resolves.toMatchObject({ kind: "TERMINAL", deliveryId: "delivery-1" });
    expect(calls).toEqual([
      ["list"],
      ["recover", { worktree: "/workspace", correlation: "c" }],
      ["recover", { worktree: "/workspace", deliveryId: "delivery-1", correlation: "c" }],
      ["status", { correlation: "c" }],
      ["status", { worktree: "/workspace", deliveryId: "delivery-1", correlation: "c" }],
      ["finish", { correlation: "c" }],
      ["finish", { correlation: "c", prompt: { text: "final", attachments: [] } }],
    ]);

    const invalid: unknown[] = [
      null, [], Object.create({ operation: "list" }), { operation: "list", correlation: "" },
      { operation: "list", correlation: "c", extra: true },
      { operation: "create", selector: 1, worktree: "/workspace", directive: "/wsr", turn: { text: "/wsr x", attachments: [] }, correlation: "c" },
      { operation: "create", selector: "x", worktree: 1, directive: "/wsr", turn: { text: "/wsr x", attachments: [] }, correlation: "c" },
      { operation: "create", selector: "x", worktree: "/workspace", directive: "", turn: { text: "x", attachments: [] }, correlation: "c" },
      { operation: "create", selector: "x", worktree: "/workspace", directive: "/wsr", turn: { text: "different", attachments: [] }, correlation: "c" },
      { operation: "create", selector: "x", worktree: "/workspace", directive: "/wsr", turn: { text: "/wsr", attachments: "no" }, correlation: "c" },
      { operation: "recover", worktree: 1, correlation: "c" }, { operation: "recover", worktree: "/workspace", deliveryId: 1, correlation: "c" },
      { operation: "status", worktree: 1, correlation: "c" }, { operation: "status", deliveryId: 1, correlation: "c" },
      { operation: "action-finish", turn: { text: 1, attachments: [] }, correlation: "c" },
      { operation: "abandon", deliveryId: 1, correlation: "c" },
    ];
    for (const candidate of invalid) await expect(service.invoke(candidate as never)).resolves.toMatchObject({ kind: "ERROR", code: "INTAKE_OPERATION_INVALID" });

    const withoutControl = new WorkflowIntakeService(Object.freeze({ application: app }));
    for (const candidate of [
      { operation: "list", correlation: "c" }, { operation: "recover", worktree: "/workspace", correlation: "c" },
      { operation: "status", correlation: "c" }, { operation: "action-finish", correlation: "c" },
    ]) await expect(withoutControl.invoke(candidate as never)).resolves.toMatchObject({ kind: "ERROR", code: "INTAKE_CONTROL_UNAVAILABLE" });
    expect(() => renderIntakeResult({ kind: "ERROR", code: "X", message: "X" } as never, 127)).toThrow("INTAKE_RENDER_BOUND_INVALID");
    expect(renderIntakeResult({ kind: "LIST", deliveries: Array.from({ length: 100 }, () => ({ deliveryId: "x".repeat(100) })) } as never, 128)).toContain("OUTPUT_TRUNCATED");
  });
});
