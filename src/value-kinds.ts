/**
 * The kinds of runtime values (V30 §13), one entry each: how the compiler names the type and a message names a value,
 * how the runtime tells a value of the kind and a snapshot stores it, and what `==`, `<`, `${...}`, `toJson`, buttons,
 * `case`, and dict keys do with it. The type checker, the runtime, and the editor read these facts here; each kind's
 * own behaviour (its notation, its JSON, its order) is implemented where the operation is, by kind.
 *
 * A text that the Player's file store issued for a file is a text like any other (V30 §13), and a choice value is a
 * value of one of the kinds whose `choice` is set, so neither is a kind of its own.
 */

import type {
  SerializableRuntimeScalar,
  SerializableRuntimeValue,
} from "./runtime/serializable-values.js";
import {
  isAbsoluteDateTime,
  isAngle,
  isCalendarDuration,
  isCameraView,
  isDate,
  isDateTime,
  isDict,
  isDuration,
  isList,
  isMediaHandle,
  isMessageHandle,
  isObject,
  isPermanentButton,
  isRange,
  isRegex,
  isScriptReference,
  isSet,
  isSpeakerReference,
  isTime,
  isTimerHandle,
} from "./runtime/value-predicates.js";

/** The `kind` of each record a snapshot stores a value as. */
type RecordTag = Exclude<SerializableRuntimeValue, SerializableRuntimeScalar>["kind"];

export interface ValueKindFacts {
  /** One value of the kind, as the compiler and the runtime name it in a message: `a whole number (integer)`. */
  readonly description: string;
  /** Several values of the kind, as a message names them: `numbers`, `dates and times`. */
  readonly plural: string;
  /**
   * Whether an annotation writes the type by its name, which is the kind's key. Camera views and permanent buttons have
   * no written type.
   */
  readonly written: boolean;
  /**
   * How the compiler holds the type (`StaticType`): as a `scalar` of this name, as a type of the kind's own without
   * parts, or as one with `parts`: the element of a list, set, or dict, or an object's properties.
   */
  readonly type: "scalar" | "kind" | "parts";
  /**
   * How a snapshot and a checkpoint hold a value: a JSON primitive, or a record with this `kind`. Snapshot validation
   * (`validateSerializableValue`) checks every stored value itself; it does not trust a record because of this entry.
   */
  readonly stored: "null" | "string" | "boolean" | "number" | RecordTag;
  /** Whether a runtime value is a value of the type, as `value is T` and the runtime type checks test it. */
  readonly is: (value: SerializableRuntimeValue) => boolean;
  /**
   * How `==` compares two values: by value, by their parts (in order for a list, regardless of order otherwise), or by
   * identity. A value with an identity, a speaker or a handle, names something that exists only in the session, so it
   * cannot be saved, written as JSON, or come from host data, and every copy of it names the same thing.
   */
  readonly equality: "value" | "parts" | "identity";
  /** The kind whose values `==` and `<` take as values of this one, when not the kind itself: an integer is a number. */
  readonly family?: "number";
  /** Whether `<`, `sort()`, `min`, and `max` order values of the kind, each only with values of its family. */
  readonly ordered: boolean;
  /**
   * How `${...}`, text fields, and `say` show a value: as its `text`; as code-like `notation`, which is its text too and
   * which `say` escapes, as a script reference's `script("hall.tease")`; or, with `null`, not as text, while `say` shows
   * it in notation.
   */
  readonly shown: "text" | "notation" | null;
  /** What `toJson` writes for a value: the value, a speaker's properties, or nothing (`null`). */
  readonly json: "value" | "properties" | null;
  /** Whether a button may return a value of the kind as its choice value (V30 §26). */
  readonly choice: boolean;
  /** Whether a literal of the kind may be a `case` value (V30 §32); a speaker's is its declared name. */
  readonly case: boolean;
  /** Whether a value of the kind may be a dict key (V30 §40). */
  readonly dictKey: boolean;
}

