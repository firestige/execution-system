import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  KnownOwnerRetirementDisposition,
  OwnerRetirementDisposition,
  RetirementAuthorizationRef,
  TerminalSettlementRecord,
} from "../../src/contracts/index.js";

const contractSource = (name: string): string =>
  readFileSync(path.resolve(import.meta.dirname, `../../src/contracts/${name}`), "utf8");

describe("replacement G00 retirement and settlement boundary", () => {
  it("models retirement as an owner fact rather than a writable ledger reference", () => {
    const authorization = {
      identity: "retirement-authorization.test",
      delivery: {
        deliveryIdentity: "delivery.test",
        manifestBindingIdentity: `sha256:${"1".repeat(64)}`,
        activationBindingIdentity: `sha256:${"2".repeat(64)}`,
      },
    } as unknown as RetirementAuthorizationRef;
    const disposition: OwnerRetirementDisposition = {
      owner: "custody",
      authorization,
      state: "retired",
    };

    expect(disposition).toEqual({ owner: "custody", authorization, state: "retired" });
    expect(contractSource("lifecycle-records.ts")).not.toContain("OwnerRetirementDispositionRef");
    expect(contractSource("primitives.ts")).not.toContain("OwnerRetirementDispositionId");
  });

  it("allows an immutable settlement only after all four owner dispositions are known", () => {
    type SettlementRetirements = TerminalSettlementRecord["ownerRetirements"];
    const authorization = {} as RetirementAuthorizationRef;
    const ownerRetirements: SettlementRetirements = [
      { owner: "coordinator", authorization, state: "retired" },
      { owner: "host", authorization, state: "retired" },
      { owner: "invocation", authorization, state: "retained-for-recovery" },
      { owner: "custody", authorization, state: "retired" },
    ];
    const known: KnownOwnerRetirementDisposition = ownerRetirements[0];
    const unknownCustody: OwnerRetirementDisposition<"custody"> = {
      owner: "custody",
      authorization,
      state: "unknown",
      uncertainty: { state: "unknown", owner: "custody", reason: "CALL_INTERRUPTED" },
    };
    const invalidOwnerRetirements: SettlementRetirements = [
      { owner: "coordinator", authorization, state: "retired" },
      { owner: "host", authorization, state: "retired" },
      { owner: "invocation", authorization, state: "retired" },
      // @ts-expect-error an unknown owner disposition cannot enter immutable settlement
      unknownCustody,
    ];

    expect(known.state).not.toBe("unknown");
    expect(invalidOwnerRetirements[3].state).toBe("unknown");
    expect(ownerRetirements.map((item) => item.owner)).toEqual([
      "coordinator",
      "host",
      "invocation",
      "custody",
    ]);
    const lifecycle = contractSource("lifecycle-records.ts");
    expect(lifecycle).toContain("ownerRetirements");
    expect(lifecycle).not.toContain("ownerDispositionRefs");
    expect(lifecycle).not.toContain("auditCorrelation");
  });

  it("keeps Observation and audit storage out of owner retirement capabilities", () => {
    for (const file of ["custody-capability.ts", "invocation-capability.ts", "host-capability.ts"]) {
      const source = contractSource(file);
      expect(source).not.toMatch(/Observation|Audit|DispositionRef|dispositionRef/);
    }
  });
});
