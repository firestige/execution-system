import { describe, expect, expectTypeOf, it } from "vitest";

import type { ActionInputResponse, InteractionRequestId } from "../../src/contracts/index.js";

describe("W0-REOPEN-002 bounded Action interaction input", () => {
  it("requires an internal discriminator for ordinary answers and finish requests", () => {
    expectTypeOf<ActionInputResponse>().toHaveProperty("kind").toEqualTypeOf<"ANSWER" | "ACTION_FINISH_REQUESTED">();

    const answer = {
      kind: "ANSWER",
      requestIdentity: "interaction-1" as InteractionRequestId,
      content: { answer: "ready" },
      contentIdentity: `sha256:${"1".repeat(64)}`,
    } satisfies ActionInputResponse;
    const finish = {
      kind: "ACTION_FINISH_REQUESTED",
      requestIdentity: "interaction-1" as InteractionRequestId,
      content: { answer: "ready" },
      contentIdentity: `sha256:${"1".repeat(64)}`,
    } satisfies ActionInputResponse;

    expect(answer.kind).not.toBe(finish.kind);
  });
});
