import { describe, expect, it } from "vitest";

import { createRunnerOwnerFactPort, type RunnerSettlementOwnerFactIngress } from "../../src/observation/index.js";

describe("#86 M02 one-way owner-fact port", () => {
  it("maps the frozen Runner terminal callback to a closed correlated M02 owner fact", async () => {
    const facts: unknown[] = [];
    const port = createRunnerOwnerFactPort(Object.freeze({ emit: (fact: Parameters<RunnerSettlementOwnerFactIngress["emit"]>[0]) => facts.push(fact) }));
    await port.observe(Object.freeze({
      kind: "runner-terminal-settled",
      delivery: Object.freeze({
        deliveryIdentity: "delivery-1",
        manifestBindingIdentity: `sha256:${"a".repeat(64)}`,
        activationBindingIdentity: `sha256:${"b".repeat(64)}`,
      }),
      settlementIdentity: "settlement-1",
    }) as never);

    expect(facts).toEqual([expect.objectContaining({
      schemaVersion: "execution.observation-owner-fact@1.0.0",
      owner: "M02",
      phase: "RUNNER_TERMINAL_SETTLED",
      signal: "runner-settlement",
      identity: "settlement-1",
      contentIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      correlation: {
        deliveryId: "delivery-1",
        manifestBindingIdentity: `sha256:${"a".repeat(64)}`,
        activationBindingIdentity: `sha256:${"b".repeat(64)}`,
      },
    })]);
  });

  it("contains a synchronous M03 ingress failure", async () => {
    const port = createRunnerOwnerFactPort(Object.freeze({ emit() { throw new Error("non-controlling"); } }));
    await expect(port.observe(Object.freeze({
      kind: "runner-terminal-settled",
      delivery: Object.freeze({ deliveryIdentity: "delivery-1", manifestBindingIdentity: `sha256:${"a".repeat(64)}`, activationBindingIdentity: `sha256:${"b".repeat(64)}` }),
      settlementIdentity: "settlement-1",
    }) as never)).resolves.toBeUndefined();
  });
});
