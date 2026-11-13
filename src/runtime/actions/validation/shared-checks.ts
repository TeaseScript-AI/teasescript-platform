// The predicates the restore checks of pending actions share: which interaction kinds give a value or a transcript line,
// whether an answer is well formed, whether a lock outcome fits its call (`lockOutcomeFits`), item equality
// (`sameItems`), and a runtime temporary's value (`runtimeTemporaryValue`). `operations/complete-action.ts` reads
// `isInteractionKind` too.

import { isInteractionChoiceValue } from "../../../choice-values.js";
import {
  validateCapturedSerializableValue,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
} from "../../values/serializable-values.js";
import { isOneOf } from "../../../plan/validation-support.js";
import {
  type InteractionKind,
  type InteractionTemporalKind,
  type LockCall,
  INTERACTION_KINDS,
} from "../../../plan/model.js";
import { interactionStringFits } from "../../../interaction-limits.js";
import { isPlainRecord } from "../../values/plain-data.js";

/**
 * Whether a lock step's outcome fits its call: an encrypt call locks, a decrypt call opens, and a file call keeps
 * exactly the stored file it gives; only a decrypt call is not opened, cancelled, or reads its file, and the file calls
 * alone find a file unreadable.
 */
export function lockOutcomeFits(call: LockCall, outcome: string, file: unknown): boolean {
  const encrypts = call === "encryptText" || call === "encryptFile";
  const files = call === "encryptFile" || call === "decryptFile";
  const result = outcome === "locked" || outcome === "opened";
  if ((outcome === "locked" && !encrypts) || (outcome === "opened" && encrypts)) return false;
  if ((outcome === "notOpened" || outcome === "cancelled") && encrypts) return false;
  if (outcome === "unreadable" && !files) return false;
  return (file !== null) === (result && files);
}

/** Whether `list` is a list value whose items are exactly `items`, in order. */
export function sameItems(list: unknown, items: unknown): boolean {
  if (!isPlainRecord(list) || !Array.isArray(list.items) || !Array.isArray(items)) return false;
  const listed: readonly unknown[] = list.items;
  return listed.length === items.length && listed.every((item, index) => item === items[index]);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: a temporary payload remains unvalidated while snapshot consistency is checked.
export function runtimeTemporaryValue(temporaries: readonly unknown[], id: number): unknown {
  const temporary = temporaries.find(
    (candidate) => isPlainRecord(candidate) && candidate.id === id,
  );
  return isPlainRecord(temporary) ? temporary.value : undefined;
}

/** An interaction that adds no player line to the transcript: a silent one, or a password, which is never shown. */
export function transcriptless(kind: unknown): boolean {
  return silentInteraction(kind) || kind === "password";
}

/** A popup, an `openUrl`, or an `exportText`: the player gives no answer, and nothing enters the transcript. */
export function silentInteraction(kind: unknown): boolean {
  return kind === "popup" || kind === "url" || kind === "export";
}

/** An `openUrl` or an `exportText`: an interaction that never gives a value. */
export function valuelessInteraction(kind: unknown): boolean {
  return kind === "url" || kind === "export";
}

/** A button or a popup: an interaction that, used as a value, gives its elapsed waiting time (V30 §21, §31). */
export function elapsedInteraction(kind: unknown): boolean {
  return kind === "button" || kind === "popup";
}

export function isInteractionKind(value: unknown): value is InteractionKind {
  return isOneOf(value, INTERACTION_KINDS);
}

/** A form's answers: an object, dict, or list of runtime values. Its recorded UI decides which. */
export function isFormResult(
  value: unknown,
): value is SerializableRuntimeObject | SerializableRuntimeDict | SerializableRuntimeList {
  return (
    isPlainRecord(value) &&
    isOneOf(value.kind, ["object", "dict", "list"]) &&
    validateCapturedSerializableValue(value) === null
  );
}

/** An image answer: the reference of a stored image, which only the host that stored it resolves. */
export function isImageReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && interactionStringFits(value);
}

export function isTemporalAnswerKind(value: unknown): value is InteractionTemporalKind {
  return isOneOf(value, ["date", "time", "datetime"]);
}

/** Whether `value` is a valid date, time, or date and time of `kind`, as a date or time field returns. */
export function isTemporalAnswer(value: unknown, kind: InteractionTemporalKind): boolean {
  return (
    isInteractionChoiceValue(value) &&
    typeof value === "object" &&
    value !== null &&
    value.kind === kind
  );
}
