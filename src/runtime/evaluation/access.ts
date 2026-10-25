import {
  dictKeyMessage,
  missingDictPropertyMessage,
  missingKeyMessage,
} from "../../dict-operations.js";
import {
  emptyListPropertyFailure,
  listProperty,
  missingListPropertyMessage,
  type ElementProperty,
} from "../../list-methods.js";
import { calendarDurationPropertyMessage } from "../../temporal-builtins.js";
import {
  missingTemporalMember,
  calendarDurationProperty,
  temporalProperty,
} from "../values/temporal-operations.js";
import type { ExpressionPlan } from "../../plan/model.js";
import { anglePropertyMessage } from "../../angle.js";
import { speakerPropertySources, speakerPropertyValue } from "../../speaker-terms.js";
import { RuntimeFault } from "../errors.js";
import { quotedText } from "../values/value-text.js";
import { messageText } from "../values/text-length.js";
import { listHasPosition } from "../values/collection-operations.js";
import { loweredOperand } from "./lowered-operands.js";
import { durationPropertyMessage } from "../../duration.js";
import { missingMemberMessage } from "../values/string-operations.js";
import { stringLength, unknownTextMemberMessage } from "../../text-operations.js";
import { missingPropertyMessage } from "../../object-properties.js";
import {
  dictProperty,
  getSerializableDictEntry,
  getSerializableProperty,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import { currentTemporalContext, type RuntimeSpeakerSnapshot } from "../snapshot/state.js";
import { derivedDisplayName } from "../values/speaker-text.js";
import {
  isAngle,
  isCalendarDuration,
  isDict,
  isDuration,
  isList,
  isObject,
  isSet,
  isSpeakerReference,
  isTemporal,
  isTimerHandle,
  isMediaHandle,
  isMessageHandle,
  isCameraView,
  isPermanentButton,
} from "../values/value-predicates.js";
import { describeShownValue } from "../values/value-types.js";
import { mediaProperty } from "../background/media.js";
import { timerProperty } from "../background/timers.js";
import { numberFromText } from "../../conversions.js";
import { describeValue, isDictKey } from "../../value-kinds.js";
import { timerOf, mediaOf, cameraView, liveMessage, readHandleProperty } from "./handles.js";
import { drawIndex, randomItem } from "./draws.js";
import { type SourceSpan, fault, receiverLabel, planLabel } from "./support.js";
import type { Evaluator } from "../evaluator.js";
import { speakerById } from "./speakers.js";

// Reading a property or an element: of objects, speakers, handles, lists, sets, dicts, and texts.

function getCollectionProperty(
  evaluator: Evaluator,
  value: SerializableRuntimeList | SerializableRuntimeSet,
  name: string,
  span: SourceSpan,
  collection: ExpressionPlan | null,
): SerializableRuntimeValue {
  if (listProperty(name)?.gives === "length") return value.items.length;
  const element = elementProperty(name);
  if (element === undefined)
    throw fault("TSR017", missingListPropertyMessage(isList(value) ? "list" : "set", name), span);
  if (value.items.length === 0)
    throw emptyCollection(element, value, optionalLabel(evaluator, collection), span);
  if (element === "random") return randomItem(evaluator, value.items, span, "collectionRandom");
  return value.items[elementIndex(evaluator, element, value.items, span)]!;
}

/** The index of the element that `property` reads from `items`, which are not empty; `random` draws it. */
export function elementIndex(
  evaluator: Evaluator,
  property: ElementProperty,
  items: readonly SerializableRuntimeValue[],
  span: SourceSpan,
): number {
  switch (property) {
    case "first":
      return 0;
    case "last":
      return items.length - 1;
    case "random":
      return drawIndex(evaluator, span, "collectionRandom", items);
    default: {
      const unhandled: never = property;
      throw new Error(`List property '${String(unhandled)}' has no implementation.`);
    }
  }
}

function getSpeakerProperty(
  evaluator: Evaluator,
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  span: SourceSpan,
): SerializableRuntimeValue {
  const property = speakerPropertyValue(
    (own) => speaker.properties.find((item) => item.name === own)?.value,
    name,
    () =>
      derivedDisplayName(
        speaker.properties,
        span,
        currentTemporalContext(evaluator.snapshot),
        "displayName",
      ),
  );
  if (property === undefined)
    throw fault("TSR017", `Speaker '${speaker.identifier}' has no property '${name}'.`, span);
  return property;
}

function getObjectProperty(
  evaluator: Evaluator,
  object: SerializableRuntimeObject,
  name: string,
  span: SourceSpan,
  plan: ExpressionPlan | null,
): SerializableRuntimeValue {
  const value = getSerializableProperty(object, name);
  if (value === undefined)
    throw fault(
      "TSR017",
      missingPropertyMessage(
        optionalLabel(evaluator, plan),
        name,
        object.properties.map((property) => property.name),
      ),
      span,
    );
  return value;
}

/** `name` of `value`, which `object` gives where the plan has it, to name it in a failure. */
export function getProperty(
  evaluator: Evaluator,
  value: SerializableRuntimeValue,
  name: string,
  span: SourceSpan,
  object: ExpressionPlan | null = null,
): SerializableRuntimeValue {
  if (isObject(value)) return getObjectProperty(evaluator, value, name, span, object);
  if (isSpeakerReference(value)) {
    const speaker = speakerById(evaluator, value.speakerId, span);
    // A value that a speaker reads through other properties, such as a term its gender gives, comes from those.
    if (evaluator.trace !== null)
      for (const source of speakerPropertySources(
        (own) => speaker.properties.some((property) => property.name === own),
        name,
      ))
        evaluator.readState(value, source);
    return getSpeakerProperty(evaluator, speaker, name, span);
  }
  if (evaluator.trace !== null) evaluator.readState(value, name);
  if (isList(value) || isSet(value))
    return getCollectionProperty(evaluator, value, name, span, object);
  if (typeof value === "string") {
    if (name === "length") return stringLength(value);
    throw fault("TSR017", unknownTextMemberMessage(name, "property"), span);
  }
  if (isDict(value)) {
    const property = dictProperty(value, name);
    if (property === undefined)
      throw fault(
        "TSR017",
        missingDictPropertyMessage(name, optionalLabel(evaluator, object)),
        span,
      );
    return property;
  }
  if (isCameraView(value)) {
    const property = readHandleProperty("camera", name, span);
    switch (property) {
      case "placement":
        return cameraView(evaluator).placement;
      default: {
        const unhandled: never = property;
        throw new Error(`Camera view property '${String(unhandled)}' has no implementation.`);
      }
    }
  }
  if (isMediaHandle(value)) {
    const media = mediaOf(evaluator, value, span);
    return mediaProperty(
      media,
      readHandleProperty("media", name, span),
      evaluator.snapshot.currentSessionTimeMs,
    );
  }
  if (isCalendarDuration(value)) {
    const property = calendarDurationProperty(value, name);
    if (property === undefined) throw fault("TSR017", calendarDurationPropertyMessage(name), span);
    return property;
  }
  if (isDuration(value)) throw fault("TSR017", durationPropertyMessage(name), span);
  if (isAngle(value)) throw fault("TSR017", anglePropertyMessage(name), span);
  if (isTemporal(value)) {
    const property = temporalProperty(value, name);
    if (property === undefined)
      throw fault(
        "TSR017",
        missingTemporalMember(value, name, "property", optionalLabel(evaluator, object)),
        span,
      );
    return property;
  }
  if (isTimerHandle(value)) {
    const timer = timerOf(evaluator, value, span);
    return timerProperty(
      timer,
      readHandleProperty("timer", name, span),
      evaluator.snapshot.currentSessionTimeMs,
    );
  }
  if (isMessageHandle(value)) {
    const property = readHandleProperty("messageHandle", name, span);
    if (property !== "text") {
      const unhandled: never = property;
      throw new Error(`Message property '${String(unhandled)}' has no implementation.`);
    }
    return evaluator.snapshot.liveMessages[liveMessage(evaluator, value, span)]!.sourceText;
  }
  if (isPermanentButton(value)) {
    const property = readHandleProperty("permanentButton", name, span);
    const unhandled: never = property;
    throw new Error(`Permanent button property '${String(unhandled)}' has no implementation.`);
  }
  throw fault("TSR017", missingMemberMessage(value, name, "property"), span);
}

/** Only lists and dicts are indexed. */
export function assertIndexable(
  evaluator: Evaluator,
  value: SerializableRuntimeValue,
  plan: ExpressionPlan,
  span: SourceSpan,
): void {
  if (isSet(value)) throw notIndexable(evaluator, "TSR004", plan, value, span);
  if (!isList(value) && !isDict(value)) throw notIndexable(evaluator, "TSR008", plan, value, span);
}

/** The key that `keyPlan` gave as `value`, which is text (`dictKey`, `dictKeyMessage`). */
export function dictKey(
  evaluator: Evaluator,
  value: SerializableRuntimeValue,
  keyPlan: ExpressionPlan,
): string {
  if (!isDictKey(value))
    throw fault(
      "TSR062",
      dictKeyMessage(
        describeValue(value),
        typeof value === "number",
        planLabel(keyPlan, evaluator.plan),
      ),
      keyPlan.span,
    );
  return value;
}

/** The value of `dict[key]`; a missing key is an error that names the check. */
export function dictValue(
  evaluator: Evaluator,
  dict: SerializableRuntimeDict,
  key: string,
  expression: Extract<ExpressionPlan, { kind: "index" }>,
): SerializableRuntimeValue {
  const entry = getSerializableDictEntry(dict, key);
  if (entry === undefined)
    throw missingKey(evaluator, key, expression.object, expression.index, expression.span);
  return entry.value;
}

/**
 * The error for a key a dict does not have (`missingKeyMessage`), naming the dict and the key as the source spells
 * them where the plan still shows them.
 */
export function missingKey(
  evaluator: Evaluator,
  key: string,
  dictPlan: ExpressionPlan,
  keyPlan: ExpressionPlan,
  span: SourceSpan,
): RuntimeFault {
  return fault(
    "TSR061",
    missingKeyMessage(
      quotedText(messageText(key)),
      receiverLabel(evaluator, dictPlan),
      planLabel(keyPlan, evaluator.plan),
    ),
    span,
  );
}

/** How the source spells the value `plan` gives, where there is a plan, or `null`. */
function optionalLabel(evaluator: Evaluator, plan: ExpressionPlan | null): string | null {
  return plan === null ? null : receiverLabel(evaluator, plan);
}

/**
 * The position `value` gives in `list`, which `receiver` gives: `TSR024` unless it is a whole number and `TSR025` unless
 * the list has it. `indexPlan` is the index as written, or `null` for an argument such as of `removeAt(...)`.
 */
export function listPosition(
  evaluator: Evaluator,
  list: SerializableRuntimeList,
  receiver: ExpressionPlan,
  indexPlan: ExpressionPlan | null,
  value: SerializableRuntimeValue,
  use: "read" | "assign" | "remove",
  span: SourceSpan = indexPlan!.span,
): number {
  if (listHasPosition(list.items.length, value)) return value;
  const whole = typeof value === "number" && Number.isInteger(value);
  // A label is only written for the failure.
  const index = indexPlan === null ? null : loweredOperand(evaluator.plan, indexPlan);
  const indexLabel =
    index === null
      ? null
      : index.kind === "literal"
        ? typeof index.value === "number"
          ? String(index.value)
          : null
        : planLabel(index, evaluator.plan);
  if (!whole) {
    const subject = indexLabel === null ? "this" : `'${indexLabel}'`;
    const fix =
      typeof value === "number"
        ? " Round it with floor(...), round(...), or ceil(...) first."
        : value === null
          ? ` Check that ${indexLabel === null ? "the index" : `'${indexLabel}'`} is not null first.`
          : typeof value === "string" && numberFromText(value) !== undefined
            ? " Convert the text with toInteger(...) first."
            : "";
    throw fault(
      "TSR024",
      `A list index must be a whole number (integer), but ${subject} is ${describeShownValue(value)}.${fix}`,
      span,
    );
  }
  const length = list.items.length;
  const owner = receiverLabel(evaluator, receiver);
  const named = owner === null ? "the list" : `'${owner}'`;
  const action = `Cannot ${use === "assign" ? "assign to" : use} ${owner === null || indexLabel === null ? `index ${value}` : `'${owner}[${indexLabel}]'`}`;
  const given =
    owner === null || indexLabel === null || indexLabel === String(value)
      ? ""
      : `'${indexLabel}' is ${value}, and `;
  throw fault(
    "TSR025",
    length === 0
      ? `${action}: ${given}${named} is empty. Check ${owner === null ? "its length" : `'${owner}.length'`} first.`
      : `${action}: ${given}${named} has ${length === 1 ? "1 element, so its only index is 0" : `${length} elements, so its indexes run from 0 through ${length - 1}`}. Check the index against ${owner === null ? "the list's length" : `'${owner}.length'`} first.`,
    span,
  );
}

/** `TSR004` for a set, and `code` for any other value, which `plan` gives, that is not a list or dict to index. */
export function notIndexable(
  evaluator: Evaluator,
  code: "TSR004" | "TSR005" | "TSR008",
  plan: ExpressionPlan,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): RuntimeFault {
  const label = receiverLabel(evaluator, plan);
  const subject = label === null ? "this" : `'${label}'`;
  return isSet(value)
    ? fault(
        "TSR004",
        `Only a list or a dict can be indexed, but ${subject} is a set. Copy it into a list with toList() first.`,
        span,
      )
    : fault(
        code,
        `Only a list or a dict can be indexed, but ${subject} is ${describeShownValue(value)}.`,
        span,
      );
}

export function elementProperty(name: string): ElementProperty | undefined {
  // EVIDENCE: invariant: the properties that give an element are the names of `ElementProperty`.
  return listProperty(name)?.gives === "element" ? (name as ElementProperty) : undefined;
}

/** The failure of reading `property` from an empty list or set the source may spell `label` (see `LIST_PROPERTIES`). */
export function emptyCollection(
  property: ElementProperty,
  collection: SerializableRuntimeList | SerializableRuntimeSet,
  label: string | null,
  span: SourceSpan,
): RuntimeFault {
  const failure = emptyListPropertyFailure(property, isSet(collection) ? "set" : "list", label)!;
  return fault(failure.code, failure.message, span);
}
