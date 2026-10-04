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
      /**
       * For a number, the variables without a type annotation that its value derives from: when one of them widens to
       * a number, so does this value (ADR 0021 rule 1.2).
       */
      readonly origins?: Origins;
    }
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

function scalar(name: ScalarTypeName): StaticType {
  return { kind: "scalar", name };
}

/**
 * The declaration of a variable without a type annotation, which a number may derive from (ADR 0021 rule 1.2): `let`, a
 * parameter with a default, or a loop variable.
 */
export type Origin = LetStatement | FunctionParameter | ForStatement;

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
    return { kind: "scalar", name: value.name, origins: merged };
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
    return origins === undefined
      ? { kind: "scalar", name: value.name }
      : { kind: "scalar", name: value.name, origins };
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
      return {
        kind: annotation.kind === "listType" ? "list" : "set",
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

/** The type without `null`. Operations on a possibly null value act on its other members (V30 §34). */
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
      // A copy decides its type on its own, but keeps what the original saw: a first null stays a first null.
      return { ...openType(), sawNull: type.sawNull };
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
      // A union whose members can no longer change needs no copy of its own.
      if (settledForms.get(type) === type) return type;
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
  if ((left.kind === "list" || left.kind === "set") && right.kind === left.kind) {
    const element = yield* compileChild(joinTask(left.element, right.element, owned, changes));
    return element === undefined ? undefined : { kind: left.kind, element };
  }
  if (includes(left, right)) return withOrigins(left, scalarOrigins(right));
  if (includes(right, left)) return withOrigins(right, scalarOrigins(left));
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
  if (includes(right, left)) return left;
  if (includes(left, right)) return right;
  if ((left.kind === "list" || left.kind === "set") && right.kind === left.kind) {
    // An empty collection passes a test of any element type, so collections always share at least that one.
    const element = yield* compileChild(intersectionTask(left.element, right.element));
    return { kind: left.kind, element };
  }
  return NEVER_TYPE;
}

/**
 * The type of a value of type `type` that fails the test `is test`. Only members the test provably covers are removed
 * (ADR 0021 rule 5.3): a `number` that fails `is integer` is still a `number`.
 */
export function excludeType(type: StaticType, test: StaticType): StaticType {
  const value = canonical(type);
  if (value.kind === "unknown") return value;
  return memberSubset(
    value,
    members(value).filter((member) => !includes(test, member)),
  );
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
  if (kept.kind !== "union") return kept;
  const parts = members(stored).map((part) =>
    union(kept.members.filter((member) => isAssignable(member, part))),
  );
  const narrowed = union(parts);
  return narrowed.kind === "never" ? kept : narrowed;
}

/** The type of a list or set element, of a loop variable over an iterable, or `undefined` for other types. */
export function elementType(type: StaticType): StaticType | undefined {
  const elements: StaticType[] = [];
  for (const member of members(nonNullType(type))) {
    const value = resolved(member);
    if (value.kind === "list" || value.kind === "set") elements.push(value.element);
    else if (value.kind === "range") elements.push(INTEGER_TYPE);
    else if (value.kind === "unknown") elements.push(UNKNOWN_TYPE);
    else return undefined;
  }
  return elements.length === 1 ? elements[0] : union(elements);
}

/**
 * The type an element stored in a list or set of `type` must have: for a union of collections, what every member's
 * elements share, because the compiler does not know which member holds the collection. `undefined` for other types.
 */
export function elementStoreType(type: StaticType): StaticType | undefined {
  let shared: StaticType | undefined;
  for (const member of members(nonNullType(type))) {
    const value = resolved(member);
    if (value.kind === "unknown") return UNKNOWN_TYPE;
    if (value.kind !== "list" && value.kind !== "set") return undefined;
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
  return undefined;
}
