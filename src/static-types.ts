import type { ScalarTypeName } from "./ast.js";
import { compileChild, runCompileTask, type CompileTask } from "./compiler/continuation.js";
import type { SourceSpan } from "./source.js";
import { mergedOrigins, type Origins } from "./static-types/origins.js";
import type { PropertyTable } from "./static-types/property-tables.js";
import {
  familyOf,
  hasIdentity,
  VALUE_KINDS,
  type PlainKind,
  type ValueKind,
} from "./value-kinds.js";

/**
 * A compile-time value type (ADR 0021). `unknown` stands for values the compiler cannot know, such as untyped storage,
 * host data, and unknown parameters; they are never rejected at compile time. `never` has no values, such as the
 * non-null part of `null`. An `open` slot is a type that the first value stored there decides, as in `let x = null`
 * or `let items = []`.
 *
 * Types can be as deep as the literals they come from, so every operation that walks a type uses compile-time
 * continuations instead of native recursion.
 */
export type StaticType =
  | { readonly kind: "unknown" }
  | { readonly kind: "never" }
  | { readonly kind: "null" }
  | {
      readonly kind: "scalar";
      readonly name: ScalarTypeName;
      /** The only values it may be, as for an `askChoice` result; places always keep the plain type. */
      readonly values?: readonly ScalarValue[];
      /**
       * For a number, the variables without a type annotation that its value derives from: when one of them widens to
       * a number, so does this value (ADR 0021 rule 1.2).
       */
      readonly origins?: Origins;
    }
  /** A list, a set, or a dict, whose element is the type of the dict's values; dict keys are always text. */
  | { readonly kind: "list" | "set" | "dict"; readonly element: StaticType }
  | { readonly kind: "object"; readonly properties: PropertyTable | null }
  | { readonly kind: "union"; readonly members: readonly StaticType[] }
  /**
   * A type of the kind's own without parts (`PlainKind`), such as `range` and `timer`. `camera` is the handle of a camera
   * view (`let view = showCamera`), and `permanentButton` the identifier of a permanent button; scripts cannot name
   * either as a type. `messageHandle` is the handle of a shown message.
   */
  | { readonly kind: Exclude<PlainKind, "null"> }
  | OpenType;

/** A list, set, or dict type. */
export type CollectionType = Extract<StaticType, { kind: "list" | "set" | "dict" }>;

export function isCollection(type: StaticType): type is CollectionType {
  return type.kind === "list" || type.kind === "set" || type.kind === "dict";
}

/** A type decided by the first value stored in its place; `resolved` stays `null` until then. */
export interface OpenType {
  readonly kind: "open";
  resolved: StaticType | null;
  /** Where the first value decided the type, for messages that name both places. */
  resolvedAt: SourceSpan | null;
  /** Whether `null` was stored before the first other value, which then makes the decided type optional. */
  sawNull: boolean;
  /** Whether an integer decides the slot as a number, for a variable that also takes non-whole numbers. */
  widens?: boolean;
  /** For the slot of a variable without a type annotation, that variable, which the deciding number derives from. */
  origins?: Origins;
  /** For a copy of a slot that was still undecided, that slot, whose decision the copy shares (ADR 0021 rule 1.2). */
  copiedFrom?: OpenType;
  /** Whether a read or a copy saw the slot while it was undecided, so a later decision must reach that point too. */
  observed?: boolean;
  /** When a value decided the slot, counted in checking order, so the first of several decisions can be found. */
  order?: number;
  /**
   * Where a value the compiler cannot know was first stored while the slot was undecided. Such a value decides nothing
   * (ADR 0021 rule 1.7), but what the slot holds is then checked at runtime where a known type is required.
   */
  heldUnknown?: SourceSpan;
}

export const UNKNOWN_TYPE: StaticType = Object.freeze({ kind: "unknown" });
export const NEVER_TYPE: StaticType = Object.freeze({ kind: "never" });
export const NULL_TYPE: StaticType = Object.freeze({ kind: "null" });
export const ANY_OBJECT_TYPE: StaticType = Object.freeze({ kind: "object", properties: null });

/** A literal value that a scalar type may be restricted to, such as one button value of an `askChoice`. */
export type ScalarValue = string | number | boolean;

export function scalar(name: ScalarTypeName): StaticType {
  return { kind: "scalar", name };
}

export function scalarOrigins(type: StaticType): Origins | undefined {
  return type.kind === "scalar" ? type.origins : undefined;
}

