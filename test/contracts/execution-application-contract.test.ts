import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ExecutionApplication,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/application/execution-application.js";

describe("host-neutral Execution application contract", () => {
  it("accepts only portable request data and returns a closed result union", () => {
    const request: ExecutionRequest = {
      worktree: "/workspace/repository-worktree",
      selector: "implementation@latest",
      taskIntent: "implement the approved change",
      refresh: false,
      intakeCorrelation: "command:42",
    };

    expect(Object.keys(request).sort()).toEqual([
      "intakeCorrelation",
      "refresh",
      "selector",
      "taskIntent",
      "worktree",
    ]);
    expectTypeOf<ExecutionApplication["execute"]>().parameter(0).toEqualTypeOf<ExecutionRequest>();
    expectTypeOf<Awaited<ReturnType<ExecutionApplication["execute"]>>>().toEqualTypeOf<ExecutionResult>();
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
