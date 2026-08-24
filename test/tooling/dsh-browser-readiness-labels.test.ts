import { describe, expect, it } from "vitest";

import {
  isBlockingPromptDismissalLabel,
  isWorkspacePickerLabel,
} from "../../scripts/qualify-dsh-interactive-intake.js";

describe("DSH browser readiness labels", () => {
  it("recognizes the provider onboarding dismissal label used by the pinned DSH Web client", () => {
    expect(isBlockingPromptDismissalLabel("Configure later")).toBe(true);
    expect(isBlockingPromptDismissalLabel("Save and continue")).toBe(false);
  });

  it("recognizes the workspace picker label used by the pinned DSH Web client", () => {
    expect(isWorkspacePickerLabel("Choose workspace")).toBe(true);
    expect(isWorkspacePickerLabel("Standard mode")).toBe(false);
  });
});
