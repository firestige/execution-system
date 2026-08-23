import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";

import {
  boundaryViolations,
  importsFromSource,
  staticBoundaryMain,
  type SourceImport,
} from "../../scripts/static-boundary-check.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");

function source(from: string, ...imports: string[]): SourceImport {
  return { from, imports };
}

describe("static dependency boundary", () => {
  it("G06 production composition does not import the raw minimal corpus or test-side admission builder", () => {
    const sourceRoot = path.join(projectRoot, "src");
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(directory, entry.name);
      return entry.isDirectory() ? files(child) : entry.name.endsWith(".ts") ? [child] : [];
    });
    const production = files(sourceRoot).map((filename) => readFileSync(filename, "utf8")).join("\n");
    expect(production).not.toContain("workflow-dsl/examples/minimal");
    expect(production).not.toContain("test/support/wave4");
  });

  it("G00-R4-ALLOW accepts the frozen acyclic caller direction", () => {
    expect(boundaryViolations([
      source("src/coordinator/run.ts", "../host/run.js", "../invocation/cancel.js", "../custody/retire.js"),
      source("src/host/run.ts", "../invocation/run.js", "../custody/savepoint.js"),
      source("src/invocation/run.ts", "../custody/authorized-handle.js"),
      source("src/interpreter/compile.ts", "../contracts/constructed-activation.js"),
      source("src/composition/root.ts", "../interpreter/compile.js", "../coordinator/run.js"),
    ])).toEqual([]);
  });

  it("G06-STATIC-COMPOSITION permits only the RunnerFactory root to assemble every owning lane", () => {
    expect(boundaryViolations([
      source(
        "src/composition/runner-factory.ts",
        "../interpreter/compile-runner-activation.js",
        "../coordinator/runner-coordinator.js",
        "../host/index.js",
        "../invocation/index.js",
        "../custody/git-custody.js",
      ),
    ])).toEqual([]);

    expect(boundaryViolations([
      source("src/host/run.ts", "../composition/runner-factory.js"),
      source("src/invocation/run.ts", "../composition/runner-factory.js"),
      source("src/custody/run.ts", "../composition/runner-factory.js"),
    ])).toEqual([
      "src/host/run.ts cannot import composition",
      "src/invocation/run.ts cannot import composition",
      "src/custody/run.ts cannot import composition",
    ]);
  });

  it("G00-R4-REVERSE rejects Host to Interpreter and Invocation to Host imports", () => {
    expect(boundaryViolations([
      source("src/host/run.ts", "../interpreter/compile.js"),
      source("src/invocation/run.ts", "../host/run.js"),
    ])).toEqual([
      "src/host/run.ts cannot import runtime/interpreter",
      "src/invocation/run.ts cannot import runtime/host",
    ]);
  });

  it("G00-R4-ADAPTER rejects Provider Adapter authority imports", () => {
    expect(boundaryViolations([
      source("src/providers/dsh/adapter.ts", "../../coordinator/run.js", "../../host/run.js", "../../custody/handle.js"),
    ])).toEqual([
      "src/providers/dsh/adapter.ts cannot import runtime/coordinator",
      "src/providers/dsh/adapter.ts cannot import runtime/host",
      "src/providers/dsh/adapter.ts cannot import runtime/custody",
    ]);
  });

  it("G00-R4-FIXTURE rejects production imports of test support or fixtures", () => {
    expect(boundaryViolations([
      source("src/composition/root.ts", "../../test/support/activation-fixtures.js", "../../fixtures/activation/valid.js"),
    ])).toEqual([
      "src/composition/root.ts cannot import test support",
      "src/composition/root.ts cannot import fixtures",
    ]);
  });

  it("G00-R4-FOUNDATION rejects contracts/shared depending on Runtime modules", () => {
    expect(boundaryViolations([
      source("src/contracts/result.ts", "../coordinator/run.js"),
      source("src/shared/identity.ts", "../custody/state.js"),
    ])).toEqual([
      "src/contracts/result.ts cannot import runtime/coordinator",
      "src/shared/identity.ts cannot import runtime/custody",
    ]);
  });

  it("G00-R4-CLI typechecks and scans the current source tree", () => {
    expect(staticBoundaryMain(projectRoot)).toBe(0);
  });

  it("G00-R4-LAYOUT rejects a second src/runtime hierarchy", () => {
    expect(boundaryViolations([
      source("src/runtime/host/run.ts"),
      source("src/runtime/invocation/providers/dsh.ts"),
    ])).toEqual([
      "src/runtime/host/run.ts must use the frozen src/<lane> layout",
      "src/runtime/invocation/providers/dsh.ts must use the frozen src/<lane> layout",
    ]);
  });

  it("G00-R4-DYNAMIC includes static, dynamic, and require-style local dependencies", () => {
    expect(importsFromSource(`
      import { one } from "../one.js";
      export * from "../two.js";
      const three = await import("../three.js");
      const four = require("../four.js");
    `)).toEqual(["../one.js", "../two.js", "../three.js", "../four.js"]);
  });

  it("replacement G00 enforces the frozen shared-contract import DAG", () => {
    expect(boundaryViolations([
      source("src/contracts/generated/workflow-contract.ts", "../runner-activation.js"),
      source("src/contracts/compiler.ts", "./host-capability.js"),
      source("src/contracts/runner-activation.ts", "./generated/workflow-contract.js", "./primitives.js"),
    ])).toEqual([
      "src/contracts/generated/workflow-contract.ts cannot import contract/runner-activation",
      "src/contracts/compiler.ts cannot import contract/host-capability",
    ]);
  });
});