/** A numeric type that also derives from `origins`; other types are returned as they are. */
export function withOrigins(type: StaticType, origins: Origins | undefined): StaticType {
  if (origins === undefined) return type;
  const value = resolved(type);
  if (value.kind === "scalar") {
    if (value.name !== "integer" && value.name !== "number") return type;
    const merged = mergedOrigins(value.origins, origins);
    if (merged === undefined || merged === value.origins) return value;
    return { ...value, origins: merged };
  }
  if (value.kind !== "union" || !value.members.some(isNumeric)) return type;
  return union(value.members.map((member) => withOrigins(member, origins)));
}

/** The type with its own numbers deriving from exactly `origins`, or from nothing; parts inside it keep theirs. */
export function replacedOrigins(type: StaticType, origins: Origins | undefined): StaticType {
  const value = resolved(type);
  if (value.kind === "scalar") {
    if (value.name !== "integer" && value.name !== "number") return value;
    if (value.origins === origins) return value;
    if (origins !== undefined) return { ...value, origins };
    return value.values === undefined
      ? { kind: "scalar", name: value.name }
      : { kind: "scalar", name: value.name, values: value.values };
  }
  if (value.kind !== "union" || !value.members.some(isNumeric)) return value;
  return union(value.members.map((member) => replacedOrigins(member, origins)));
}

/** A scalar type restricted to the given values; other types are returned as they are. */
export function withValues(type: StaticType, values: readonly ScalarValue[]): StaticType {
  const value = resolved(type);
  return value.kind === "scalar" ? { ...value, values: [...new Set(values)] } : value;
}

/**
 * A value that a value of a restricted type can be. A duration stands for its milliseconds and an angle for its degrees,
 * and neither equals a number of the same size.
 */
export interface PossibleValue {
  readonly value: ScalarValue | null;
  /** What the number measures: a duration, an angle, or `null` for a plain value. */
  readonly measure: "duration" | "angle" | null;
}

/**
 * The values a value of this type can only be, with `null` for a possibly null value, or `undefined` when it may be
 * any value of its type. Only an `askChoice` with literal button values restricts a type.
 */
export function possibleValues(type: StaticType): readonly PossibleValue[] | undefined {
  const possible: PossibleValue[] = [];
  for (const member of members(type)) {
    if (member.kind === "null") possible.push({ value: null, measure: null });
    else if (member.kind === "scalar" && member.values !== undefined) {
      const measure = member.name === "duration" || member.name === "angle" ? member.name : null;
      for (const value of member.values) possible.push({ value, measure });
    } else return undefined;
  }
  return possible;
}

/**
 * Whether a value of this type may be equal (`==`) to one of `others`: false only when its possible values exclude
 * them all. Possible values are finite literals, so set membership agrees with `===`.
 */
export function mayEqualAny(type: StaticType, others: readonly PossibleValue[]): boolean {
  if (others.length === 0) return false;
  const possible = possibleValues(type);
  if (possible === undefined) return true;
  const measured = new Map<PossibleValue["measure"], Set<ScalarValue | null>>();
  for (const { value, measure } of possible) {
    const values = measured.get(measure) ?? new Set();
    values.add(value);
    measured.set(measure, values);
  }
  return others.some(({ value, measure }) => measured.get(measure)?.has(value) === true);
}

function isSubset(inner: readonly ScalarValue[], outer: readonly ScalarValue[]): boolean {
  const kept = new Set(outer);
  return inner.every((value) => kept.has(value));
}

/** Whether two scalar types belong together in a union: the same type, or both numbers. */
/** Whether two scalar types are of one family (`familyOf`), as an integer and a number are. */
export function sameFamily(left: StaticType, right: StaticType): boolean {
  return left.kind === "scalar" && right.kind === "scalar" && sameScalarFamily(left, right);
}

export function sameScalarFamily(
  left: Extract<StaticType, { kind: "scalar" }>,
  right: Extract<StaticType, { kind: "scalar" }>,
): boolean {
  return familyOf(left.name) === familyOf(right.name);
}

/** One scalar type for two of the same family; it keeps only values that both restrict. */
export function mergeScalars(left: StaticType, right: StaticType): StaticType {
  if (left.kind !== "scalar" || right.kind !== "scalar") return left;
  const name = left.name === right.name ? left.name : "number";
  const origins = mergedOrigins(left.origins, right.origins);
  const values =
    left.values === undefined || right.values === undefined
      ? undefined
      : [...new Set([...left.values, ...right.values])];
  return {
    kind: "scalar",
    name,
    ...(values === undefined ? {} : { values }),
    ...(origins === undefined ? {} : { origins }),
  };
}

