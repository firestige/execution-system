import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ExecutionApplication,
  ExecutionRequest,
  ExecutionResult,
  TaskSelection,
  TaskPrompt,
} from "../../src/application/execution-application.js";

describe("host-neutral Execution application contract", () => {
  it("accepts only portable request data and returns a closed result union", () => {
    const request: ExecutionRequest = {
      worktree: "/workspace/repository-worktree",
      selector: "implementation@latest",
      prompt: {
        text: "implement the approved change",
        attachments: [],
      },
      refresh: false,
      intakeCorrelation: "command:42",
    };

    expect(Object.keys(request).sort()).toEqual([
      "intakeCorrelation",
      "prompt",
      "refresh",
      "selector",
      "worktree",
    ]);
    expectTypeOf<ExecutionApplication["execute"]>().parameter(0).toEqualTypeOf<ExecutionRequest>();
    expectTypeOf<ExecutionRequest["prompt"]>().toEqualTypeOf<TaskPrompt>();
    expectTypeOf<Awaited<ReturnType<ExecutionApplication["execute"]>>>().toEqualTypeOf<ExecutionResult>();
  });

  it("models Task identity choice independently from the TaskPrompt", () => {
    const createNew: TaskSelection = { mode: "NEW_TASK", displayName: "Token tuning" };
    const reuse: TaskSelection = { mode: "REUSE_TASK", taskId: "task-existing" };

    expect(createNew).toEqual({ mode: "NEW_TASK", displayName: "Token tuning" });
    expect(reuse).toEqual({ mode: "REUSE_TASK", taskId: "task-existing" });
    expectTypeOf<ExecutionRequest["taskSelection"]>().toEqualTypeOf<
      TaskSelection | undefined
    >();
  });

  it("keeps lifecycle and inspection surfaces host-neutral", () => {
    expectTypeOf<ExecutionApplication>().toMatchTypeOf<{
      start(): Promise<void>;
      execute(request: ExecutionRequest): Promise<ExecutionResult>;
      inspect(worktree: string): Promise<ExecutionResult>;
      cancel(deliveryId: string): Promise<ExecutionResult>;
      status(): Readonly<{ state: string }>;
      close(): Promise<void>;
    }>();
  });
});
