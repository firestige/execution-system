import { describe, expect, it, vi } from "vitest";

import { DeliveryAgentProviderRealmBroker as DshExportedBroker } from "../../../src/providers/dsh/index.js";
import {
  AgentProviderFactoryRegistry,
  DeliveryAgentProviderRealmBroker,
  type AgentProviderRealmFactory,
} from "../../../src/providers/provider.js";

describe("DSH Delivery realm compatibility export", () => {
  it("uses the unique shared multi-Provider broker and exact DSH descriptor", () => {
    const dsh: AgentProviderRealmFactory = Object.freeze({
      descriptor: Object.freeze({
        schemaVersion: "execution.agent-provider-factory@1.0.0",
        identity: "provider.dsh",
        version: "0.1.1-rc.2",
        adapterKey: "dsh-headless",
        capabilities: Object.freeze(["action-interaction", "structured-completion"]),
      }),
      acquire: vi.fn(),
    });
    const registry = new AgentProviderFactoryRegistry([dsh]);

    expect(DshExportedBroker).toBe(DeliveryAgentProviderRealmBroker);
    expect(new DshExportedBroker(registry).registry).toBe(registry);
    expect(registry.admit({ identity: "provider.dsh", version: "0.1.1-rc.2" }, ["structured-completion"]))
      .toMatchObject({ adapterKey: "dsh-headless" });
  });
});
