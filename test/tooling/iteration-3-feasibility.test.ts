import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  probeCordisIsolation,
  probeDshBundleLoader,
  probeDshSkillFilesystem,
} from "../support/iteration-3/dsh-feasibility.js";

describe("Iteration 3 locked DSH feasibility", () => {
  it("loads the package-declared bundle through the real DSH profile composer", () => {
    const composed = probeDshBundleLoader();

    expect(composed.packageVersion).toBe("0.1.1-rc.2");
    expect(composed.profileBundles).toContain("@workflow-self-recursive/dsh-intake-feasibility");
    expect(composed.row).toEqual({
      id: "workflow-execution",
      name: "@workflow-self-recursive/dsh-intake-feasibility",
      config: { configPath: "/tmp/execution-config.yaml" },
    });
  });

  it("discovers and loads an explicit package skill with the locked filesystem provider", async () => {
    const skill = await probeDshSkillFilesystem();

    expect(skill.packageVersion).toBe("0.1.1-rc.2");
    expect(skill.summary.name).toBe("workflow-execution");
    expect(skill.summary.invocation).toEqual({ modelInvocable: false, userInvocable: true });
    expect(skill.content).toContain("workflow_execution_activate");
    expect(skill.content).toContain("exactly once");
  });

  it("discovers the production skill root and loads only the frozen Intake tool instruction", async () => {
    const skill = await probeDshSkillFilesystem(path.resolve(import.meta.dirname, "../../packages/dsh-intake/skills"));

    expect(skill.summary).toEqual({ name: "workflow-execution", invocation: { modelInvocable: false, userInvocable: true } });
    expect(skill.content).toContain("workflow_execution_intake");
    expect(skill.content.match(/workflow_execution_intake/gu)).toHaveLength(1);
    expect(skill.content).toContain("exactly once");
    expect(skill.content).not.toMatch(/(?:import\s|require\(|RunnerFactory|DSH-E service|Package validation bypass)/u);
  });

  it("proves Cordis isolate is a service realm inside one Context, not a second runtime instance", async () => {
    const observation = await probeCordisIsolation();

    expect(observation.packageVersion).toBe("4.0.1");
    expect(observation.isolatedSharesRoot).toBe(true);
    expect(observation.independentSharesRoot).toBe(false);
    expect(observation.parentService).toBe("intake");
    expect(observation.isolatedService).toBeUndefined();
    expect(observation.independentService).toBeUndefined();
    expect(observation.intakeToolVisible).toBe(true);
    expect(observation.executionToolVisible).toBe(false);
    expect(observation.activationCalls).toBe(1);
  });
});
