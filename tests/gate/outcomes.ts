import type { CandidateOp } from "./candidates.js";

/*
 * Whether a candidate's reply is an accepted input, per op, from the op's own result type: `completed`, `updated`,
 * `pressed`, `accepted`, or a time step that moved. Every other typed result is a recorded decline with its reason;
 * `null` (an op that did nothing, such as a mandatory image's skip) is a decline too. A result outside the op's type is
 * a harness error: the tape stops, never counting it as either.
 */

export type Reading = { readonly accepted: true } | { readonly accepted: false; readonly reason: string };

export class UnfamiliarResult extends Error {}

const completion = new Set(["alreadySettled", "staleAction", "unknownAction", "suspendedAction", "wrongActionKind", "invalidPayload"]);
const formUpdate = new Set(["unchanged", "staleAction", "unknownAction", "suspendedAction"]);

/** Reads `result.kind` against an op's accepted kinds and its declining ones. */
function byKind(accepted: ReadonlySet<string>, declining: ReadonlySet<string>) {
  return (result: unknown): Reading => {
    if (result === null) return { accepted: false, reason: "null" };
    const kind = typeof result === "object" && "kind" in result ? (result as { kind: unknown }).kind : undefined;
    if (typeof kind === "string" && accepted.has(kind)) return { accepted: true };
    if (typeof kind === "string" && declining.has(kind)) return { accepted: false, reason: kind };
    throw new UnfamiliarResult(`an unfamiliar result ${JSON.stringify(result)}`);
  };
}

const COMPLETED = new Set(["completed"]);
const interactionAnswer = byKind(COMPLETED, completion);
const formAnswer = byKind(new Set(["completed", "updated"]), new Set([...completion, ...formUpdate]));

/** Each candidate op's reading; a new op fails `tsc` here until it has one. */
export const OUTCOMES: { readonly [O in CandidateOp]: (result: unknown) => Reading } = {
  submitComposer: formAnswer,
  selectChoice: interactionAnswer,
  activateButton: interactionAnswer,
  stepFormField: formAnswer,
  submitForm: formAnswer,
  cancelForm: formAnswer,
  skipImage: interactionAnswer,
  openUrl: interactionAnswer,
  closePopup: interactionAnswer,
  closeExport: interactionAnswer,
  pressPermanentButton: byKind(new Set(["pressed"]), new Set(["busy", "removedButton", "unknownButton", "executionPending", "invalidPayload"])),
  completeStorageWrite: interactionAnswer,
  answerCapture: interactionAnswer,
  answerFileStore: interactionAnswer,
  answerLock: interactionAnswer,
  reportMediaLoad: byKind(new Set(["accepted"]), new Set(["ignored", "unknownMedia", "executionPending", "invalidReport"])),
  stepTime: (result) => {
    if (typeof result === "object" && result !== null && "moved" in result && typeof result.moved === "boolean")
      return result.moved ? { accepted: true } : { accepted: false, reason: "unmoved" };
    throw new UnfamiliarResult(`an unfamiliar time step ${JSON.stringify(result)}`);
  },
};
