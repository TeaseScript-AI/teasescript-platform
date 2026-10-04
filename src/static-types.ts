import type { ScalarTypeName, TypeAnnotation } from "./ast.js";
import { compileChild, runCompileTask, type CompileTask } from "./compiler/continuation.js";
import type { SourceSpan } from "./source.js";

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
  | { readonly kind: "scalar"; readonly name: ScalarTypeName }
  | { readonly kind: "list" | "set"; readonly element: StaticType }
  | { readonly kind: "object"; readonly properties: PropertyTable | null }
  | { readonly kind: "union"; readonly members: readonly StaticType[] }
  | { readonly kind: "range" | "timer" | "media" | "speaker" }
  | OpenType;

/** A type decided by the first value stored in its place; `resolved` stays `null` until then. */
export interface OpenType {
  readonly kind: "open";
  resolved: StaticType | null;
  /** Where the first value decided the type, for messages that name both places. */
  resolvedAt: SourceSpan | null;
  /** Whether `null` was stored before the first other value, which then makes the decided type optional. */
  sawNull: boolean;
}

/**
 * The properties of an object value with their types, each kept from its first value (ADR 0021 rule 1.4). `null`
 * stands for an object whose properties are unknown. A table belongs to one place, such as a variable or the elements
 * of a list, and grows when assignment adds a property.
 */
export type PropertyTable = Map<string, StaticType>;

export const UNKNOWN_TYPE: StaticType = Object.freeze({ kind: "unknown" });
const NEVER_TYPE: StaticType = Object.freeze({ kind: "never" });
export const NULL_TYPE: StaticType = Object.freeze({ kind: "null" });
const ANY_OBJECT_TYPE: StaticType = Object.freeze({ kind: "object", properties: null });

function scalar(name: ScalarTypeName): StaticType {
  return { kind: "scalar", name };
}

export const STRING_TYPE = scalar("string");
export const BOOLEAN_TYPE = scalar("boolean");
export const INTEGER_TYPE = scalar("integer");
export const NUMBER_TYPE = scalar("number");
export const DURATION_TYPE = scalar("duration");

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

export function isNumeric(type: StaticType): boolean {
  return isScalar(type, "integer", "number");
}

/** Whether the compiler knows anything about values of this type. */
export function isKnown(type: StaticType): boolean {
  const value = resolved(type);
  return value.kind !== "unknown" && value.kind !== "open" && value.kind !== "never";
}

