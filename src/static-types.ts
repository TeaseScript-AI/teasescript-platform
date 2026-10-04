import type {
  ForStatement,
  FunctionParameter,
  LetStatement,
  ScalarTypeName,
  TypeAnnotation,
  TypeName,
} from "./ast.js";
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
  | {
      readonly kind: "scalar";
      readonly name: ScalarTypeName;
      /** The only values it may be, as for a `choose` result; places always keep the plain type. */
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
  | { readonly kind: "range" | "timer" | "media" | "speaker" }
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

/** A literal value that a scalar type may be restricted to, such as one button value of a `choose`. */
export type ScalarValue = string | number | boolean;

function scalar(name: ScalarTypeName): StaticType {
  return { kind: "scalar", name };
}

/**
 * What a number may derive from (ADR 0021 rule 1.2): a variable without a type annotation, or an element or property
 * inside one.
 */
export type Origin = Declaration | PartOrigin;

/** The declaration of a variable without a type annotation: `let`, a parameter with a default, or a loop variable. */
export type Declaration = LetStatement | FunctionParameter | ForStatement;

/**
 * An element or property inside a variable without a type annotation, which a number may derive from: the variable and
 * the steps to the part, each a property name or `[]` for the elements of a list or set.
 */
export interface PartOrigin {
  readonly root: Declaration;
  readonly path: readonly string[];
}

/**
 * What a number derives from: origins that merge without copying, so a long sum stays cheap, and that keep every
 * origin they merged, so no dependency of a widening is lost.
 */
class Origins implements Iterable<Origin> {
  readonly #origin: Origin | undefined;
  readonly #parts: readonly Origins[];

  private constructor(origin: Origin | undefined, parts: readonly Origins[]) {
    this.#origin = origin;
    this.#parts = parts;
  }

  static of(origin: Origin): Origins {
    return new Origins(origin, []);
  }

  /** These origins and the other ones. */
  merge(other: Origins | undefined): Origins {
    return other === undefined || other === this ? this : new Origins(undefined, [this, other]);
  }

  /** Each origin once, also when merged groups share parts. */
  *[Symbol.iterator](): Iterator<Origin> {
    const seen = new Set<Origins>();
    const found = new Set<Origin>();
    const pending: Origins[] = [this];
    while (pending.length > 0) {
      const group = pending.pop()!;
      if (seen.has(group)) continue;
      seen.add(group);
      if (group.#origin !== undefined && !found.has(group.#origin)) {
        found.add(group.#origin);
        yield group.#origin;
      }
      for (const part of group.#parts) pending.push(part);
    }
  }
}

function mergedOrigins(left: Origins | undefined, right: Origins | undefined): Origins | undefined {
  return left === undefined ? right : left.merge(right);
}

function scalarOrigins(type: StaticType): Origins | undefined {
  return type.kind === "scalar" ? type.origins : undefined;
}

/** A numeric type that also derives from `origins`; other types are returned as they are. */
function withOrigins(type: StaticType, origins: Origins | undefined): StaticType {
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
function replacedOrigins(type: StaticType, origins: Origins | undefined): StaticType {
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

/**
 * The type of a variable without a type annotation: its own numbers derive from the variable itself, not from what its
 * first value derived from, and a slot that a later value decides takes the variable as well (ADR 0021 rule 1.2).
 */
export function ownOrigins(type: StaticType, origin: Origin): StaticType {
  const own = Origins.of(origin);
  const value = resolved(type);
  for (const member of value.kind === "union" ? value.members : [value])
    if (member.kind === "open" && member.resolved === null) member.origins = own;
  return replacedOrigins(value, own);
}

/** The variables that a numeric value derives from (see the `origins` of a scalar type). */
export function originsOf(type: StaticType): Iterable<Origin> {
  let origins: Origins | undefined;
  for (const member of members(type)) origins = mergedOrigins(origins, scalarOrigins(member));
  return origins ?? [];
}

/** A scalar type restricted to the given values; other types are returned as they are. */
export function withValues(type: StaticType, values: readonly ScalarValue[]): StaticType {
  const value = resolved(type);
  return value.kind === "scalar" ? { ...value, values: [...new Set(values)] } : value;
}

/**
 * A value that a value of a restricted type can be. A duration stands for its milliseconds and never equals a number of
 * the same size.
 */
export interface PossibleValue {
  readonly value: ScalarValue | null;
  readonly duration: boolean;
}

/**
 * The values a value of this type can only be, with `null` for a possibly null value, or `undefined` when it may be
 * any value of its type. Only a `choose` with literal button values restricts a type.
 */
export function possibleValues(type: StaticType): readonly PossibleValue[] | undefined {
  const possible: PossibleValue[] = [];
  for (const member of members(type)) {
    if (member.kind === "null") possible.push({ value: null, duration: false });
    else if (member.kind === "scalar" && member.values !== undefined)
      for (const value of member.values)
        possible.push({ value, duration: member.name === "duration" });
    else return undefined;
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
  const values = new Set<ScalarValue | null>();
  const durations = new Set<ScalarValue | null>();
  for (const { value, duration } of possible) (duration ? durations : values).add(value);
  return others.some(({ value, duration }) => (duration ? durations : values).has(value));
}

function isSubset(inner: readonly ScalarValue[], outer: readonly ScalarValue[]): boolean {
  const kept = new Set(outer);
  return inner.every((value) => kept.has(value));
}

/** Whether two scalar types belong together in a union: the same type, or both numbers. */
function sameFamily(left: StaticType, right: StaticType): boolean {
  return (
    left.kind === "scalar" &&
    right.kind === "scalar" &&
    (left.name === right.name || (isNumberName(left.name) && isNumberName(right.name)))
  );
}

function isNumberName(name: ScalarTypeName): boolean {
  return name === "integer" || name === "number";
}

/** One scalar type for two of the same family; it keeps only values that both restrict. */
function mergeScalars(left: StaticType, right: StaticType): StaticType {
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
export const DATE_TYPE = scalar("date");
export const TIME_TYPE = scalar("time");
export const DATETIME_TYPE = scalar("datetime");
export const TIMESTAMP_TYPE = scalar("timestamp");

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

/** The type a written type means (ADR 0021): `T?` is `T | null`, and `list`, `set`, and `object` hold any values. */
export function typeFromAnnotation(annotation: TypeAnnotation): StaticType {
  return runCompileTask(annotationTask(annotation));
}

/** The type of each written type, built once: no value ever changes a written type. */
const annotationTypes = new WeakMap<TypeAnnotation, StaticType>();

function* annotationTask(annotation: TypeAnnotation): CompileTask<StaticType> {
  const known = annotationTypes.get(annotation);
  if (known !== undefined) return known;
  const type = yield* compileChild(writtenTypeTask(annotation));
  annotationTypes.set(annotation, type);
  return type;
}

function* writtenTypeTask(annotation: TypeAnnotation): CompileTask<StaticType> {
  switch (annotation.kind) {
    case "namedType":
      return namedType(annotation.name);
    case "listType":
    case "setType":
    case "dictType":
      return {
        kind:
          annotation.kind === "listType" ? "list" : annotation.kind === "setType" ? "set" : "dict",
        element: yield* compileChild(annotationTask(annotation.element)),
      };
    case "optionalType":
      return optional(yield* compileChild(annotationTask(annotation.value)));
    case "unionType": {
      const types: StaticType[] = [];
      for (const member of annotation.members)
        types.push(yield* compileChild(annotationTask(member)));
      return union(types);
    }
  }
}

function namedType(name: TypeName): StaticType {
  switch (name) {
    case "null":
      return NULL_TYPE;
    case "list":
    case "set":
    case "dict":
      return { kind: name, element: UNKNOWN_TYPE };
    case "object":
      return ANY_OBJECT_TYPE;
    case "range":
    case "speaker":
    case "timer":
    case "media":
      return { kind: name };
    default:
      return scalar(name);
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
const settledForms = new WeakMap<StaticType, StaticType>();

/** The type with decided open slots followed and a union normalized again, because decisions can merge members. */
function canonical(type: StaticType): StaticType {
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
function memberSubset(type: StaticType, kept: readonly StaticType[]): StaticType {
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
        (inner.name === outer.name || (outer.name === "number" && inner.name === "integer")) &&
        (outer.values === undefined ||
          (inner.values !== undefined && isSubset(inner.values, outer.values)))
      );
    case "list":
    case "set":
    case "dict":
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
    const placed = yield* compileChild(placeTask(source));
    const widened = target.widens === true ? widenedType(placed) : placed;
    const value = target.origins === undefined ? widened : replacedOrigins(widened, target.origins);
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
      if ((kind === "object" || isCollection(resolved(member))) && kind === source.kind)
        yield* compileChild(settleTask(resolved(member), source, at));
    }
    return;
  }
  if (isCollection(target) && source.kind === target.kind) {
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
      // A copy decides its type on its own, but keeps what the original saw: a first null stays a first null.
      return { ...openType(), sawNull: type.sawNull };
    case "list":
    case "set":
    case "dict":
      return { kind: type.kind, element: yield* compileChild(copyTask(type.element)) };
    case "object": {
      if (type.properties === null) return type;
      const properties: PropertyTable = new Map();
      for (const [name, value] of type.properties)
        properties.set(name, yield* compileChild(copyTask(value)));
      return { kind: "object", properties };
    }
    case "union": {
      // A union whose members can no longer change needs no copy of its own.
      if (settledForms.get(type) === type && !type.members.some((member) => isCollection(member)))
        return type;
      const copied: StaticType[] = [];
      for (const member of type.members) copied.push(yield* compileChild(copyTask(member)));
      return { kind: "union", members: copied };
    }
    default:
      // A copy of a value keeps the values a `choose` restricted it to; only a place drops them.
      return type;
  }
}

/** The type without the values a `choose` restricted it to: a place keeps the plain type (#511 C5). */
export function plainType(type: StaticType): StaticType {
  return runCompileTask(plainTask(type));
}

function* plainTask(typeToClean: StaticType): CompileTask<StaticType> {
  const type = resolved(typeToClean);
  switch (type.kind) {
    case "scalar":
      if (type.values === undefined) return type;
      return type.origins === undefined
        ? scalar(type.name)
        : { kind: "scalar", name: type.name, origins: type.origins };
    case "list":
    case "set":
    case "dict": {
      const element = resolved(type.element);
      const plain = yield* compileChild(plainTask(element));
      return plain === element ? type : { kind: type.kind, element: plain };
    }
    case "union": {
      const plain: StaticType[] = [];
      let changed = false;
      for (const member of type.members) {
        const cleaned = yield* compileChild(plainTask(member));
        changed ||= cleaned !== resolved(member);
        plain.push(cleaned);
      }
      return changed ? union(plain) : type;
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
  if (isCollection(type))
    return { kind: type.kind, element: yield* compileChild(placeTask(type.element, copy)) };
  // A place keeps the plain type: values a `choose` restricts it to are not a type of their own.
  const plain = yield* compileChild(plainTask(type));
  return copy || plain !== type ? yield* compileChild(copyTask(plain)) : plain;
}

/**
 * The type of a variable that one of its assignments gives a non-whole number (ADR 0021 rule 1.2): an integer type is a
 * number, and an undecided slot that an integer decides becomes a number. Call it only on a new place's own type.
 */
export function widenedType(type: StaticType): StaticType {
  const value = resolved(type);
  if (isScalar(value, "integer")) return NUMBER_TYPE;
  if (value.kind === "open") value.widens = true;
  if (value.kind !== "union") return value;
  return union(value.members.map(widenedType));
}

/**
 * Widens the integer type at `path` inside a place's own type (ADR 0021 rule 1.2), where each step is a property name or
 * `[]` for the elements of a list or set. A decided slot on the way is changed in place; the returned type replaces
 * `type` in its parent.
 */
export function widenPath(type: StaticType, path: readonly string[]): StaticType {
  return runCompileTask(widenPathTask(type, path, 0));
}

function* widenPathTask(
  type: StaticType,
  path: readonly string[],
  step: number,
): CompileTask<StaticType> {
  if (type.kind === "open") {
    if (type.resolved === null) {
      if (step === path.length) type.widens = true;
    } else type.resolved = yield* compileChild(widenPathTask(type.resolved, path, step));
    return type;
  }
  if (type.kind === "union") {
    const widened: StaticType[] = [];
    for (const member of type.members)
      widened.push(yield* compileChild(widenPathTask(member, path, step)));
    return union(widened);
  }
  if (step === path.length)
    return isScalar(type, "integer")
      ? withOrigins(NUMBER_TYPE, type.kind === "scalar" ? type.origins : undefined)
      : type;
  const name = path[step]!;
  if (name === "[]" && isCollection(type)) {
    // EVIDENCE: invariant: a place's own collection type belongs to that place alone; values read from it are copied.
    (type as { element: StaticType }).element = yield* compileChild(
      widenPathTask(type.element, path, step + 1),
    );
  } else if (type.kind === "object" && type.properties !== null) {
    const kept = type.properties.get(name);
    if (kept !== undefined)
      type.properties.set(name, yield* compileChild(widenPathTask(kept, path, step + 1)));
  }
  return type;
}

/**
 * The paths in `target` where it keeps an integer and `source` holds a number, through elements and shared properties:
 * the parts of a place that storing a value of `source` would widen (ADR 0021 rule 1.2).
 */
export function numberPaths(target: StaticType, source: StaticType): string[][] {
  const paths: string[][] = [];
  runCompileTask(numberPathsTask(target, source, [], paths));
  return paths;
}

function* numberPathsTask(
  targetType: StaticType,
  sourceType: StaticType,
  path: readonly string[],
  paths: string[][],
): CompileTask<void> {
  const target = resolved(nonNullType(targetType));
  const source = resolved(nonNullType(sourceType));
  if (isScalar(target, "integer") && isScalar(source, "number")) {
    paths.push([...path]);
    return;
  }
  if (isCollection(target) && source.kind === target.kind)
    yield* compileChild(numberPathsTask(target.element, source.element, [...path, "[]"], paths));
  if (target.kind === "object" && source.kind === "object") {
    if (target.properties === null || source.properties === null) return;
    for (const [name, value] of source.properties) {
      const kept = target.properties.get(name);
      if (kept !== undefined)
        yield* compileChild(numberPathsTask(kept, value, [...path, name], paths));
    }
  }
}

/** The integers inside a value, through elements and properties, each with its path and what it derives from. */
export function integerParts(
  type: StaticType,
): { readonly path: readonly string[]; readonly origins: Iterable<Origin> }[] {
  const parts: { readonly path: readonly string[]; readonly origins: Iterable<Origin> }[] = [];
  runCompileTask(integerPartsTask(type, [], parts));
  return parts;
}

function* integerPartsTask(
  typeToSearch: StaticType,
  path: readonly string[],
  parts: { readonly path: readonly string[]; readonly origins: Iterable<Origin> }[],
): CompileTask<void> {
  const type = resolved(nonNullType(typeToSearch));
  if (isScalar(type, "integer")) {
    const origins = scalarOrigins(type);
    if (origins !== undefined) parts.push({ path, origins });
    return;
  }
  if (isCollection(type))
    yield* compileChild(integerPartsTask(type.element, [...path, "[]"], parts));
  else if (type.kind === "object" && type.properties !== null)
    for (const [name, value] of type.properties)
      yield* compileChild(integerPartsTask(value, [...path, name], parts));
}

/**
 * Gives every number inside a place's own type, in its elements and properties, the part it is as an origin as well,
 * besides what it was built from, so a value read from that part derives from it (ADR 0021 rule 1.2). A slot that a
 * later value decides takes the part too.
 */
export function ownPartOrigins(
  type: StaticType,
  origin: (path: readonly string[]) => Origin,
  at: readonly string[] = [],
): void {
  runCompileTask(ownPartOriginsTask(type, origin, at));
}

function* ownPartOriginsTask(
  type: StaticType,
  origin: (path: readonly string[]) => Origin,
  path: readonly string[],
): CompileTask<StaticType> {
  if (type.kind === "open") {
    if (type.resolved === null) {
      if (path.length > 0) type.origins = Origins.of(origin(path));
    } else type.resolved = yield* compileChild(ownPartOriginsTask(type.resolved, origin, path));
    return type;
  }
  if (type.kind === "union") {
    const parts: StaticType[] = [];
    for (const member of type.members)
      parts.push(yield* compileChild(ownPartOriginsTask(member, origin, path)));
    return parts.every((part, index) => part === type.members[index]) ? type : union(parts);
  }
  if (type.kind === "scalar")
    return path.length === 0 ? type : withOrigins(type, Origins.of(origin(path)));
  if (isCollection(type)) {
    // EVIDENCE: invariant: a place's own collection type belongs to that place alone; values read from it are copied.
    (type as { element: StaticType }).element = yield* compileChild(
      ownPartOriginsTask(type.element, origin, [...path, "[]"]),
    );
  } else if (type.kind === "object" && type.properties !== null)
    for (const [name, value] of type.properties)
      type.properties.set(
        name,
        yield* compileChild(ownPartOriginsTask(value, origin, [...path, name])),
      );
  return type;
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
    case "dict":
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
 * The one type of values that must share a type, such as the elements of a list literal or the values a function
 * returns, or `undefined` when they mix types (ADR 0021 rule 1.3). Integers and numbers together are numbers, `null`
 * makes the type optional, objects merge their properties, and an unknown value makes the result unknown. The compiler
 * never infers a union here.
 */
export function joinTypes(types: readonly StaticType[]): StaticType | undefined {
  const join = new TypeJoin();
  for (const type of types) if (!join.add(type)) return undefined;
  return join.type;
}

/** A property a join set, with the type it replaced, so a join that fails can be undone. */
interface JoinChange {
  readonly properties: PropertyTable;
  readonly name: string;
  readonly replaced: StaticType | undefined;
}

/**
 * Joins values one at a time into the one type of {@link joinTypes}, such as the values a function returns. A value
 * that mixes types with the earlier ones leaves the type unchanged, so later values are still compared with them.
 */
export class TypeJoin {
  /** Property tables this join built; merging more objects extends them instead of copying them again. */
  readonly #owned = new Set<PropertyTable>();
  #type: StaticType = NEVER_TYPE;

  get type(): StaticType {
    return this.#type;
  }

  /** Joins a value into the type, or returns false and keeps the type when the value mixes types with it. */
  add(type: StaticType): boolean {
    const changes: JoinChange[] = [];
    const joined = runCompileTask(joinTask(this.#type, type, this.#owned, changes));
    if (joined !== undefined) {
      this.#type = joined;
      return true;
    }
    for (const { properties, name, replaced } of changes.reverse()) {
      if (replaced === undefined) properties.delete(name);
      else properties.set(name, replaced);
    }
    return false;
  }
}

function* joinTask(
  leftType: StaticType,
  rightType: StaticType,
  owned: Set<PropertyTable>,
  changes: JoinChange[],
): CompileTask<StaticType | undefined> {
  const left = canonical(leftType);
  const right = canonical(rightType);
  if (left.kind === "unknown" || right.kind === "unknown") return UNKNOWN_TYPE;
  const leftValue = decidedValue(left);
  const rightValue = decidedValue(right);
  const nullable = holdsNull(left) || holdsNull(right);
  if (leftValue.kind === "never" && rightValue.kind === "never") {
    // No value decided either side yet. An undecided place stays undecided and keeps whether null came first.
    if (left.kind === "never" && right.kind === "never") return NEVER_TYPE;
    if (!members(left).some(isOpen) && !members(right).some(isOpen)) return NULL_TYPE;
    return nullable ? optional(openType()) : openType();
  }
  const value =
    leftValue.kind === "never"
      ? rightValue
      : rightValue.kind === "never"
        ? leftValue
        : yield* compileChild(joinValuesTask(leftValue, rightValue, owned, changes));
  if (value === undefined) return undefined;
  return nullable ? optional(value) : value;
}

function* joinValuesTask(
  left: StaticType,
  right: StaticType,
  owned: Set<PropertyTable>,
  changes: JoinChange[],
): CompileTask<StaticType | undefined> {
  if (left.kind === "object" && right.kind === "object") {
    if (left.properties === null || right.properties === null) return ANY_OBJECT_TYPE;
    const properties: PropertyTable = owned.has(left.properties)
      ? left.properties
      : new Map(left.properties);
    owned.add(properties);
    for (const [name, type] of right.properties) {
      const kept = properties.get(name);
      const joined =
        kept === undefined ? type : yield* compileChild(joinTask(kept, type, owned, changes));
      if (joined === undefined) return undefined;
      changes.push({ properties, name, replaced: kept });
      properties.set(name, joined);
    }
    return { kind: "object", properties };
  }
  if (isCollection(left) && right.kind === left.kind) {
    const element = yield* compileChild(joinTask(left.element, right.element, owned, changes));
    return element === undefined ? undefined : { kind: left.kind, element };
  }
  if (sameFamily(left, right)) return mergeScalars(left, right);
  if (includes(left, right)) return withOrigins(left, scalarOrigins(right));
  if (includes(right, left)) return withOrigins(right, scalarOrigins(left));
  // Values of one type that a `choose` restricted to different values, such as two `string | integer` results, still
  // share that type: the join keeps both sets of values.
  const plainLeft = plainType(left);
  const plainRight = plainType(right);
  if (includes(plainLeft, plainRight) || includes(plainRight, plainLeft))
    return union([left, right]);
  return undefined;
}

/** The non-null part of a type that a value decided, or `never` for `null` and for a place no value decided yet. */
function decidedValue(type: StaticType): StaticType {
  const value = nonNullType(type);
  return value.kind === "open" ? NEVER_TYPE : value;
}

/** Whether values of a type may be null, including a place that took null before any other value. */
function holdsNull(type: StaticType): boolean {
  return members(type).some(
    (member) => member.kind === "null" || (member.kind === "open" && member.sawNull),
  );
}

function isOpen(type: StaticType): boolean {
  return type.kind === "open";
}

/**
 * The type of a value of type `type` that passes the test `is test` (ADR 0021 rule 5.1). A value of unknown type takes
 * the tested type. Tests can overlap: a `number` that passes `is integer` is an `integer`.
 */
export function narrowTo(type: StaticType, test: StaticType): StaticType {
  return runCompileTask(intersectionTask(type, test));
}

/** The values two types share, member by member, also inside lists and sets. */
function* intersectionTask(left: StaticType, right: StaticType): CompileTask<StaticType> {
  const lefts = members(left);
  const parts: StaticType[] = [];
  for (const a of lefts)
    for (const b of members(right)) parts.push(yield* compileChild(memberIntersectionTask(a, b)));
  // Members that pass whole, or not at all, are some members of `left` and need no normalizing again.
  const whole =
    parts.length === lefts.length &&
    parts.every((part, index) => part === lefts[index] || part.kind === "never");
  return whole
    ? memberSubset(
        left,
        lefts.filter((_, index) => parts[index] === lefts[index]),
      )
    : union(parts);
}

function* memberIntersectionTask(left: StaticType, right: StaticType): CompileTask<StaticType> {
  // A value of unknown type, or a place no value decided yet, may hold anything that passes.
  if (left.kind === "unknown" || left.kind === "open") return copyType(right);
  if (right.kind === "unknown" || right.kind === "open") return left;
  if (includes(right, left)) return yield* compileChild(guardedTask(left, right));
  if (includes(left, right)) return right;
  if (isCollection(left) && right.kind === left.kind) {
    // An empty collection passes a test of any element type, so collections always share at least that one.
    const element = yield* compileChild(intersectionTask(left.element, right.element));
    return { kind: left.kind, element };
  }
  // Two objects of known properties overlap: the value is the object it is.
  if (left.kind === "object" && right.kind === "object") return left;
  if (left.kind === "scalar" && right.kind === "scalar") return scalarOverlap(left, right);
  return NEVER_TYPE;
}

/**
 * A value that passed a test, with its numbers deriving from nothing where the test admits only whole numbers: there
 * the test, not what the value derives from, keeps it whole, so a later widening does not reach it (ADR 0021 rule 1.2).
 */
function* guardedTask(value: StaticType, test: StaticType): CompileTask<StaticType> {
  const kept = resolved(value);
  // Each member is kept whole by the test member that admits it, such as the `integer` of an `integer | null` element.
  if (kept.kind === "union") {
    const parts: StaticType[] = [];
    for (const member of kept.members) parts.push(yield* compileChild(guardedTask(member, test)));
    return parts.every((part, index) => part === kept.members[index]) ? value : union(parts);
  }
  const passed = resolved(test);
  if (passed.kind === "union") {
    const member = passed.members.find((part) => includes(part, kept));
    return member === undefined ? value : yield* compileChild(guardedTask(value, member));
  }
  if (kept.kind === "scalar")
    return isScalar(passed, "integer") ? replacedOrigins(kept, undefined) : value;
  if (isCollection(kept) && passed.kind === kept.kind) {
    const element = yield* compileChild(guardedTask(kept.element, passed.element));
    return element === kept.element ? value : { kind: kept.kind, element };
  }
  return value;
}

/**
 * The values two scalar types share when neither includes the other, as when one is restricted to some values. A
 * number passes `is integer` when it is whole, so `1.0` is shared by a number and an integer (ADR 0021 rule 4.2).
 */
function scalarOverlap(
  left: Extract<StaticType, { kind: "scalar" }>,
  right: Extract<StaticType, { kind: "scalar" }>,
): StaticType {
  if (left.name !== right.name && !(isNumberName(left.name) && isNumberName(right.name)))
    return NEVER_TYPE;
  const name = left.name === right.name ? left.name : "integer";
  let values = left.values ?? right.values;
  if (left.values !== undefined && right.values !== undefined)
    values = left.values.filter((value) => right.values!.includes(value));
  if (values === undefined) return scalar(name);
  const kept =
    name === "integer"
      ? values.filter((value) => typeof value === "number" && Number.isInteger(value))
      : values;
  return kept.length === 0 ? NEVER_TYPE : { kind: "scalar", name, values: kept };
}

/**
 * The type of a value of type `type` that fails the test `is test`. Only members the test provably covers are removed
 * (ADR 0021 rule 5.3): a `number` that fails `is integer` is still a `number`.
 */
export function excludeType(type: StaticType, test: StaticType): StaticType {
  const value = canonical(type);
  if (value.kind === "unknown") return value;
  const kept = members(value).filter((member) => !includes(test, member));
  // A number restricted to some values keeps only those the test does not take: a whole value passes `is integer`.
  if (!members(test).some((member) => isScalar(member, "integer")))
    return memberSubset(value, kept);
  let filtered = false;
  const remaining: StaticType[] = [];
  for (const member of kept) {
    if (member.kind !== "scalar" || member.name !== "number" || member.values === undefined) {
      remaining.push(member);
      continue;
    }
    const fractions = member.values.filter(
      (part) => typeof part !== "number" || !Number.isInteger(part),
    );
    if (fractions.length === member.values.length) remaining.push(member);
    else {
      filtered = true;
      if (fractions.length > 0) remaining.push(withValues(member, fractions));
    }
  }
  return filtered ? union(remaining) : memberSubset(value, kept);
}

/**
 * The type a variable of `declared` type is known to hold directly after a value of type `value` is stored in it
 * (ADR 0021 rule 5.2): the declared members that the value fits, or the value's type for a variable of unknown type.
 */
export function assignedType(declared: StaticType, value: StaticType): StaticType {
  const kept = canonical(declared);
  const stored = canonical(value);
  if (stored.kind === "unknown") return kept;
  if (kept.kind === "unknown") return stored;
  // A value a `choose` restricted to some literal values keeps that restriction while nothing else is stored.
  const restricted = (part: StaticType): boolean =>
    part.kind === "scalar" && part.values !== undefined;
  // The variable keeps its own type, such as a number that an assignment widened, with the restricted values.
  const restrict = (member: StaticType, part: StaticType): StaticType =>
    part.kind === "scalar" && part.values !== undefined ? withValues(member, part.values) : member;
  if (kept.kind !== "union")
    return restricted(stored) && isAssignable(kept, stored) ? restrict(kept, stored) : kept;
  const parts = members(stored).map((part) => {
    const accepting = kept.members.filter((member) => isAssignable(member, part));
    // A member that holds the value itself, such as the `null` of `let answer = choose null`, says more than a slot
    // that a later value decides.
    const precise = accepting.filter((member) => member.kind !== "open");
    return union(
      (precise.length > 0 ? precise : accepting).map((member) =>
        restricted(part) ? restrict(member, part) : member,
      ),
    );
  });
  const narrowed = union(parts);
  return narrowed.kind === "never" ? kept : narrowed;
}

/**
 * The type of a list or set element or a dict value, or of a loop variable over an iterable, which goes through the
 * keys of a dict, or `undefined` for other types.
 */
export function elementType(type: StaticType, iteration = false): StaticType | undefined {
  const elements: StaticType[] = [];
  for (const member of members(nonNullType(type))) {
    const value = resolved(member);
    if (iteration && value.kind === "dict") elements.push(STRING_TYPE);
    else if (isCollection(value)) elements.push(value.element);
    else if (iteration && value.kind === "range") elements.push(INTEGER_TYPE);
    else if (value.kind === "unknown") elements.push(UNKNOWN_TYPE);
    else return undefined;
  }
  return elements.length === 1 ? elements[0] : union(elements);
}

/**
 * The type an element stored in a list or set, or a value stored in a dict, of `type` must have: for a union of
 * collections, what every member's elements share, because the compiler does not know which member holds the
 * collection. `undefined` for other types.
 */
export function elementStoreType(type: StaticType): StaticType | undefined {
  let shared: StaticType | undefined;
  for (const member of members(nonNullType(type))) {
    const value = resolved(member);
    if (value.kind === "unknown") return UNKNOWN_TYPE;
    if (!isCollection(value)) return undefined;
    shared = shared === undefined ? value.element : narrowTo(shared, value.element);
  }
  return shared;
}

/**
 * Whether a type can be written as an annotation without losing what the compiler knows. Objects with known properties
 * cannot, because a property type has no written form.
 */
export function isAnnotatable(type: StaticType): boolean {
  return (
    resolved(type).kind !== "unknown" &&
    !containsType(
      type,
      (part) =>
        part.kind === "never" ||
        part.kind === "open" ||
        (part.kind === "object" && part.properties !== null),
    )
  );
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
    case "set":
    case "dict": {
      const element = canonical(type.element);
      if (!isKnown(element)) return type.kind;
      const name = yield* compileChild(typeNameTask(element));
      const written = name.includes(" | ") ? `(${name})` : name;
      return type.kind === "list" ? `${written}[]` : `${written} ${type.kind}`;
    }
    case "object":
      return "object";
    case "union": {
      const nonNull = type.members.filter((member) => member.kind !== "null");
      const nullable = nonNull.length < type.members.length;
      if (nullable && nonNull.length === 1)
        return `${yield* compileChild(typeNameTask(nonNull[0]!))}?`;
      const names: string[] = [];
      for (const member of nonNull) names.push(yield* compileChild(typeNameTask(member)));
      if (nullable) names.push("null");
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
  timestamp: "a timestamp",
};

/** A plain-language description of a value of `type` for diagnostics. */
export function describeValue(type: StaticType): string {
  const value = canonical(type);
  switch (value.kind) {
    case "scalar":
      return SCALAR_DESCRIPTIONS[value.name];
    case "list":
    case "set":
    case "dict": {
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
 * Integer arithmetic stays integer except `/`, which always gives a number (ADR 0021 rule 2.2). A duration is added to
 * a timestamp or a date and time after it, not before it.
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
    // The result derives from what both operands derive from.
    return withOrigins(
      left.name === "integer" && right.name === "integer" && operator !== "/"
        ? INTEGER_TYPE
        : NUMBER_TYPE,
      mergedOrigins(left.origins, right.origins),
    );
  }
  if (left.name === "duration" && right.name === "duration") {
    if (operator === "+" || operator === "-") return DURATION_TYPE;
    if (operator === "/") return NUMBER_TYPE;
    return undefined;
  }
  if (left.name === "duration" && numeric(right.name) && (operator === "*" || operator === "/"))
    return DURATION_TYPE;
  if (numeric(left.name) && right.name === "duration" && operator === "*") return DURATION_TYPE;
  // A date, timestamp, or local date and time moves by a duration, and two of one kind differ by one (V30 §35).
  if (left.name === "timestamp" || left.name === "datetime" || left.name === "date") {
    if (right.name === "duration" && (operator === "+" || operator === "-"))
      return scalar(left.name);
    if (right.name === left.name && operator === "-") return DURATION_TYPE;
  }
  return undefined;
}
