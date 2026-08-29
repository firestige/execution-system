import { describe, expect, it } from "vitest";
import { createCodexProviderShell } from "../../src/providers/codex/index.js";

describe("unimplemented Provider shells", () => {
  it.each([
    ["Codex", createCodexProviderShell],
  ])("keeps %s typed and fail closed without falling back to DSH", async (_name, create) => {
    const provider = create();

    await expect(provider.open({} as never)).rejects.toMatchObject({ code: "PROVIDER_NOT_IMPLEMENTED" });
    await expect(provider.restore({} as never)).rejects.toMatchObject({ code: "PROVIDER_NOT_IMPLEMENTED" });
  });
});