export const STRING_TYPE = scalar("string");
export const BOOLEAN_TYPE = scalar("boolean");
export const INTEGER_TYPE = scalar("integer");
export const NUMBER_TYPE = scalar("number");
export const DURATION_TYPE = scalar("duration");
export const CALENDAR_DURATION_TYPE = scalar("calendarDuration");
export const ANGLE_TYPE = scalar("angle");
export const DATE_TYPE = scalar("date");
export const TIME_TYPE = scalar("time");
export const DATETIME_TYPE = scalar("datetime");
export const SCRIPT_TYPE = scalar("script");
export const REGEX_TYPE = scalar("regex");

export function openType(): OpenType {
  return { kind: "open", resolved: null, resolvedAt: null, sawNull: false };
}

/** Follows decided open slots. An undecided slot stays `open`. */
export function resolved(type: StaticType): StaticType {
  while (type.kind === "open" && type.resolved !== null) type = type.resolved;
  return type;
}

export function isScalar(type: StaticType, ...names: ScalarTypeName[]): boolean {
  const value = resolved(type);
  return value.kind === "scalar" && names.includes(value.name);
}

/** Whether a type is of the number family (`familyOf`): an integer or a number. */
export function isNumeric(type: StaticType): boolean {
  const kind = valueKindOfType(type);
  return kind !== undefined && familyOf(kind) === "number";
}

/** Whether the compiler knows anything about values of this type. */
/** Whether a value of this type may be one the compiler cannot know, which a known place checks at runtime. */
export function mayBeUnknown(type: StaticType): boolean {
  return containsType(
    type,
    (part) => part.kind === "unknown" || (part.kind === "open" && part.heldUnknown !== undefined),
  );
}

/**
 * Whether a value of this type is read from a place that no value decided yet but that held a value the compiler cannot
 * know, such as an element of `[]` after `add(load(key, default: null))`. Such a read gives a value of unknown type, as
 * any other would (rule 1.7): a later value does not decide a variable that holds it, and a known place checks it when
 * the script runs (#859).
 */
export function readsHeldUnknown(type: StaticType): boolean {
  return members(type).some((part) => part.kind === "open" && part.heldUnknown !== undefined);
}

export function isKnown(type: StaticType): boolean {
  const value = resolved(type);
  return value.kind !== "unknown" && value.kind !== "open" && value.kind !== "never";
}

/** Whether the compiler holds a type of `kind` as a `scalar` type of its name. */
export function isScalarKind(kind: ValueKind): kind is ScalarTypeName {
  return VALUE_KINDS[kind].type === "scalar";
}

/**
 * The kind of value a type holds (`VALUE_KINDS`), or `undefined` for a type of several kinds, a type the compiler does
 * not know, and `never`.
 */
export function valueKindOfType(type: StaticType): ValueKind | undefined {
  const value = resolved(type);
  switch (value.kind) {
    case "scalar":
      return value.name;
    case "unknown":
    case "never":
    case "open":
    case "union":
      return undefined;
    default:
      return value.kind;
  }
}

/** `T?`, which is `T | null`. */
export function optional(type: StaticType): StaticType {
  return union([type, NULL_TYPE]);
}

/**
 * The union of `types` in one canonical form: nested unions are flattened, a member that another member already
 * includes is dropped (an integer is a number), and a single member stands alone. Any unknown member makes the whole
 * union unknown, and an empty union is `never`.
 */
export function union(types: readonly StaticType[]): StaticType {
  const present = types.filter((type) => resolved(type).kind !== "never");
  if (present.length === 1) return canonical(present[0]!);
  const members: StaticType[] = [];
  // Nested unions are flattened in order with an explicit stack, so a wide union never spreads its members.
  const stack: { readonly types: readonly StaticType[]; next: number }[] = [{ types, next: 0 }];
  while (stack.length > 0) {
    const top = stack.at(-1)!;
    if (top.next === top.types.length) {
      stack.pop();
      continue;
    }
    const type = resolved(top.types[top.next++]!);
    if (type.kind === "union") {
      stack.push({ types: type.members, next: 0 });
      continue;
    }
    if (type.kind === "unknown") return UNKNOWN_TYPE;
    if (type.kind === "never") continue;
    // Scalars of one family share one member, so restricted values join: "a" or "b" is one string.
    const family = members.findIndex((member) => sameFamily(member, type));
    if (family >= 0) {
      members[family] = mergeScalars(members[family]!, type);
      continue;
    }
    // A member that includes another keeps what the other's value derives from.
    const including = members.findIndex((member) => includes(member, type));
    if (including >= 0) {
      members[including] = withOrigins(members[including]!, scalarOrigins(type));
      continue;
    }
    let origins = scalarOrigins(type);
    for (let index = members.length - 1; index >= 0; index -= 1)
      if (includes(type, members[index]!)) {
        origins = mergedOrigins(origins, scalarOrigins(members[index]!));
        members.splice(index, 1);
      }
    members.push(withOrigins(type, origins));
  }
  if (members.length === 0) return NEVER_TYPE;
  if (members.length === 1) return members[0]!;
  const result: StaticType = { kind: "union", members };
  if (isSettled(result)) settledForms.set(result, result);
  return result;
}

