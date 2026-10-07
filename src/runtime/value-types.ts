import type { PlanSourceLocation, TypeCheckPlan, TypePlan } from "../plan/model.js";
import type { SourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { messageText } from "./text-length.js";
import { copySpan } from "./operations/support.js";
import type { SerializableRuntimeValue } from "./serializable-values.js";
import {
  isDate,
  isDateTime,
  isDict,
  isDuration,
  isList,
  isMediaHandle,
  isMessageHandle,
  isPermanentButton,
  isCameraView,
  isObject,
  isRange,
  isScriptReference,
  isSet,
  isSpeakerReference,
  isTime,
  isTimerHandle,
  isTimestamp,
} from "./value-predicates.js";

/**
 * Checks that a value the compiler could not know fits the type of the place that receives it (ADR 0021 rule 1.7);
 * a value that does not fit fails with `TSR058`, which names the place and the part that does not fit.
 */
export function assertValueType(
  value: SerializableRuntimeValue,
  check: TypeCheckPlan,
  span: SourceSpan | PlanSourceLocation,
): void {
  const mismatch = findTypeMismatch(value, check.type);
  if (mismatch === null) return;
  const part =
    mismatch.path === "" ? "" : ` with ${describeValue(mismatch.value)} at ${mismatch.path}`;
  throw new RuntimeFault(
    "TSR058",
    `${capitalize(check.place)} holds ${describeType(check.type)}, so it cannot take ${describeValue(value)}${part}.`,
    copySpan(span),
  );
}

/** Whether a value fits a type: the answer of `value is T`, by the same matcher as the runtime type checks. */
export function matchesValueType(value: SerializableRuntimeValue, type: TypePlan): boolean {
  return findTypeMismatch(value, type) === null;
}

/**
 * The developer warning for a stored value that does not fit the type a `load` reads it as, which the load ignores
 * (V30 §25), or `null` when the value fits.
 */
export function storedValueMismatch(
  key: string,
  value: SerializableRuntimeValue,
  type: TypePlan,
): string | null {
  const mismatch = findTypeMismatch(value, type);
  if (mismatch === null) return null;
  const saved =
    mismatch.path === ""
      ? `is ${describeValue(value)}`
      : `has ${describeValue(mismatch.value)} at ${mismatch.path}`;
  return `Storage key ${JSON.stringify(key)} is loaded as ${describeType(type)} here, but the saved value ${saved}. This load uses its default; the saved value is kept.`;
}

interface TypeMismatch {
  readonly value: SerializableRuntimeValue;
  /** The path from the checked value to the part that does not fit, such as `[2].locked`; empty for the value. */
  readonly path: string;
}

interface MatchFrame {
  readonly value: SerializableRuntimeValue;
  readonly type: TypePlan;
  /** The step from the enclosing value, such as `[2]` or `.locked`; empty for a union member. */
  readonly step: string;
  /** The next element, property, or union member to check. */
  next: number;
  /** For an object type, the value's properties by name. */
  properties: ReadonlyMap<string, SerializableRuntimeValue> | null;
}

/**
 * The part of `value` that does not fit `type`, or `null` when it fits (ADR 0021 rule 4.2): `integer` is a whole
 * number, `number` includes integers, a collection type checks every element or dict value, so an empty collection
 * fits, and an object type checks each listed property that the value has. A part that fits no member of a union is
 * reported at the union. The test has no side effects, and deep values are checked without native recursion.
 */
function findTypeMismatch(value: SerializableRuntimeValue, type: TypePlan): TypeMismatch | null {
  const frames: MatchFrame[] = [matchFrame(value, type, "")];
  // A part that does not fit inside a union is not a mismatch yet: another member may fit.
  let unions = type.kind === "union" ? 1 : 0;
  let fits = true;
  let mismatch: TypeMismatch | null = null;
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    const result = matchStep(frame, fits);
    if (typeof result !== "boolean") {
      frames.push(result);
      if (result.type.kind === "union") unions += 1;
      continue;
    }
    fits = result;
    if (frame.type.kind === "union") unions -= 1;
    if (!fits && unions === 0 && mismatch === null)
      mismatch = { value: frame.value, path: frames.map((outer) => outer.step).join("") };
    frames.pop();
  }
  return fits ? null : mismatch;
}

function matchFrame(value: SerializableRuntimeValue, type: TypePlan, step: string): MatchFrame {
  return { value, type, step, next: 0, properties: null };
}

