import { describe, expect, it } from "vitest";
import { resolveDshPublicClosure } from "../../../src/providers/dsh/index.js";

describe("DSH 0.1.1-rc.2 public package closure", () => {
  it("resolves the public native create/resume, quiescence, persistence, and credential surfaces", async () => {
    const closure = await resolveDshPublicClosure();

    expect(closure.version).toBe("0.1.1-rc.2");
    expect(closure.AgentRegistry.prototype.create).toBeTypeOf("function");
    expect(closure.AgentRegistry.prototype.resume).toBeTypeOf("function");
    expect(closure.SessionStore.prototype.flush).toBeTypeOf("function");
    expect(closure.LocalCredentialProvider.prototype.resolve).toBeTypeOf("function");
    expect(closure.createUserMessage).toBeTypeOf("function");
    expect(closure.defineTool).toBeTypeOf("function");
    expect(closure.SessionId).toBeTypeOf("function");
    expect(closure.installModelSelection).toBeTypeOf("function");
  });
});