export const VALUE_KINDS = {
  integer: {
    description: "a whole number (integer)",
    plural: "whole numbers",
    written: true,
    type: "scalar",
    stored: "number",
    is: (value) => typeof value === "number" && Number.isInteger(value),
    equality: "value",
    family: "number",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: true,
    dictKey: false,
  },
  number: {
    description: "a number",
    plural: "numbers",
    written: true,
    type: "scalar",
    stored: "number",
    is: (value) => typeof value === "number",
    equality: "value",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: true,
    dictKey: false,
  },
  string: {
    description: "text (string)",
    plural: "texts",
    written: true,
    type: "scalar",
    stored: "string",
    is: (value) => typeof value === "string",
    equality: "value",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: true,
    dictKey: true,
  },
  boolean: {
    description: "true or false (boolean)",
    plural: "true or false values",
    written: true,
    type: "scalar",
    stored: "boolean",
    is: (value) => typeof value === "boolean",
    equality: "value",
    ordered: false,
    shown: "text",
    json: "value",
    choice: true,
    case: true,
    dictKey: false,
  },
  duration: {
    description: "a duration",
    plural: "durations",
    written: true,
    type: "scalar",
    stored: "duration",
    is: isDuration,
    equality: "value",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: true,
    dictKey: false,
  },
  calendarDuration: {
    description: "a calendar duration",
    plural: "calendar durations",
    written: true,
    type: "scalar",
    stored: "calendarDuration",
    is: isCalendarDuration,
    equality: "value",
    ordered: true,
    shown: "text",
    json: null,
    choice: true,
    case: true,
    dictKey: false,
  },
  angle: {
    description: "an angle",
    plural: "angles",
    written: true,
    type: "scalar",
    stored: "angle",
    is: isAngle,
    equality: "value",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: true,
    dictKey: false,
  },
  date: {
    description: "a date",
    plural: "dates",
    written: true,
    type: "scalar",
    stored: "date",
    is: isDate,
    equality: "value",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: false,
    dictKey: false,
  },
  time: {
    description: "a time",
    plural: "times",
    written: true,
    type: "scalar",
    stored: "time",
    is: isTime,
    equality: "value",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: false,
    dictKey: false,
  },
  datetime: {
    description: "a date and time",
    plural: "dates and times",
    written: true,
    type: "scalar",
    stored: "datetime",
    is: isDateTime,
    equality: "value",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: false,
    dictKey: false,
  },
  absoluteDateTime: {
    description: "an absolute date and time",
    plural: "absolute dates and times",
    written: true,
    type: "scalar",
    stored: "absoluteDateTime",
    is: isAbsoluteDateTime,
    equality: "value",
    ordered: true,
    shown: "text",
    json: "value",
    choice: true,
    case: false,
    dictKey: false,
  },
  script: {
    description: "a script reference",
    plural: "script references",
    written: true,
    type: "scalar",
    stored: "script",
    is: isScriptReference,
    equality: "value",
    ordered: false,
    shown: "notation",
    json: null,
    choice: false,
    case: false,
    dictKey: false,
  },
  regex: {
    description: "a regex",
    plural: "regexes",
    written: true,
    type: "scalar",
    stored: "regex",
    is: isRegex,
    equality: "value",
    ordered: false,
    shown: "notation",
    json: null,
    choice: false,
    case: false,
    dictKey: false,
  },
  range: {
    description: "a range",
    plural: "ranges",
    written: true,
    type: "kind",
    stored: "range",
    is: isRange,
    equality: "value",
    ordered: false,
    shown: null,
    json: null,
    choice: false,
    case: false,
    dictKey: false,
  },
  list: {
    description: "a list",
    plural: "lists",
    written: true,
    type: "parts",
    stored: "list",
    is: isList,
    equality: "parts",
    ordered: false,
    shown: null,
    json: "value",
    choice: false,
    case: false,
    dictKey: false,
  },
  set: {
    description: "a set",
    plural: "sets",
    written: true,
    type: "parts",
    stored: "set",
    is: isSet,
    equality: "parts",
    ordered: false,
    shown: null,
    json: "value",
    choice: false,
    case: false,
    dictKey: false,
  },
  dict: {
    description: "a dict",
    plural: "dicts",
    written: true,
    type: "parts",
    stored: "dict",
    is: isDict,
    equality: "parts",
    ordered: false,
    shown: null,
    json: "value",
    choice: false,
    case: false,
    dictKey: false,
  },
  object: {
    description: "an object",
    plural: "objects",
    written: true,
    type: "parts",
    stored: "object",
    is: isObject,
    equality: "parts",
    ordered: false,
    shown: null,
    json: "value",
    choice: false,
    case: false,
    dictKey: false,
  },
  speaker: {
    description: "a speaker",
    plural: "speakers",
    written: true,
    type: "kind",
    stored: "speakerReference",
    is: isSpeakerReference,
    equality: "identity",
    ordered: false,
    shown: null,
    json: "properties",
    choice: false,
    case: true,
    dictKey: false,
  },
  timer: {
    description: "a timer handle",
    plural: "timer handles",
    written: true,
    type: "kind",
    stored: "timerHandle",
    is: isTimerHandle,
    equality: "identity",
    ordered: false,
    shown: null,
    json: null,
    choice: false,
    case: false,
    dictKey: false,
  },
  media: {
    description: "a media handle",
    plural: "media handles",
    written: true,
    type: "kind",
    stored: "mediaHandle",
    is: isMediaHandle,
    equality: "identity",
    ordered: false,
    shown: null,
    json: null,
    choice: false,
    case: false,
    dictKey: false,
  },
  camera: {
    description: "a camera view",
    plural: "camera views",
    written: false,
    type: "kind",
    stored: "cameraView",
    is: isCameraView,
    equality: "identity",
    ordered: false,
    shown: null,
    json: null,
    choice: false,
    case: false,
    dictKey: false,
  },
  permanentButton: {
    description: "a permanent button",
    plural: "permanent buttons",
    written: false,
    type: "kind",
    stored: "permanentButtonHandle",
    is: isPermanentButton,
    equality: "identity",
    ordered: false,
    shown: null,
    json: null,
    choice: false,
    case: false,
    dictKey: false,
  },
  messageHandle: {
    description: "a message handle",
    plural: "message handles",
    written: true,
    type: "kind",
    stored: "messageHandle",
    is: isMessageHandle,
    equality: "identity",
    ordered: false,
    shown: null,
    json: null,
    choice: false,
    case: false,
    dictKey: false,
  },
  null: {
    description: "null",
    plural: "nulls",
    written: true,
    type: "kind",
    stored: "null",
    is: (value) => value === null,
    equality: "value",
    ordered: false,
    shown: "text",
    json: "value",
    choice: true,
    case: true,
    dictKey: false,
  },
} as const satisfies Record<string, ValueKindFacts>;

