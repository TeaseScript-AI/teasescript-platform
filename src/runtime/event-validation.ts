import { isMessageMarkup } from "../message-markup.js";
import { isMessagePresentation } from "../message-presentation.js";
import { isRecord, nonNegativeSafeInteger } from "../plan/validation-support.js";
import { isFormUi, validFormResult } from "./actions/form.js";
import type { InterpreterEvent } from "./events.js";
import { validSpan } from "./snapshot/state.js";

/**
 * Why `value` is not an interpreter event as a host keeps it, or `null`: a record of a known kind with a sequence and
 * the fields of its kind, such as a message's markup, speaker, and presentation or an answer's form. A host checks an
 * event it reads back from storage before it shows or replays it.
 */
export function interpreterEventProblem(value: unknown): string | null {
  if (!isRecord(value)) return "An event must be a record.";
  const kind = value["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(EVENT_FIELDS, kind))
    return typeof kind === "string"
      ? `'${kind}' is not a kind of event.`
      : "An event must have a kind.";
  if (!nonNegativeSafeInteger(value["sequence"]))
    return `The sequence of the '${kind}' event must be a whole number from 0.`;
  // EVIDENCE: validation: Object.hasOwn proved `kind` a key of EVENT_FIELDS above.
  const fields: Readonly<Record<string, FieldRule>> = EVENT_FIELDS[kind as EventKind];
  for (const [field, [valid, expected]] of Object.entries(fields)) {
    if (!valid(value[field])) return `The ${field} of the '${kind}' event must be ${expected}.`;
  }
  return null;
}

type EventKind = InterpreterEvent["kind"];
type FieldRule = readonly [valid: (value: unknown) => boolean, expected: string];

const isText = (value: unknown): value is string => typeof value === "string";
const SPAN: FieldRule = [validSpan, "a source span"];
const TEXT: FieldRule = [isText, "a text"];
const COUNT: FieldRule = [nonNegativeSafeInteger, "a whole number from 0"];
const NUMBER: FieldRule = [(value) => typeof value === "number", "a number"];
const MARKUP: FieldRule = [isMessageMarkup, "message markup"];
const PRESENTATION: FieldRule = [isMessagePresentation, "a message presentation"];

/**
 * What each field of each event kind must hold, other than its kind and sequence. The type lists every kind and every
 * field, so a new kind or field of `InterpreterEvent` does not compile until it says how a kept one is checked.
 */
const EVENT_FIELDS: {
  readonly [Kind in EventKind]: {
    readonly [
      Field in Exclude<keyof Extract<InterpreterEvent, { kind: Kind }>, "kind" | "sequence">
    ]-?: FieldRule;
  };
} = {
  say: {
    presentation: PRESENTATION,
    speaker: [
      isSpeaker,
      "null or a speaker with an identifier, a display name, a color, a font, and an avatar",
    ],
    content: MARKUP,
    text: TEXT,
    span: SPAN,
  },
  messageUpdated: { messageId: COUNT, content: MARKUP, text: TEXT, span: SPAN },
  messageRemoved: { messageId: COUNT, span: SPAN },
  exit: { span: SPAN },
  actionRequested: {
    action: [
      (action) =>
        isRecord(action) && isText(action["kind"]) && nonNegativeSafeInteger(action["actionId"]),
      "an action with a kind and an action ID",
    ],
    span: SPAN,
  },
  actionCompleted: {
    settlement: [
      validSettlement,
      "a settlement with an action kind and ID, and for an answer its kind, text, and form answers",
    ],
    span: SPAN,
  },
  playerTranscript: {
    target: [(value) => value === "standardChat", "'standardChat'"],
    requestingSpeakerId: [
      (value) => value === null || nonNegativeSafeInteger(value),
      "null or a speaker ID",
    ],
    text: TEXT,
    presentation: PRESENTATION,
    span: SPAN,
  },
  permanentButtonPressed: { buttonId: COUNT, text: TEXT, span: SPAN },
  developerWarning: {
    severity: [(value) => value === "warning", "'warning'"],
    code: TEXT,
    message: TEXT,
    span: SPAN,
  },
  runtimeFailure: { code: TEXT, message: TEXT, path: TEXT, span: SPAN },
  scriptStorageEdited: {
    key: TEXT,
    operation: [(value) => value === "set" || value === "delete", "'set' or 'delete'"],
    currentSessionTimeMs: NUMBER,
    observedSessionTimeMs: NUMBER,
  },
};

function isSpeaker(value: unknown): boolean {
  const textOrNull = (field: unknown) => field === null || isText(field);
  return (
    value === null ||
    (isRecord(value) &&
      isText(value["identifier"]) &&
      isText(value["displayName"]) &&
      textOrNull(value["color"]) &&
      textOrNull(value["font"]) &&
      textOrNull(value["avatar"]))
  );
}

/**
 * A settlement's kind and identity, and an answer's sequence, text, and UI, with a form's answers and shown options
 * checked against it.
 */
function validSettlement(settlement: unknown): boolean {
  if (
    !isRecord(settlement) ||
    !isText(settlement["actionKind"]) ||
    !nonNegativeSafeInteger(settlement["actionId"])
  )
    return false;
  if (settlement["actionKind"] !== "interaction") return true;
  const ui = settlement["ui"];
  const transcriptText = settlement["transcriptText"];
  const transcriptEventSequence = settlement["transcriptEventSequence"];
  if (
    !isText(settlement["interactionKind"]) ||
    !(transcriptEventSequence === null || nonNegativeSafeInteger(transcriptEventSequence)) ||
    !(transcriptText === null || isText(transcriptText)) ||
    !isRecord(ui)
  )
    return false;
  return (
    ui["kind"] !== "form" ||
    (isFormUi(ui) &&
      validFormResult(
        ui,
        settlement["result"],
        transcriptText,
        settlement["shownOptions"],
        settlement["settlementKind"] === "timedOut",
      ))
  );
}