export function typeFromAnnotation(annotation: TypeAnnotation): StaticType {
  const named = scalar(annotation.name);
  const collection =
    annotation.collection === null ? named : { kind: annotation.collection, element: named };
  return annotation.optional ? optional(collection) : collection;
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
function union(types: readonly StaticType[]): StaticType {
  const members: StaticType[] = [];
  const pending = [...types];
  while (pending.length > 0) {
    const type = resolved(pending.shift()!);
    if (type.kind === "union") {
      pending.unshift(...type.members);
      continue;
    }
    if (type.kind === "unknown") return UNKNOWN_TYPE;
    if (type.kind === "never") continue;
    if (members.some((member) => includes(member, type))) continue;
    for (let index = members.length - 1; index >= 0; index -= 1)
      if (includes(type, members[index]!)) members.splice(index, 1);
    members.push(type);
  }
  if (members.length === 0) return NEVER_TYPE;
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

/** The type with decided open slots followed and a union normalized again, because decisions can merge members. */
function canonical(type: StaticType): StaticType {
  const value = resolved(type);
  return value.kind === "union" ? union(value.members) : value;
}

/** The members of a union in canonical form, or the type itself. */
export function members(type: StaticType): readonly StaticType[] {
  const value = canonical(type);
  return value.kind === "union" ? value.members : [value];
}

/** The type without `null`. Operations on a possibly null value act on its other members (V30 §34). */
export function nonNullType(type: StaticType): StaticType {
  return union(members(type).filter((member) => member.kind !== "null"));
}

export function isNullable(type: StaticType): boolean {
  return members(type).some((member) => member.kind === "null");
}

/** Whether every value of `inner` is also a value of `outer`, ignoring open slots. It keeps unions minimal. */
function includes(outer: StaticType, inner: StaticType): boolean {
  return runCompileTask(includesTask(outer, inner));
}

function* includesTask(outerType: StaticType, innerType: StaticType): CompileTask<boolean> {
  const outer = resolved(outerType);
  const inner = resolved(innerType);
  if (outer.kind === "unknown" || inner.kind === "never") return true;
  if (outer.kind === "open" || inner.kind === "open" || inner.kind === "unknown") return false;
  if (inner.kind === "union") {
    for (const member of inner.members)
      if (!(yield* compileChild(includesTask(outer, member)))) return false;
    return true;
  }
  if (outer.kind === "union") {
    for (const member of outer.members)
      if (yield* compileChild(includesTask(member, inner))) return true;
    return false;
  }
  switch (outer.kind) {
    case "scalar":
      return (
        inner.kind === "scalar" &&
        (inner.name === outer.name || (outer.name === "number" && inner.name === "integer"))
      );
    case "list":
    case "set":
      return (
        inner.kind === outer.kind &&
        (yield* compileChild(includesTask(outer.element, inner.element)))
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
 * where an object is required when their shared properties fit; other properties are added. A possibly null value is
 * not a definite contradiction, because nullable use is a separate rule (V30 §34). An undecided open target accepts
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
    const nonNull = source.members.filter((member) => member.kind !== "null");
    for (const member of nonNull.length === 0 ? source.members : nonNull)
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

/**
 * Records what a stored value decides: undecided open slots in `target` take the value's type, and an object place
 * adds the value's new properties. Call it only after {@link isAssignable} accepted the value.
 */
export function settle(target: StaticType, source: StaticType, at: SourceSpan): void {
  runCompileTask(settleTask(target, source, at));
}

function* settleTask(
  target: StaticType,
  sourceType: StaticType,
  at: SourceSpan,
): CompileTask<void> {
  const source = canonical(sourceType);
  if (source.kind === "unknown" || source.kind === "never") return;
  if (target.kind === "open") {
    if (target.resolved !== null) {
      yield* compileChild(settleTask(target.resolved, source, at));
      return;
    }
    if (nonNullType(source).kind === "never") {
      target.sawNull = true;
      return;
    }
    // The first other value decides the type by the `let` rule; an earlier null keeps it optional.
    const value = yield* compileChild(placeTask(source));
    target.resolved = target.sawNull ? optional(value) : value;
    target.resolvedAt = at;
    return;
  }
  if (target.kind === "union") {
    const open = target.members.find((member) => member.kind === "open");
    if (open !== undefined) {
      yield* compileChild(settleTask(open, source, at));
      return;
    }
    for (const member of target.members) {
      const kind = resolved(member).kind;
      if ((kind === "object" || kind === "list" || kind === "set") && kind === source.kind)
        yield* compileChild(settleTask(resolved(member), source, at));
    }
    return;
  }
  if ((target.kind === "list" || target.kind === "set") && source.kind === target.kind) {
    yield* compileChild(settleTask(target.element, source.element, at));
    return;
  }
  if (target.kind === "object" && source.kind === "object") {
    if (target.properties === null || source.properties === null) return;
    for (const [name, value] of source.properties) {
      const kept = target.properties.get(name);
      if (kept === undefined) target.properties.set(name, yield* compileChild(placeTask(value)));
      else yield* compileChild(settleTask(kept, value, at));
    }
  }
}

/**
 * A copy for a new place, such as a variable initialized from another variable: values are copied, so the new place
 * gets its own property tables and its own undecided slots.
 */
export function copyType(type: StaticType): StaticType {
  return runCompileTask(copyTask(type));
}

function* copyTask(typeToCopy: StaticType): CompileTask<StaticType> {
  const type = resolved(typeToCopy);
  switch (type.kind) {
    case "open":
      return openType();
    case "list":
    case "set":
      return { kind: type.kind, element: yield* compileChild(copyTask(type.element)) };
    case "object": {
      if (type.properties === null) return type;
      const properties: PropertyTable = new Map();
      for (const [name, value] of type.properties)
        properties.set(name, yield* compileChild(copyTask(value)));
      return { kind: "object", properties };
    }
    case "union": {
      const copied: StaticType[] = [];
      for (const member of type.members) copied.push(yield* compileChild(copyTask(member)));
      return { kind: "union", members: copied };
    }
    default:
      return type;
  }
}

/**
 * The type a new place keeps when it starts with a value of `type` (ADR 0021 rules 1.2 and 1.3): a copy in which
 * `null` leaves the non-null type open, so the first non-null value decides it, as for `let x = null` or the elements
 * of `[null]`.
 */
export function placeType(type: StaticType): StaticType {
  return runCompileTask(placeTask(type, true));
}

/**
 * Like {@link placeType} for a type that no other place shares, such as the type of a literal that was just built: it
 * is used as it is instead of being copied.
 */
export function freshPlaceType(type: StaticType): StaticType {
  return runCompileTask(placeTask(type, false));
}

function* placeTask(typeToPlace: StaticType, copy = true): CompileTask<StaticType> {
  const type = resolved(typeToPlace);
  if (type.kind === "null") return optional(openType());
  if (type.kind === "never") return openType();
  if (type.kind === "list" || type.kind === "set")
    return { kind: type.kind, element: yield* compileChild(placeTask(type.element, copy)) };
  return copy ? yield* compileChild(copyTask(type)) : type;
}

/** The type with every undecided part unknown, for a place that no later value may decide, such as a parameter. */
export function decidedType(type: StaticType): StaticType {
  return runCompileTask(decidedTask(type));
}

function* decidedTask(typeToDecide: StaticType): CompileTask<StaticType> {
  const type = resolved(typeToDecide);
  switch (type.kind) {
    case "open":
      return UNKNOWN_TYPE;
    case "list":
    case "set":
      return { kind: type.kind, element: yield* compileChild(decidedTask(type.element)) };
    case "union": {
      const decided: StaticType[] = [];
      for (const member of type.members) decided.push(yield* compileChild(decidedTask(member)));
      return union(decided);
    }
    case "object": {
      if (type.properties === null) return type;
      const properties: PropertyTable = new Map();
      for (const [name, value] of type.properties)
        properties.set(name, yield* compileChild(decidedTask(value)));
      return { kind: "object", properties };
    }
    default:
      return type;
  }
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
  const parts =
    type.kind === "list" || type.kind === "set"
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
 * The one type of values that must share a type, such as the elements of a list literal or the values a function
 * returns, or `undefined` when they mix types (ADR 0021 rule 1.3). Integers and numbers together are numbers, `null`
 * makes the type optional, objects merge their properties, and an unknown value makes the result unknown. The compiler
 * never infers a union here.
 */
export function joinTypes(...types: readonly StaticType[]): StaticType | undefined {
  let result: StaticType | undefined = NEVER_TYPE;
  for (const type of types) {
    result = runCompileTask(joinTask(result, type));
    if (result === undefined) return undefined;
  }
  return result;
}

function* joinTask(
  leftType: StaticType,
  rightType: StaticType,
): CompileTask<StaticType | undefined> {
  const left = canonical(leftType);
  const right = canonical(rightType);
  if (left.kind === "unknown" || right.kind === "unknown") return UNKNOWN_TYPE;
  if (left.kind === "never" || left.kind === "open") return right;
  if (right.kind === "never" || right.kind === "open") return left;
  const leftValue = nonNullType(left);
  const rightValue = nonNullType(right);
  const value =
    leftValue.kind === "never"
      ? rightValue
      : rightValue.kind === "never"
        ? leftValue
        : yield* compileChild(joinValuesTask(leftValue, rightValue));
  if (value === undefined) return undefined;
  return isNullable(left) || isNullable(right) ? optional(value) : value;
}

/** Property tables that a join built; joining more objects into one extends it instead of copying it again. */
const joinedTables = new WeakSet<PropertyTable>();

function* joinValuesTask(left: StaticType, right: StaticType): CompileTask<StaticType | undefined> {
  if (left.kind === "object" && right.kind === "object") {
    if (left.properties === null || right.properties === null) return ANY_OBJECT_TYPE;
    const properties: PropertyTable = joinedTables.has(left.properties)
      ? left.properties
      : new Map(left.properties);
    joinedTables.add(properties);
    for (const [name, type] of right.properties) {
      const kept = properties.get(name);
      const joined = kept === undefined ? type : yield* compileChild(joinTask(kept, type));
      if (joined === undefined) return undefined;
      properties.set(name, joined);
    }
    return { kind: "object", properties };
  }
  if ((left.kind === "list" || left.kind === "set") && right.kind === left.kind) {
    const element = yield* compileChild(joinTask(left.element, right.element));
    return element === undefined ? undefined : { kind: left.kind, element };
  }
  if (includes(left, right)) return left;
  if (includes(right, left)) return right;
  return undefined;
}

/** The type of a list or set element, of a loop variable over an iterable, or `undefined` for other types. */
export function elementType(type: StaticType): StaticType | undefined {
  const value = resolved(nonNullType(type));
  if (value.kind === "list" || value.kind === "set") return value.element;
  if (value.kind === "range") return INTEGER_TYPE;
  return undefined;
}

/** Whether a type can be written as an annotation today: a scalar type, or a list or set of one. */
export function isAnnotatable(type: StaticType): boolean {
  const value = resolved(nonNullType(type));
  if (value.kind === "scalar") return true;
  if (value.kind !== "list" && value.kind !== "set") return false;
  return resolved(value.element).kind === "scalar";
}

/** The author-facing type name, as written in an annotation where one exists. */
export function typeName(type: StaticType): string {
  return runCompileTask(typeNameTask(type));
}

function* typeNameTask(typeToName: StaticType): CompileTask<string> {
  const type = canonical(typeToName);
  switch (type.kind) {
    case "unknown":
    case "open":
      return "unknown";
    case "never":
      return "never";
    case "null":
      return "null";
    case "scalar":
      return type.name;
    case "list":
    case "set": {
      const element = canonical(type.element);
      if (!isKnown(element)) return type.kind;
      const name = yield* compileChild(typeNameTask(element));
      const written = name.includes(" | ") ? `(${name})` : name;
      return type.kind === "list" ? `${written}[]` : `${written} set`;
    }
    case "object":
      return "object";
    case "union": {
      const nonNull = union(type.members.filter((member) => member.kind !== "null"));
      if (nonNull.kind !== "union" && members(type).length === 2)
        return `${yield* compileChild(typeNameTask(nonNull))}?`;
      const names: string[] = [];
      for (const member of type.members) names.push(yield* compileChild(typeNameTask(member)));
      return names.join(" | ");
    }
    default:
      return type.kind;
  }
}

const SCALAR_DESCRIPTIONS: Readonly<Record<ScalarTypeName, string>> = {
  string: "text (string)",
  integer: "a whole number (integer)",
  number: "a number",
  boolean: "true or false (boolean)",
  duration: "a duration",
  date: "a date",
  time: "a time",
  datetime: "a date and time",
};

/** A plain-language description of a value of `type` for diagnostics. */
export function describeValue(type: StaticType): string {
  const value = canonical(type);
  switch (value.kind) {
    case "scalar":
      return SCALAR_DESCRIPTIONS[value.name];
    case "list":
    case "set": {
      const name = typeName(value);
      return name === value.kind ? `a ${value.kind}` : `a ${value.kind} (${name})`;
    }
    case "union":
      return value.members.map(describeValue).join(" or ");
    case "null":
      return "null";
    case "object":
      return "an object";
    case "never":
      return "no value";
    case "unknown":
    case "open":
      return "a value";
    case "timer":
      return "a timer handle";
    case "media":
      return "a media handle";
    default:
      return `a ${value.kind}`;
  }
}

/**
 * The result type of arithmetic on known operand types, or `undefined` when the operator does not support them.
 * Integer arithmetic stays integer except `/`, which always gives a number (ADR 0021 rule 2.2).
 */
export function arithmeticType(
  operator: string,
  leftType: StaticType,
  rightType: StaticType,
): StaticType | undefined {
  const left = resolved(leftType);
  const right = resolved(rightType);
  if (left.kind !== "scalar" || right.kind !== "scalar") return undefined;
  const numeric = (name: ScalarTypeName): boolean => name === "integer" || name === "number";
  if (numeric(left.name) && numeric(right.name)) {
    return left.name === "integer" && right.name === "integer" && operator !== "/"
      ? INTEGER_TYPE
      : NUMBER_TYPE;
  }
  if (left.name === "duration" && right.name === "duration") {
    if (operator === "+" || operator === "-") return DURATION_TYPE;
    if (operator === "/") return NUMBER_TYPE;
    return undefined;
  }
  if (left.name === "duration" && numeric(right.name) && (operator === "*" || operator === "/"))
    return DURATION_TYPE;
  if (numeric(left.name) && right.name === "duration" && operator === "*") return DURATION_TYPE;
  return undefined;
}
