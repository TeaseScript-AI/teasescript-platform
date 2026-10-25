import { compileChild, runCompileTask, type CompileTask } from "../compiler/continuation.js";
import {
  ANY_OBJECT_TYPE,
  canonical,
  decidedValue,
  includes,
  includesOnceDecided,
  isCollection,
  members,
  mergeScalars,
  NEVER_TYPE,
  NULL_TYPE,
  openType,
  optional,
  sameFamily,
  scalarOrigins,
  union,
  UNKNOWN_TYPE,
  withOrigins,
  type OpenType,
  type StaticType,
} from "../static-types.js";
import { plainType } from "./places.js";
import { feed, PropertyTable } from "./property-tables.js";

// The one type of values that must share a type (ADR 0021 rule 1.3), such as the elements of a list literal.

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

  /**
   * With `known`, the join compares only what the compiler knows: a value it cannot know, and a place such a value
   * reached, agree with any other value at every depth instead of making the type unknown, so the known values must
   * still agree with each other (V30 §17).
   */
  readonly #known: boolean;

  constructor(known = false) {
    this.#known = known;
  }

  get type(): StaticType {
    return this.#type;
  }

  /** Joins a value into the type, or returns false and keeps the type when the value mixes types with it. */
  add(type: StaticType): boolean {
    const changes: JoinChange[] = [];
    const joined = runCompileTask(joinTask(this.#type, type, this.#owned, changes, this.#known));
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
  known: boolean,
): CompileTask<StaticType | undefined> {
  const left = canonical(leftType);
  const right = canonical(rightType);
  if (left.kind === "unknown" || right.kind === "unknown")
    return known ? (left.kind === "unknown" ? right : left) : UNKNOWN_TYPE;
  const leftValue = decidedValue(left);
  const rightValue = decidedValue(right);
  // A slot that a value the compiler cannot know reached may hold any value, so with a known value it joins as unknown.
  const reachedUnknown = (type: StaticType): boolean =>
    members(type).some((member) => member.kind === "open" && member.heldUnknown !== undefined);
  if (
    !known &&
    ((reachedUnknown(left) && rightValue.kind !== "never") ||
      (reachedUnknown(right) && leftValue.kind !== "never"))
  )
    return UNKNOWN_TYPE;
  const nullable = holdsNull(left) || holdsNull(right);
  if (leftValue.kind === "never" && rightValue.kind === "never") {
    // No value decided either side yet. An undecided place stays undecided and keeps whether null came first.
    if (left.kind === "never" && right.kind === "never") return NEVER_TYPE;
    if (!members(left).some(isOpen) && !members(right).some(isOpen)) return NULL_TYPE;
    // A slot that a value the compiler cannot know reached keeps that, so a known place still checks what it holds.
    const slot = openType();
    const held = [...members(left), ...members(right)].find(
      (member): member is OpenType => member.kind === "open" && member.heldUnknown !== undefined,
    );
    if (held !== undefined) slot.heldUnknown = held.heldUnknown!;
    return nullable ? optional(slot) : slot;
  }
  const value =
    leftValue.kind === "never"
      ? rightValue
      : rightValue.kind === "never"
        ? leftValue
        : yield* compileChild(joinValuesTask(leftValue, rightValue, owned, changes, known));
  if (value === undefined) return undefined;
  return nullable ? optional(value) : value;
}

function* joinValuesTask(
  left: StaticType,
  right: StaticType,
  owned: Set<PropertyTable>,
  changes: JoinChange[],
  known: boolean,
): CompileTask<StaticType | undefined> {
  if (left.kind === "object" && right.kind === "object") {
    if (left.properties === null || right.properties === null) return ANY_OBJECT_TYPE;
    let properties = left.properties;
    if (!owned.has(properties)) {
      properties = new PropertyTable(left.properties);
      feed(properties, left.properties);
      owned.add(properties);
    }
    feed(properties, right.properties);
    for (const [name, type] of right.properties) {
      const kept = properties.get(name);
      const joined =
        kept === undefined
          ? type
          : yield* compileChild(joinTask(kept, type, owned, changes, known));
      if (joined === undefined) return undefined;
      changes.push({ properties, name, replaced: kept });
      properties.set(name, joined);
    }
    return { kind: "object", properties };
  }
  if (isCollection(left) && right.kind === left.kind) {
    const element = yield* compileChild(
      joinTask(left.element, right.element, owned, changes, known),
    );
    return element === undefined ? undefined : { kind: left.kind, element };
  }
  if (sameFamily(left, right)) return mergeScalars(left, right);
  if (includes(left, right)) return withOrigins(left, scalarOrigins(right));
  if (includes(right, left)) return withOrigins(right, scalarOrigins(left));
  // Values of one type that an `askChoice` restricted to different values, such as two `string | integer` results,
  // still share that type: the join keeps both sets of values.
  const plainLeft = plainType(left);
  const plainRight = plainType(right);
  if (includes(plainLeft, plainRight) || includes(plainRight, plainLeft))
    return union([left, right]);
  // A union keeps its members, so `[]` joins `integer[] | string` as a value of its `integer[]` member.
  if (left.kind === "union" && includesOnceDecided(left, right)) return left;
  if (right.kind === "union" && includesOnceDecided(right, left)) return right;
  return undefined;
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
