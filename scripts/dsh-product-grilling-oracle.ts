export interface GrillingQuestion {
  readonly text: string;
}

export interface GrillingDialoguePorts {
  readonly firstQuestion: GrillingQuestion;
  readonly firstQuestionCount: number;
  readonly waitForNextQuestion: (afterQuestionCount: number) => Promise<GrillingQuestion>;
  readonly submitOrdinaryAnswer: (answer: string) => Promise<void>;
  readonly submitAgreementAndFinish: (answer: string) => Promise<void>;
}

export interface GrillingDialogueEvidence {
  readonly questionCount: 3;
  readonly ordinaryAnswerCount: 2;
  readonly agreementQuestion: string;
  readonly agreementConfirmed: true;
}

const STACK_ANSWER = "Use Node.js with the built-in node:http module for the local-only service.";
const PORT_ANSWER = "Use local port 43127 and bind only to 127.0.0.1.";
const AGREEMENT_CONFIRMATION = "Yes, we have reached agreement on this design.";

export async function exerciseGrillingDialogue(ports: GrillingDialoguePorts): Promise<GrillingDialogueEvidence> {
  await ports.submitOrdinaryAnswer(STACK_ANSWER);
  await ports.waitForNextQuestion(ports.firstQuestionCount);

  await ports.submitOrdinaryAnswer(PORT_ANSWER);
  const agreement = await ports.waitForNextQuestion(ports.firstQuestionCount + 1);
  if (!/(?:reached|have|confirm|agree|agreement|aligned).*(?:agree|agreement|aligned|design)|(?:agree|agreement|aligned).*(?:reached|confirm|design)/iu.test(agreement.text)) {
    throw new Error(`PRODUCT_GRILLING_AGREEMENT_NOT_REQUESTED:${agreement.text}`);
  }

  await ports.submitAgreementAndFinish(AGREEMENT_CONFIRMATION);
  return Object.freeze({
    questionCount: 3,
    ordinaryAnswerCount: 2,
    agreementQuestion: agreement.text,
    agreementConfirmed: true,
  });
}
