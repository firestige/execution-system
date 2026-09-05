import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("current-source browser qualification authority", () => {
  it("requires a caller-owned exact selector for composition and keeps diagnostics non-composition", async () => {
    const { parseCurrentSourceBrowserQualificationArguments } = await import("../../scripts/current-source-browser-qualification.js");
    const base = ["https://dsh.example.test", "/tmp/workspace", "https://evidence.example.test"];

    expect(parseCurrentSourceBrowserQualificationArguments([...base, "evidence-studio", "implementation-workflow@0.4.6"]))
      .toEqual({ scenario: "evidence-studio", evidenceKind: "composition", workflowSelector: "implementation-workflow@0.4.6" });
    expect(() => parseCurrentSourceBrowserQualificationArguments([...base, "evidence-studio"]))
      .toThrowError("CURRENT_SOURCE_EXACT_SELECTOR_REQUIRED");
    expect(() => parseCurrentSourceBrowserQualificationArguments([...base, "evidence-studio", "implementation-workflow@latest"]))
      .toThrowError("CURRENT_SOURCE_EXACT_SELECTOR_INVALID");
    expect(() => parseCurrentSourceBrowserQualificationArguments([...base, "evidence-studio", "implementation-workflow"]))
      .toThrowError("CURRENT_SOURCE_EXACT_SELECTOR_INVALID");

    expect(parseCurrentSourceBrowserQualificationArguments([...base, "diagnostic"]))
      .toEqual({ scenario: "diagnostic", evidenceKind: "diagnostic-non-composition" });
    expect(parseCurrentSourceBrowserQualificationArguments([...base, "diagnostic", "hello-world-workflow@0.2.0"]))
      .toEqual({
        scenario: "diagnostic", evidenceKind: "diagnostic-non-composition",
        diagnosticSelector: "hello-world-workflow@0.2.0",
      });
  });

  it("uses the parsed caller selector in evidence-studio instead of a hardcoded workflow", async () => {
    const source = await readFile(path.resolve(import.meta.dirname, "../../scripts/qualify-current-source-browser.ts"), "utf8");

    expect(source).toContain("parseCurrentSourceBrowserQualificationArguments(process.argv.slice(2))");
    expect(source).toContain("/wsr create ${qualification.workflowSelector}");
    expect(source).not.toContain("/wsr create hello-world-workflow@0.2.0");
  });
});