/** Whether a type can no longer change: it holds no undecided slot and no property table that may still grow. */
function isSettled(type: StaticType): boolean {
  return !containsType(
    type,
    (part) => part.kind === "open" || (part.kind === "object" && part.properties !== null),
  );
}

/**
 * Canonical forms of unions whose members can no longer change, such as written types: they hold no undecided slot and
 * no property table that may still grow, so normalizing them once is enough.
 */
export const settledForms = new WeakMap<StaticType, StaticType>();

/** The type with decided open slots followed and a union normalized again, because decisions can merge members. */
export function canonical(type: StaticType): StaticType {
  const value = resolved(type);
  if (value.kind !== "union") return value;
  const settled = settledForms.get(value);
  if (settled !== undefined) return settled;
  const normalized = union(value.members);
  // A union already in canonical form stays the same object, so what is cached for it is found again.
  const result =
    normalized.kind === "union" &&
    normalized.members.length === value.members.length &&
    normalized.members.every((member, index) => member === value.members[index])
      ? value
      : normalized;
  if (isSettled(result)) {
    settledForms.set(value, result);
    settledForms.set(result, result);
  }
  return result;
}

/** Some members of a union in canonical form, which stay canonical because no member includes another. */
export function memberSubset(type: StaticType, kept: readonly StaticType[]): StaticType {
  if (kept.length === members(type).length) return canonical(type);
  if (kept.length === 0) return NEVER_TYPE;
  if (kept.length === 1) return kept[0]!;
  const result: StaticType = { kind: "union", members: kept };
  if (settledForms.has(canonical(type))) settledForms.set(result, result);
  return result;
}

/** The members of a union in canonical form, or the type itself. */
export function members(type: StaticType): readonly StaticType[] {
  const value = canonical(type);
  return value.kind === "union" ? value.members : [value];
}

/** The type without `null`, such as what a value holds after `!= null`. */
export function nonNullType(type: StaticType): StaticType {
  const all = members(type);
  const kept = all.filter((member) => member.kind !== "null");
  return kept.length === all.length ? canonical(type) : memberSubset(type, kept);
}

export function isNullable(type: StaticType): boolean {
  return members(type).some((member) => member.kind === "null");
}

/** Whether every value of `inner` is also a value of `outer`, ignoring open slots. It keeps unions minimal. */
/** Whether every value of `inner` is also a value of `outer`; an undecided slot is covered by nothing but unknown. */
export function coversType(outer: StaticType, inner: StaticType): boolean {
  return canonical(outer) === canonical(inner) || includes(outer, inner);
}

export function includes(outer: StaticType, inner: StaticType): boolean {
  return runCompileTask(includesTask(outer, inner, false));
}

/**
 * Whether every value of `inner` is also a value of `outer` once each slot of `inner` that no value decided yet, such
 * as the elements of `[]`, takes the type that `outer` has there, as in a list literal (V30 §16).
 */
export function includesOnceDecided(outer: StaticType, inner: StaticType): boolean {
  return runCompileTask(includesTask(outer, inner, true));
}

function* includesTask(
  outerType: StaticType,
  innerType: StaticType,
  undecidedFits: boolean,
): CompileTask<boolean> {
  const outer = resolved(outerType);
  const inner = resolved(innerType);
  if (outer.kind === "unknown" || inner.kind === "never") return true;
  // A slot that held null or a value the compiler cannot know would change the type it joins.
  if (undecidedFits && inner.kind === "open")
    return inner.heldUnknown === undefined && !inner.sawNull;
  if (outer.kind === "open" || inner.kind === "open" || inner.kind === "unknown") return false;
  if (inner.kind === "union") {
    for (const member of inner.members)
      if (!(yield* compileChild(includesTask(outer, member, undecidedFits)))) return false;
    return true;
  }
  if (outer.kind === "union") {
    for (const member of outer.members)
      if (yield* compileChild(includesTask(member, inner, undecidedFits))) return true;
    return false;
  }
  switch (outer.kind) {
    case "scalar":
      return (
        inner.kind === "scalar" &&
        (inner.name === outer.name || (outer.name === "number" && inner.name === "integer")) &&
        (outer.values === undefined ||
          (inner.values !== undefined && isSubset(inner.values, outer.values)))
      );
    case "list":
    case "set":
    case "dict":
      return (
        inner.kind === outer.kind &&
        (yield* compileChild(includesTask(outer.element, inner.element, undecidedFits)))
      );
    case "object":
      return inner.kind === "object" && outer.properties === null;
    default:
      return inner.kind === outer.kind;
  }
}