export type ValueKind = keyof typeof VALUE_KINDS;

/** The kinds whose `field` is `value`, such as the scalar kinds. */
type KindsWith<Field extends keyof ValueKindFacts, Value> = {
  [Kind in ValueKind]: (typeof VALUE_KINDS)[Kind] extends Readonly<Record<Field, Value>>
    ? Kind
    : never;
}[ValueKind];

/** The kinds the compiler holds as a `scalar` type of their name. */
export type ScalarKind = KindsWith<"type", "scalar">;

/** The kinds the compiler holds as a type of their own without parts, such as `range` and `timer`. */
export type PlainKind = KindsWith<"type", "kind">;

/** The kinds an annotation writes by name. */
export type WrittenKind = KindsWith<"written", true>;

/** The families `<` orders, each named by its kind (`familyOf`). */
export type OrderedFamily = Exclude<KindsWith<"ordered", true>, KindsWith<"family", "number">>;

// Every record a snapshot may hold is of a kind: a new kind of record needs its entry above.
type KindlessRecord = Exclude<RecordTag, (typeof VALUE_KINDS)[ValueKind]["stored"]>;
const everyRecordHasAKind: [KindlessRecord] extends [never] ? true : KindlessRecord = true;
void everyRecordHasAKind;

// EVIDENCE: invariant: the keys of `VALUE_KINDS` are its kinds.
export const VALUE_KIND_NAMES = Object.freeze(Object.keys(VALUE_KINDS) as ValueKind[]);

