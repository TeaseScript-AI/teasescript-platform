import type { PlanSourceLocation, TypeCheckPlan, TypePlan } from "../../plan/model.js";
import type { SourceSpan } from "../../source.js";
import {
  booleanFromText,
  describeConversionResult,
  numberFromText,
  withoutNegativeZero,
  type ValueConversion,
} from "../../conversions.js";
import { formatAngle } from "../../angle.js";
import { formatDuration } from "../../duration.js";
import { RuntimeFault } from "../errors.js";
import { messageText } from "./text-length.js";
import { quotedText } from "./value-text.js";
import type { SerializableRuntimeValue } from "./serializable-values.js";
import { isAngle, isAnyDuration, isDict, isList, isObject, isSet } from "./value-predicates.js";
import { describeValue, VALUE_KINDS } from "../../value-kinds.js";
import { ROUND_COUNT_FIX } from "../../loop-rules.js";
import type { MissingField } from "./expected-reading.js";
import { copySpan } from "../../plan/source-location.js";

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
  const taken =
    mismatch.path === ""
      ? describeShownValue(value)
      : `${describeValue(value)} with ${typeof mismatch.value === "number" ? `${describeValue(mismatch.value)} ` : ""}${describeShownValue(mismatch.value)} at ${mismatch.path}`;
  throw new RuntimeFault(
    "TSR058",
    `${capitalize(check.place)} holds ${describeType(check.type)}, so it cannot take ${taken}.${typeFix(mismatch)}`,
    copySpan(span),
  );
}

/**
 * Checks a selected fallback or default (ADR 0021 rule 7.1, `BinaryExpressionPlan.fallbackCheck`): `null` always passes;
 * any other value is checked as `assertValueType` checks it.
 */
export function assertFallbackType(
  value: SerializableRuntimeValue,
  check: TypeCheckPlan,
  span: SourceSpan | PlanSourceLocation,
): void {
  if (value !== null) assertValueType(value, check, span);
}

/**
 * A value as a message shows it: text, a number, true or false, or a duration or an angle with its bounded value, such
 * as `text (string) "3"`, and any other value by its kind.
 */
export function describeShownValue(value: SerializableRuntimeValue): string {
  if (typeof value === "string") return `text (string) ${quotedText(messageText(value))}`;
  if (typeof value === "number") return String(withoutNegativeZero(value));
  if (typeof value === "boolean") return `${value} (boolean)`;
  if (isAnyDuration(value)) return formatDuration(value);
  if (isAngle(value)) return formatAngle(value);
  return describeValue(value);
}

/**
 * That a conversion cannot convert `value`, and for text why (V30 §13, §35): the compile error for text the compiler can
 * see, and the start of the runtime error, which goes on with what to do.
 */
export function cannotConvert(
  name: string,
  conversion: ValueConversion,
  value: SerializableRuntimeValue,
): string {
  const problem = typeof value === "string" ? (conversion.textProblem(value) ?? "") : "";
  return `${name}(...) cannot convert ${describeShownValue(value)} to ${describeConversionResult(conversion.result)}${problem}.`;
}

/** A value where a message lists the texts it accepts: text as it is quoted, and any other value as `describeShownValue`. */
export function shownChoice(value: SerializableRuntimeValue): string {
  return typeof value === "string" ? quotedText(messageText(value)) : describeShownValue(value);
}

/** How to make the part that does not fit fit: round a fraction, convert text, or check for null. */
function typeFix({ value, type }: TypeMismatch): string {
  const kinds = new Set(
    type.kind === "union" ? type.members.map((member) => member.kind) : [type.kind],
  );
  if (value === null) return " Check that the value is not null first.";
  if (typeof value === "number" && kinds.has("integer") && !kinds.has("number"))
    return ROUND_COUNT_FIX;
  if (typeof value === "string") {
    if ((kinds.has("integer") || kinds.has("number")) && numberFromText(value) !== undefined)
      return ` Convert the text with ${kinds.has("number") ? "toNumber" : "toInteger"}(...) first.`;
    if (kinds.has("boolean") && booleanFromText(value) !== undefined)
      return " Convert the text with toBoolean(...) first.";
  }
  if ((typeof value === "number" || typeof value === "boolean") && kinds.has("string"))
    return " Convert it with toString(...) first.";
  return "";
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
  return `Storage key ${JSON.stringify(key)} is loaded as ${describeType(type)} here, but the saved value ${saved}. This load uses its default, and the saved value is kept.`;
}

/**
 * The developer warning `TSW016` for a field of a stored record that a load takes from its default, missing or of
 * another type (V30 §25, `StorageLoadExpressionPlan.repair`).
 */
export function storedFieldMismatch(key: string, field: MissingField): string {
  const name = field.path.join(".");
  const saved =
    field.found === undefined ? `has no '${name}'` : `has ${describeValue(field.found)} there`;
  return `Storage key ${JSON.stringify(key)} is loaded with '${name}' as ${describeType(field.type)} here, but the saved value ${saved}. This load takes '${name}' from its default, and the saved value is kept.`;
}

/** The developer warning `TSW020` for JSON of another kind than `fromJson` reads it as, which gives its default. */
export function jsonKindMismatch(value: SerializableRuntimeValue, type: TypePlan): string {
  const mismatch = findTypeMismatch(value, type);
  const found =
    mismatch === null || mismatch.path === ""
      ? `it is ${describeValue(value)}`
      : `it has ${describeValue(mismatch.value)} at '${mismatch.path}'`;
  return `'fromJson(...)' reads this JSON as ${describeType(type)}, but ${found}, so the call gives its default.`;
}

/** The developer warning `TSW020` for a field of JSON read as an object that `fromJson` takes from its default. */
export function jsonFieldMismatch(field: MissingField): string {
  const name = field.path.join(".");
  const found =
    field.found === undefined ? `the JSON has no '${name}'` : `it is ${describeValue(field.found)}`;
  return `'fromJson(...)' reads '${name}' of this JSON as ${describeType(field.type)}, but ${found}, so the call takes '${name}' from its default.`;
}

interface TypeMismatch {
  readonly value: SerializableRuntimeValue;
  /** The type the part does not fit. */
  readonly type: TypePlan;
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
      mismatch = {
        value: frame.value,
        type: frame.type,
        path: frames.map((outer) => outer.step).join(""),
      };
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
    case "never":
      // No value fits, so a list of it is only ever empty, as for an element both list types share.
      return false;
    default:
      return VALUE_KINDS[type.kind].is(value);
  }
}

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
      descriptions.push(
        current.kind === "never" ? "no value" : VALUE_KINDS[current.kind].description,
      );
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
