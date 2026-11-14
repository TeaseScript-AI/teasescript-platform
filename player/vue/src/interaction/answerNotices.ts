// The composer's notice for an answer or a form edit that the runtime did not take, shared by `useAnswerSubmission` and
// `useFormUpdates`.

/**
 * The notice of a refused answer or edit, or "" for one refused because its question was gone, which settles silently
 * (the owner's decision of 2026-11-14): the refusal is a window no player's timing hits.
 */
export function refusalMessage(outcome: {
  readonly kind: string;
  readonly message?: string;
}): string {
  return outcome.kind === "invalidPayload" && outcome.message !== undefined
    ? outcome.message
    : outcome.kind === "executionPending"
      ? "The script moved on; try again."
      : "";
}