/** The kind of each record by its `kind`. */
const KINDS_BY_RECORD: ReadonlyMap<string, ValueKind> = new Map(
  VALUE_KIND_NAMES.flatMap((kind): [string, ValueKind][] => {
    const stored: string = VALUE_KINDS[kind].stored;
    return ["null", "string", "boolean", "number"].includes(stored) ? [] : [[stored, kind]];
  }),
);

/** The kind of a runtime value: of a number, `integer` when it is whole and `number` otherwise. */
export function valueKindOf(value: SerializableRuntimeValue): ValueKind {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  // EVIDENCE: invariant: `everyRecordHasAKind` proves that every record tag has its kind.
  return KINDS_BY_RECORD.get(value.kind)!;
}

/** A plain-language description of a runtime value's kind, in the compiler's wording (`description`). */
export function describeValue(value: SerializableRuntimeValue): string {
  return VALUE_KINDS[valueKindOf(value)].description;
}

/** The kind whose values `==` and `<` take as values of `kind`'s: `number` for an integer, and otherwise `kind`. */
export function familyOf(kind: ValueKind): ValueKind {
  const facts: ValueKindFacts = VALUE_KINDS[kind];
  return facts.family ?? kind;
}

/** Whether a value of one kind may equal one of the other: only within a family, as `1 == 1.0`. */
export function mayEqualKinds(left: ValueKind, right: ValueKind): boolean {
  return familyOf(left) === familyOf(right);
}

/** Whether `<` orders a value of one kind against one of the other: only an ordered kind, within its family. */
export function ordersWith(left: ValueKind, right: ValueKind): boolean {
  return VALUE_KINDS[left].ordered && familyOf(left) === familyOf(right);
}

/** The family `<` orders a value of `kind` in, or `undefined` for a kind without order. */
export function orderedFamily(kind: ValueKind): OrderedFamily | undefined {
  // EVIDENCE: invariant: the family of an ordered kind is an ordered kind without a family of its own.
  return VALUE_KINDS[kind].ordered ? (familyOf(kind) as OrderedFamily) : undefined;
}

/** The families `<` orders, in the order of `VALUE_KINDS`. */
export const ORDERED_FAMILIES: readonly OrderedFamily[] = Object.freeze(
  VALUE_KIND_NAMES.flatMap((kind) => {
    const family = orderedFamily(kind);
    return family === kind ? [family] : [];
  }),
);

// Only text is a dict key, as `isDictKey` tells the compiler: a key of another kind needs a wider type there.
const onlyTextIsADictKey: [KindsWith<"dictKey", true>] extends ["string"] ? true : never = true;
void onlyTextIsADictKey;

/** Whether a runtime value may be a dict key (`dictKey`). */
export function isDictKey(value: SerializableRuntimeValue): value is string {
  return VALUE_KINDS[valueKindOf(value)].dictKey;
}

/** Whether a value has an identity: a speaker or a handle, which exists only in the session (`equality`). */
export function hasIdentity(kind: ValueKind): boolean {
  return VALUE_KINDS[kind].equality === "identity";
}

/** Why `toJson` cannot write a value of `kind`, after "which", such as `has no JSON form`. */
export function unwritableJsonReason(kind: ValueKind): string {
  return hasIdentity(kind) ? "exists only in the current session" : "has no JSON form";
}
