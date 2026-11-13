import type { ActionCompletionOutcome } from "../../src/runtime/operations/model.js";
import type { MediaReportOutcome } from "../../src/runtime/operations/media-reports.js";
import type { PermanentButtonPressOutcome } from "../../src/runtime/operations/press-permanent-button.js";
import type { InteractionUpdateOutcome } from "../../src/runtime/operations/update-interaction.js";
import type { ExternalStorageEditOutcome } from "../../src/runtime/operations/external-storage-edit.js";
import type { CandidateOp } from "./candidates.js";

/*
 * Whether a candidate's reply is an accepted input, per op, from the op's own result type. Each table classifies every
 * kind of its result type as accepted or declined (`satisfies Record<kind, …>`, so a new kind fails `tsc` until it is
 * classified); `null` (an op that did nothing, such as a mandatory image's skip) is a decline; a time step accepts
 * when it moved. A result outside the op's type is a harness error: the tape stops, never counting it as either.
 */

export type Reading =
  { readonly accepted: true } | { readonly accepted: false; readonly reason: string };

export class UnfamiliarResult extends Error {}

type Kind<T> = T extends { readonly kind: infer K extends string } ? K : never;
type Classes<T> = Readonly<Record<Kind<T>, "accepted" | "declined">>;

const COMPLETION = {
  completed: "accepted",
  alreadySettled: "declined",
  staleAction: "declined",
  unknownAction: "declined",
  suspendedAction: "declined",
  wrongActionKind: "declined",
  invalidPayload: "declined",
  executionPending: "declined",
  randomDrawPending: "declined",
} as const satisfies Classes<ActionCompletionOutcome>;
const UPDATE = {
  updated: "accepted",
  unchanged: "declined",
  staleAction: "declined",
  unknownAction: "declined",
  suspendedAction: "declined",
  wrongActionKind: "declined",
  invalidPayload: "declined",
  executionPending: "declined",
  randomDrawPending: "declined",
} as const satisfies Classes<InteractionUpdateOutcome>;
const PRESS = {
  pressed: "accepted",
  busy: "declined",
  removedButton: "declined",
  unknownButton: "declined",
  executionPending: "declined",
  invalidPayload: "declined",
  randomDrawPending: "declined",
} as const satisfies Classes<PermanentButtonPressOutcome>;
const MEDIA = {
  accepted: "accepted",
  ignored: "declined",
  unknownMedia: "declined",
  executionPending: "declined",
  invalidReport: "declined",
  randomDrawPending: "declined",
} as const satisfies Classes<MediaReportOutcome>;

const STORAGE_EDIT = {
  applied: "accepted",
  invalidEdit: "declined",
  invalidState: "declined",
  storageWritePending: "declined",
  randomDrawPending: "declined",
} as const satisfies Classes<ExternalStorageEditOutcome>;

/** Reads `result.kind` against `classes`; `null` is a decline, an unclassified kind a harness error. */
function byKind(classes: Readonly<Record<string, "accepted" | "declined">>) {
  return (result: unknown): Reading => {
    if (result === null) return { accepted: false, reason: "null" };
    const kind = typeof result === "object" && "kind" in result ? result.kind : undefined;
    if (typeof kind !== "string" || !Object.hasOwn(classes, kind))
      throw new UnfamiliarResult(`an unfamiliar result ${JSON.stringify(result)}`);
    return classes[kind] === "accepted" ? { accepted: true } : { accepted: false, reason: kind };
  };
}

const interactionAnswer = byKind(COMPLETION);
const formAnswer = byKind({ ...UPDATE, ...COMPLETION });

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
  pressPermanentButton: byKind(PRESS),
  completeStorageWrite: interactionAnswer,
  answerCapture: interactionAnswer,
  answerFileStore: interactionAnswer,
  answerLock: interactionAnswer,
  reportMediaLoad: byKind(MEDIA),
  skipPacing: interactionAnswer,
  applyStorageEdit: byKind(STORAGE_EDIT),
  stepTime: (result) => {
    if (
      typeof result === "object" &&
      result !== null &&
      "moved" in result &&
      typeof result.moved === "boolean"
    )
      return result.moved ? { accepted: true } : { accepted: false, reason: "unmoved" };
    throw new UnfamiliarResult(`an unfamiliar time step ${JSON.stringify(result)}`);
  },
};