/**
 * Whether a value of `source` may be stored where `target` is required. Only integer widens, to number. Lists and
 * sets are copied when stored, so an `integer[]` may be stored where a `number[]` is required. Objects may be stored
 * where an object is required when their shared properties fit; other properties are added. A possibly null value fits
 * only a place that takes null too (ADR 0021 rule 1.9). An undecided open target accepts
 * any value, and an undecided open source has no values yet.
 */
export function isAssignable(target: StaticType, source: StaticType): boolean {
  return runCompileTask(assignableTask(target, source));
}

function* assignableTask(targetType: StaticType, sourceType: StaticType): CompileTask<boolean> {
  const target = resolved(targetType);
  const source = canonical(sourceType);
  if (target.kind === "unknown" || source.kind === "unknown") return true;
  if (target.kind === "open" || source.kind === "open" || source.kind === "never") return true;
  if (source.kind === "union") {
    // A possibly null value fits only a place that also takes null (owner decision on #504 Q1).
    for (const member of source.members)
      if (!(yield* compileChild(assignableTask(target, member)))) return false;
    return true;
  }
  if (target.kind === "union") {
    for (const member of target.members)
      if (yield* compileChild(assignableTask(member, source))) return true;
    return false;
  }
  switch (target.kind) {
    case "list":
    case "set":
    case "dict":
      return (
        source.kind === target.kind &&
        (yield* compileChild(assignableTask(target.element, source.element)))
      );
    case "object":
      return (
        source.kind === "object" &&
        (yield* compileChild(misfitTask(target.properties, source.properties))) === undefined
      );
    default:
      return includes(target, source);
  }
}

interface PropertyMisfit {
  readonly name: string;
  readonly kept: StaticType;
  readonly value: StaticType;
}

function* misfitTask(
  target: PropertyTable | null,
  source: PropertyTable | null,
): CompileTask<PropertyMisfit | undefined> {
  if (target === null || source === null) return undefined;
  for (const [name, value] of source) {
    const kept = target.get(name);
    if (kept !== undefined && !(yield* compileChild(assignableTask(kept, value))))
      return { name, kept, value };
  }
  return undefined;
}

/** The first property of an object value whose type does not fit the same property of an object place. */
export function misfitProperty(target: StaticType, source: StaticType): PropertyMisfit | undefined {
  const place = resolved(nonNullType(target));
  const value = resolved(source);
  if (place.kind !== "object" || value.kind !== "object") return undefined;
  return runCompileTask(misfitTask(place.properties, value.properties));
}

/** Whether any part of a value of this type satisfies `test`, looking into lists, sets, unions, and properties. */
export function containsType(type: StaticType, test: (part: StaticType) => boolean): boolean {
  return runCompileTask(containsTask(type, test));
}

function* containsTask(
  typeToSearch: StaticType,
  test: (part: StaticType) => boolean,
): CompileTask<boolean> {
  const type = resolved(typeToSearch);
  if (test(type)) return true;
  const parts = isCollection(type)
    ? [type.element]
    : type.kind === "union"
      ? type.members
      : type.kind === "object" && type.properties !== null
        ? [...type.properties.values()]
        : [];
  for (const part of parts) if (yield* compileChild(containsTask(part, test))) return true;
  return false;
}

/**
 * The non-null part of a type that a value decided, or `never` for `null` and for a place no value decided yet. A place
 * may hold one of several undecided slots, such as a variable given a different null-only variable on each branch.
 */
export function decidedValue(type: StaticType): StaticType {
  return memberSubset(
    type,
    members(type).filter((member) => member.kind !== "null" && member.kind !== "open"),
  );
}

/**
 * Whether a value of a type without members has an identity (`hasIdentity`): a speaker or a handle, which exists only in
 * the session, and every copy of which names the same one.
 */
export function isIdentityType(type: StaticType): boolean {
  const kind = valueKindOfType(type);
  return kind !== undefined && hasIdentity(kind);
}

/**
 * Whether `${...}` and text fields show a value of a type without members as text (`shown`), or may, as one of a type
 * the compiler does not know.
 */
export function isShown(type: StaticType): boolean {
  const kind = valueKindOfType(type);
  return kind === undefined || VALUE_KINDS[kind].shown !== null;
}
