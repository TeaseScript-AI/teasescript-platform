// The composer's notices for an answer or a form edit that the runtime did not take, shared by `useAnswerSubmission` and
// `useFormUpdates`.

/** The notice of an answer or edit that arrived after its question was gone. */
export const QUESTION_GONE = "The question was gone before your answer arrived.";

/** `QUESTION_GONE`, saying so where the answer's typed text came back to the composer. */
export const questionGone = (textBack: boolean) =>
  textBack ? `${QUESTION_GONE} Your text is back in the field.` : QUESTION_GONE;

/** The notice of a refused answer or edit; `textBack` when its typed text came back to the composer. */
export function refusalMessage(
  outcome: { readonly kind: string; readonly message?: string },
  textBack = false,
): string {
  return outcome.kind === "invalidPayload" && outcome.message !== undefined
    ? outcome.message
    : outcome.kind === "executionPending"
      ? "The script moved on; try again."
      : questionGone(textBack);
}