/** The next part of `frame` to check, or its result; `fits` is the result of the part checked last. */
function matchStep(frame: MatchFrame, fits: boolean): MatchFrame | boolean {
  const { value, type } = frame;
  switch (type.kind) {
    case "union":
      if (frame.next > 0 && fits) return true;
      if (frame.next === type.members.length) return false;
      return matchFrame(value, type.members[frame.next++]!, "");
    case "list":
    case "set": {
      const items =
        type.kind === "list"
          ? isList(value)
            ? value.items
            : null
          : isSet(value)
            ? value.items
            : null;
      if (items === null || (frame.next > 0 && !fits)) return false;
      if (type.element === null || frame.next === items.length) return true;
      const index = frame.next++;
      return matchFrame(items[index]!, type.element, `[${index}]`);
    }
    case "dict": {
      if (!isDict(value) || (frame.next > 0 && !fits)) return false;
      if (type.element === null || frame.next === value.entries.length) return true;
      const entry = value.entries[frame.next++]!;
      return matchFrame(entry.value, type.element, `[${JSON.stringify(messageText(entry.key))}]`);
    }
    case "object": {
      if (!isObject(value)) return false;
      if (frame.next > 0 && !fits) return false;
      if (type.properties.length === 0) return true;
      frame.properties ??= new Map(
        value.properties.map((property) => [property.name, property.value]),
      );
      while (frame.next < type.properties.length) {
        const property = type.properties[frame.next++]!;
        const nested = frame.properties.get(property.name);
        if (nested !== undefined) return matchFrame(nested, property.type, `.${property.name}`);
      }
      return true;
    }
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "null":
      return value === null;
    case "duration":
      return isDuration(value);
    case "range":
      return isRange(value);
    case "speaker":
      return isSpeakerReference(value);
    case "timer":
      return isTimerHandle(value);
    case "media":
      return isMediaHandle(value);
    case "camera":
      return isCameraView(value);
    case "permanentButton":
      return isPermanentButton(value);
    case "messageHandle":
      return isMessageHandle(value);
    case "script":
      return isScriptReference(value);
    case "date":
      return isDate(value);
    case "time":
      return isTime(value);
    case "datetime":
      return isDateTime(value);
    case "timestamp":
      return isTimestamp(value);
    case "never":
      // No value fits, so a list of it is only ever empty, as for an element both list types share.
      return false;
  }
}

const NAMED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  string: "text (string)",
  integer: "a whole number (integer)",
  number: "a number",
  boolean: "true or false (boolean)",
  duration: "a duration",
  date: "a date",
  time: "a time",
  datetime: "a date and time",
  timestamp: "a timestamp",
  null: "null",
  range: "a range",
  speaker: "a speaker",
  timer: "a timer handle",
  media: "a media handle",
  camera: "a camera view",
  permanentButton: "a permanent button",
  messageHandle: "a message handle",
  script: "a script reference",
  object: "an object",
  never: "no value",
};

/** A plain-language description of the values of `type`, in the compiler's wording. */
export function describeType(type: TypePlan): string {
  // A union's members are described one after another; nested unions only add members.
  const descriptions: string[] = [];
  const pending: TypePlan[] = [type];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === "union") {
      for (let index = current.members.length - 1; index >= 0; index -= 1)
        pending.push(current.members[index]!);
    } else if (current.kind === "list" || current.kind === "set" || current.kind === "dict") {
      descriptions.push(
        current.element === null ? `a ${current.kind}` : `a ${current.kind} (${typeName(current)})`,
      );
    } else {
      descriptions.push(NAMED_DESCRIPTIONS[current.kind]!);
    }
  }
  return descriptions.join(" or ");
}

/** The type as an annotation writes it, such as `integer[]` or `string?`, built without native recursion. */
function typeName(type: TypePlan): string {
  const frames: { readonly type: TypePlan; readonly names: string[] }[] = [{ type, names: [] }];
  let name = "";
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    const parts = typeParts(frame.type);
    if (frame.names.length < parts.length) {
      frames.push({ type: parts[frame.names.length]!, names: [] });
      continue;
    }
    name = joinTypeName(frame.type, frame.names);
    frames.pop();
    frames[frames.length - 1]?.names.push(name);
  }
  return name;
}

function typeParts(type: TypePlan): readonly TypePlan[] {
  if (type.kind === "union") return type.members;
  if (
    (type.kind === "list" || type.kind === "set" || type.kind === "dict") &&
    type.element !== null
  )
    return [type.element];
  return [];
}

function joinTypeName(type: TypePlan, names: readonly string[]): string {
  switch (type.kind) {
    case "list":
    case "set":
    case "dict": {
      const element = names[0];
      if (element === undefined) return type.kind;
      const written = element.includes(" | ") ? `(${element})` : element;
      return type.kind === "list" ? `${written}[]` : `${written} ${type.kind}`;
    }
    case "union": {
      const nonNull = names.filter((_, index) => type.members[index]!.kind !== "null");
      return nonNull.length === 1 && names.length === 2 ? `${nonNull[0]}?` : names.join(" | ");
    }
    default:
      return type.kind;
  }
}

/** A plain-language description of a runtime value's kind, in the compiler's wording. */
export function describeValue(value: SerializableRuntimeValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return "text (string)";
  if (typeof value === "boolean") return "true or false (boolean)";
  if (typeof value === "number")
    return Number.isInteger(value) ? "a whole number (integer)" : "a number";
  switch (value.kind) {
    case "list":
      return "a list";
    case "set":
      return "a set";
    case "dict":
      return "a dict";
    case "speakerReference":
      return "a speaker";
    case "timerHandle":
      return "a timer handle";
    case "mediaHandle":
      return "a media handle";
    case "cameraView":
      return "a camera view";
    case "permanentButtonHandle":
      return "a permanent button";
    case "messageHandle":
      return "a message handle";
    default:
      return NAMED_DESCRIPTIONS[value.kind]!;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
