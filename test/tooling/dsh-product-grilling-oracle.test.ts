import { describe, expect, it } from "vitest";

import { exerciseGrillingDialogue } from "../../scripts/dsh-product-grilling-oracle.js";

describe("DSH product grilling oracle", () => {
  it("requires two ordinary answer loops before an explicit agreement confirmation and finish", async () => {
    const transcript: string[] = [];
    const questions = [
      { text: "Which implementation stack should be used?" },
      { text: "Which local port should be used?" },
      { text: "Have we reached agreement on this design?" },
    ];
    let questionIndex = 1;

    const result = await exerciseGrillingDialogue({
      firstQuestion: questions[0]!,
      firstQuestionCount: 1,
      waitForNextQuestion: async (after) => {
        transcript.push(`wait-after:${String(after)}`);
        return questions[questionIndex++]!;
      },
      submitOrdinaryAnswer: async (answer) => {
        transcript.push(`answer:${answer}`);
      },
      submitAgreementAndFinish: async (answer) => {
        transcript.push(`finish:${answer}`);
      },
    });

    expect(transcript).toEqual([
      "answer:Use Node.js with the built-in node:http module for the local-only service.",
      "wait-after:1",
      "answer:Use local port 43127 and bind only to 127.0.0.1.",
      "wait-after:2",
      "finish:Yes, we have reached agreement on this design.",
    ]);
    expect(result).toMatchObject({
      questionCount: 3,
      ordinaryAnswerCount: 2,
      agreementQuestion: "Have we reached agreement on this design?",
      agreementConfirmed: true,
    });
  });

  it("fails closed when the third request is not an agreement check", async () => {
    const questions = [
      { text: "Which implementation stack should be used?" },
      { text: "Which local port should be used?" },
      { text: "Would you like another implementation option?" },
    ];
    let questionIndex = 1;

    await expect(exerciseGrillingDialogue({
      firstQuestion: questions[0]!,
      firstQuestionCount: 1,
      waitForNextQuestion: async () => questions[questionIndex++]!,
      submitOrdinaryAnswer: async () => undefined,
      submitAgreementAndFinish: async () => undefined,
    })).rejects.toThrow("PRODUCT_GRILLING_AGREEMENT_NOT_REQUESTED");
  });
});
