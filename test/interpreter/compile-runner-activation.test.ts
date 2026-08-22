import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../src/contracts/index.js";
import { compileRunnerActivation } from "../../src/interpreter/compile-runner-activation.js";
import type { RunnerActivationContext } from "../../src/contracts/index.js";
import { mutatedRunnerActivation } from "../support/runner-activation-fixtures.js";

function compilableActivation(mutate: (draft: any) => void = () => {}): RunnerActivationContext {
  return mutatedRunnerActivation((draft) => {
    mutate(draft);
    for (const executor of Object.values(draft.program.execution.agents) as any[]) {
      executor.sessionCompatibilityIdentity = canonicalDigest(executor.session);
      executor.bindingIdentity = canonicalDigest({ session: executor.session, turn: executor.turn });
    }
  });
}

function expectCompileError(
  activation: RunnerActivationContext,
  code: string,
): void {
  expect(compileRunnerActivation(activation)).toMatchObject({ ok: false, error: { code } });
}

describe("compileRunnerActivation", () => {
  it("compiles a fully admitted activation into deterministic frozen lookup indexes", () => {
    const activation = compilableActivation();

    const first = compileRunnerActivation(activation);
    const second = compileRunnerActivation(activation);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "runner.compiled-activation@1.0.0",
        activationBindingIdentity: activation.bindingIdentity,
        plan: {
          control: {
            entryNode: "node.action",
            ordinarySuccessor: { "node.action": "terminal.success" },
          },
          execution: {
            sites: {
              "node:node.action": activation.program.execution.sites[0],
            },
            agentInvocations: {
              "node:node.action": {
                actionIdentity: "action.fixture",
                executorIdentity: "executor.fixture",
              },
            },
          },
          dataflow: {
            incomingBySite: {},
            incomingByControl: {},
            outgoingByProducer: {},
          },
        },
      },
    });
    if (first.ok) {
      expect(first.value.initial).toBe(activation.initial);
      expect(first.value.correlation).toBe(activation.correlation);
      expect(first.value.plan.execution.actions["action.fixture" as keyof typeof first.value.plan.execution.actions]).toBe(
        activation.program.execution.actions["action.fixture" as keyof typeof activation.program.execution.actions],
      );
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.value)).toBe(true);
      expect(Object.isFrozen(first.value.plan.execution.agentInvocations)).toBe(true);
      expect(first.value.compileIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Object.values(first.value.plan.execution.agentInvocations)[0]?.bindingIdentity).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
    }
  });

  it("normalizes event successors and typed dataflow indexes with stable edge identities", () => {
    const activation = compilableActivation((draft) => {
      draft.program.control.eventSuccessor = [
        { id: "event.cancel", from: "node.action", event: "cancelled", to: "terminal.success" },
      ];
      draft.program.control.nodes.push({ id: "node.wait", kind: "wait", wait: "approval", continuationSource: true });
      draft.program.control.decisions.push({
        identity: "decision.resume",
        source: { kind: "control-result", controlIdentity: "control.approval", slot: { kind: "whole" } },
        selector: { kind: "case-map", cases: [{ value: true, target: "terminal.success" }] },
      });
      draft.program.control.controls.push({
        identity: "control.approval",
        nodeIdentity: "node.wait",
        kind: "user",
        resultSchema: {},
        correlation: { identitySource: "deliveryIdentity", staleRejected: true, duplicateRejected: true },
        expiry: { mode: "incomplete", maxRenewals: 0 },
        resumeDecision: "decision.resume",
      });
      draft.program.dataflow.edges = [
        {
          source: { kind: "context", field: "deliveryIdentity" },
          target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "property", name: "delivery" } },
        },
        {
          source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "property", name: "answer" } },
          target: { kind: "state", field: "answer" },
        },
        {
          source: { kind: "control-result", controlIdentity: "control.approval", slot: { kind: "whole" } },
          target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.action" }, slot: { kind: "property", name: "approval" } },
        },
      ];
    });

    const result = compileRunnerActivation(activation);

    expect(result).toMatchObject({
      ok: true,
      value: {
        plan: {
          control: { eventSuccessor: { "node.action": { cancelled: "terminal.success" } } },
          dataflow: {
            incomingBySite: { "node:node.action": [{}, {}] },
            incomingByControl: {},
            outgoingByProducer: {
              "node:node.action": [{}],
              "control:control.approval": [{}],
            },
          },
        },
      },
    });
    if (result.ok) {
      const edges = result.value.plan.dataflow.incomingBySite[Object.keys(result.value.plan.dataflow.incomingBySite)[0] as keyof typeof result.value.plan.dataflow.incomingBySite];
      expect(edges?.every((edge) => /^sha256:[a-f0-9]{64}$/.test(edge.identity))).toBe(true);
    }
  });

  it("rejects invalid control closure without throwing or inventing targets", () => {
    expectCompileError(
      compilableActivation((draft) => {
        draft.program.control.entryNode = "node.missing";
      }),
      "CONTROL_CLOSURE_INVALID",
    );
    expectCompileError(
      compilableActivation((draft) => {
        draft.program.control.nodes.push(structuredClone(draft.program.control.nodes[0]));
      }),
      "CONTROL_CLOSURE_INVALID",
    );
    expectCompileError(
      compilableActivation((draft) => {
        draft.program.control.ordinarySuccessor[0].to = "node.missing";
      }),
      "CONTROL_CLOSURE_INVALID",
    );
  });

  it("rejects unresolved or duplicate execution sites and incomplete structured capability", () => {
    expectCompileError(
      compilableActivation((draft) => {
        draft.program.execution.sites.push(structuredClone(draft.program.execution.sites[0]));
      }),
      "EXECUTION_CLOSURE_INVALID",
    );
    expectCompileError(
      compilableActivation((draft) => {
        draft.program.execution.sites[0].site.nodeIdentity = "node.missing";
      }),
      "EXECUTION_CLOSURE_INVALID",
    );
    expectCompileError(
      compilableActivation((draft) => {
        draft.program.execution.sites[0].executor.requiredCapabilities = [];
      }),
      "UNSUPPORTED_CAPABILITY",
    );
  });

  it("rejects stale session identities and dataflow closure failures", () => {
    expectCompileError(
      mutatedRunnerActivation(() => {}),
      "SESSION_BINDING_INVALID",
    );
    expectCompileError(
      compilableActivation((draft) => {
        draft.program.dataflow.edges = [{
          source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.missing" }, slot: { kind: "whole" } },
          target: { kind: "state", field: "answer" },
        }];
      }),
      "DATAFLOW_CLOSURE_INVALID",
    );
  });

  it("returns a closed binding error when the admitted activation identity is stale", () => {
    const activation = compilableActivation();
    const stale = Object.freeze({ ...activation, bindingIdentity: `sha256:${"0".repeat(64)}` }) as RunnerActivationContext;
    expectCompileError(stale, "BINDING_MISMATCH");
  });

  it("compiles declared parallel branch and join sites without choosing a runtime path", () => {
    const activation = compilableActivation((draft) => {
      draft.program.control.nodes = [{
        id: "node.parallel",
        kind: "parallel",
        branches: [{ id: "branch.review", action: "action.fixture", required: true }],
        maxConcurrency: 1,
        join: { action: "action.join" },
      }];
      draft.program.control.entryNode = "node.parallel";
      draft.program.control.ordinarySuccessor[0].from = "node.parallel";
      draft.program.execution.actions["action.join"] = {
        identity: "action.join", purpose: "aggregate", inputSchema: { kind: "ABSENT" }, resultSchema: {}, gate: { freeTextBypass: "prohibited" },
      };
      draft.program.execution.hostOperations["host.aggregate"] = {
        identity: "host.aggregate", contractIdentity: "host-contract.aggregate", configuration: {}, requiredCapabilities: ["deterministic-transformation"],
      };
      draft.program.execution.sites = [
        {
          site: { kind: "parallel-branch", nodeIdentity: "node.parallel", branchIdentity: "branch.review" },
          actionIdentity: "action.fixture",
          executor: { kind: "agent", identity: "executor.fixture", requiredCapabilities: ["structured-completion"] },
        },
        {
          site: { kind: "parallel-join", nodeIdentity: "node.parallel" },
          actionIdentity: "action.join",
          executor: { kind: "host-operation", identity: "host.aggregate" },
        },
      ];
    });

    const result = compileRunnerActivation(activation);

    expect(result).toMatchObject({
      ok: true,
      value: { plan: { execution: {
        sites: {
          "parallel-branch:node.parallel:branch.review": {},
          "parallel-join:node.parallel": {},
        },
        agentInvocations: { "parallel-branch:node.parallel:branch.review": {} },
      } } },
    });
    if (result.ok) {
      expect(result.value.plan.control.nodes["node.parallel" as keyof typeof result.value.plan.control.nodes]).toBe(
        activation.program.control.nodes[0],
      );
    }
  });

  it("binds invocation identity to the full admitted Action authority", () => {
    const first = compileRunnerActivation(compilableActivation());
    const second = compileRunnerActivation(compilableActivation((draft) => {
      draft.program.execution.actions["action.fixture"].purpose = "changed admitted authority";
    }));
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(Object.values(first.value.plan.execution.agentInvocations)[0]?.bindingIdentity).not.toBe(
        Object.values(second.value.plan.execution.agentInvocations)[0]?.bindingIdentity,
      );
    }
  });

  it.each([
    ["duplicate terminal", (draft: any) => draft.program.control.terminals.push(structuredClone(draft.program.control.terminals[0]))],
    ["unresolved ordinary source", (draft: any) => { draft.program.control.ordinarySuccessor[0].from = "node.missing"; }],
    ["duplicate ordinary source", (draft: any) => draft.program.control.ordinarySuccessor.push({ id: "edge.again", from: "node.action", to: "terminal.success" })],
    ["unresolved event source", (draft: any) => draft.program.control.eventSuccessor.push({ id: "event.bad", from: "node.missing", event: "cancelled", to: "terminal.success" })],
    ["duplicate event", (draft: any) => draft.program.control.eventSuccessor.push(
      { id: "event.one", from: "node.action", event: "cancelled", to: "terminal.success" },
      { id: "event.two", from: "node.action", event: "cancelled", to: "terminal.success" },
    )],
    ["duplicate decision", (draft: any) => draft.program.control.decisions.push(
      { identity: "decision.same", source: { kind: "state", field: "x" } },
      { identity: "decision.same", source: { kind: "state", field: "y" } },
    )],
    ["empty selector", (draft: any) => draft.program.control.decisions.push({ identity: "decision.empty", source: { kind: "state", field: "x" }, selector: { kind: "case-map", cases: [] } })],
    ["unknown selector target", (draft: any) => draft.program.control.decisions.push({ identity: "decision.bad", source: { kind: "state", field: "x" }, selector: { kind: "case-map", cases: [{ value: true, target: "node.missing" }] } })],
    ["duplicate control", (draft: any) => draft.program.control.controls.push(
      { identity: "control.same", nodeIdentity: "node.action", kind: "user", resultSchema: {}, correlation: { identitySource: "x", staleRejected: true, duplicateRejected: true }, expiry: { mode: "incomplete", maxRenewals: 0 }, resumeDecision: "decision.none" },
      { identity: "control.same", nodeIdentity: "node.action", kind: "user", resultSchema: {}, correlation: { identitySource: "x", staleRejected: true, duplicateRejected: true }, expiry: { mode: "incomplete", maxRenewals: 0 }, resumeDecision: "decision.none" },
    )],
    ["control at Action node", (draft: any) => draft.program.control.controls.push({ identity: "control.bad", nodeIdentity: "node.action", kind: "user", resultSchema: {}, correlation: { identitySource: "x", staleRejected: true, duplicateRejected: true }, expiry: { mode: "incomplete", maxRenewals: 0 }, resumeDecision: "decision.none" })],
  ])("rejects control closure: %s", (_label, mutate) => {
    expectCompileError(compilableActivation(mutate), "CONTROL_CLOSURE_INVALID");
  });

  it("compiles a Host-operation selector only when its closed operation exists", () => {
    const valid = compilableActivation((draft) => {
      draft.program.execution.hostOperations["host.select"] = { identity: "host.select", contractIdentity: "host-contract.select", configuration: {}, requiredCapabilities: ["deterministic-selection"] };
      draft.program.control.decisions.push({ identity: "decision.select", source: { kind: "state", field: "choice" }, selector: { kind: "host-operation", operationIdentity: "host.select", allowedTargets: ["terminal.success"] } });
    });
    expect(compileRunnerActivation(valid)).toMatchObject({ ok: true });
    expectCompileError(compilableActivation((draft) => {
      draft.program.control.decisions.push({ identity: "decision.select", source: { kind: "state", field: "choice" }, selector: { kind: "host-operation", operationIdentity: "host.missing", allowedTargets: ["terminal.success"] } });
    }), "EXECUTION_CLOSURE_INVALID");
  });

  it.each([
    ["Action key mismatch", (draft: any) => { draft.program.execution.actions["action.fixture"].identity = "action.other"; }],
    ["executor key mismatch", (draft: any) => { draft.program.execution.agents["executor.fixture"].identity = "executor.other"; }],
    ["site Action mismatch", (draft: any) => { draft.program.execution.sites[0].actionIdentity = "action.other"; }],
    ["missing Action", (draft: any) => { delete draft.program.execution.actions["action.fixture"]; }],
    ["missing executor", (draft: any) => { delete draft.program.execution.agents["executor.fixture"]; }],
    ["missing declared site", (draft: any) => { draft.program.execution.sites = []; }],
  ])("rejects execution closure: %s", (_label, mutate) => {
    expectCompileError(compilableActivation(mutate), "EXECUTION_CLOSURE_INVALID");
  });

  it("rejects mismatched and missing Host operation execution bindings", () => {
    expectCompileError(compilableActivation((draft) => {
      draft.program.execution.hostOperations["host.fixture"] = { identity: "host.other", contractIdentity: "host-contract.fixture", configuration: {}, requiredCapabilities: [] };
    }), "EXECUTION_CLOSURE_INVALID");
    expectCompileError(compilableActivation((draft) => {
      draft.program.execution.sites[0].executor = { kind: "host-operation", identity: "host.missing" };
    }), "EXECUTION_CLOSURE_INVALID");
  });

  it("rejects capability mismatch even when structured completion is also required", () => {
    expectCompileError(compilableActivation((draft) => {
      draft.program.execution.sites[0].executor.requiredCapabilities = ["structured-completion", "action-interaction"];
    }), "UNSUPPORTED_CAPABILITY");
  });

  it.each([
    ["unresolved source control", (draft: any) => { draft.program.control.decisions.push({ identity: "decision.data", source: { kind: "control-result", controlIdentity: "control.missing", slot: { kind: "whole" } } }); }],
    ["unresolved target site", (draft: any) => { draft.program.dataflow.edges = [{ source: { kind: "state", field: "x" }, target: { kind: "site-input", site: { kind: "node", nodeIdentity: "node.missing" }, slot: { kind: "whole" } } }]; }],
    ["unresolved target control", (draft: any) => { draft.program.dataflow.edges = [{ source: { kind: "state", field: "x" }, target: { kind: "control-input", controlIdentity: "control.missing", slot: { kind: "whole" } } }]; }],
    ["duplicate sink", (draft: any) => { const edge = { source: { kind: "state", field: "x" }, target: { kind: "state", field: "same" } }; draft.program.dataflow.edges = [edge, structuredClone(edge)]; }],
    ["unresolved data-bound source", (draft: any) => { draft.program.execution.agents["executor.fixture"].session.policy.scope = { kind: "data-bound", source: { kind: "site-result", site: { kind: "node", nodeIdentity: "node.missing" }, slot: { kind: "whole" } } }; }],
  ])("rejects dataflow closure: %s", (_label, mutate) => {
    expectCompileError(compilableActivation(mutate), "DATAFLOW_CLOSURE_INVALID");
  });

  it("returns a deeply frozen closed activation error for malformed input", () => {
    const result = compileRunnerActivation(Object.freeze({}) as RunnerActivationContext);
    expect(result).toMatchObject({ ok: false, error: { code: "ACTIVATION_INVALID" } });
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) expect(Object.isFrozen(result.error.detail)).toBe(true);
  });

  it("rejects a parallel selection source whose producing site is outside the static site closure", () => {
    const activation = compilableActivation((draft) => {
      draft.program.control.nodes = [{
        id: "node.parallel",
        kind: "parallel",
        branches: [{ id: "branch.review", action: "action.fixture", required: true }],
        maxConcurrency: 1,
        selection: {
          source: {
            kind: "site-result",
            site: { kind: "node", nodeIdentity: "node.missing" },
            slot: { kind: "whole" },
          },
        },
        join: { kind: "collect" },
      }];
      draft.program.control.entryNode = "node.parallel";
      draft.program.control.ordinarySuccessor[0].from = "node.parallel";
      draft.program.execution.sites[0].site = {
        kind: "parallel-branch",
        nodeIdentity: "node.parallel",
        branchIdentity: "branch.review",
      };
    });

    expectCompileError(activation, "DATAFLOW_CLOSURE_INVALID");
  });

  it("rejects an executor binding identity that does not cover its admitted session and turn", () => {
    const activation = mutatedRunnerActivation((draft) => {
      const executor = draft.program.execution.agents["executor.fixture"];
      executor.sessionCompatibilityIdentity = canonicalDigest(executor.session);
      executor.bindingIdentity = `sha256:${"0".repeat(64)}`;
    });

    expectCompileError(activation, "SESSION_BINDING_INVALID");
  });
});
