import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXECUTION_RUNTIME_ADAPTER_VERSION, type ExecutionRuntimeAdapter } from "../../src/execution/runtime-adapter.js";

describe("Execution-owned Runtime Adapter projection", () => {
  it("is a unique real TypeScript import surface with no public resume operation", () => {
    const file = path.resolve(import.meta.dirname, "../../src/execution/runtime-adapter.ts");
    const source = readFileSync(file, "utf8");
    expect(source).toContain("export interface ExecutionRuntimeAdapter");
    expect(source).not.toMatch(/\bresume\s*\(/);
  });

  it("exposes only execute, inspect, and cancel to Execution", () => {
    type Keys = keyof ExecutionRuntimeAdapter;
    const keys: readonly Keys[] = ["execute", "inspect", "cancel"];
    expect(keys).toEqual(["execute", "inspect", "cancel"]);
    expect(EXECUTION_RUNTIME_ADAPTER_VERSION).toBe("execution.runtime-adapter@1.0.0");
  });
});
