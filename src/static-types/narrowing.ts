import { compileChild, runCompileTask, type CompileTask } from "../compiler/continuation.js";
import {
  canonical,
  includes,
  isAssignable,
  isCollection,
  isScalar,
  members,
  memberSubset,
  NEVER_TYPE,
  readsHeldUnknown,
  replacedOrigins,
  resolved,
  sameScalarFamily,
  scalar,
  union,
  withValues,
  type StaticType,
} from "../static-types.js";
import { copyType } from "./places.js";

// Narrowing (ADR 0021 rule 5): the type of a value that passes or fails a type test, or that was just stored.

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
  if (!sameScalarFamily(left, right)) return NEVER_TYPE;
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
 * (ADR 0021 rule 5.2): the declared members that the value fits, or the value's type for a variable of unknown type,
 * unless that value is of unknown type itself (see {@link readsHeldUnknown}).
 */
export function assignedType(declared: StaticType, value: StaticType): StaticType {
  const kept = canonical(declared);
  const stored = canonical(value);
  if (stored.kind === "unknown") return kept;
  if (kept.kind === "unknown") return readsHeldUnknown(stored) ? kept : stored;
  // A value an `askChoice` restricted to some literal values keeps that restriction while nothing else is stored.
  const restricted = (part: StaticType): boolean =>
    part.kind === "scalar" && part.values !== undefined;
  // The variable keeps its own type, such as a number that an assignment widened, with the restricted values.
  const restrict = (member: StaticType, part: StaticType): StaticType =>
    part.kind === "scalar" && part.values !== undefined ? withValues(member, part.values) : member;
  if (kept.kind !== "union")
    return restricted(stored) && isAssignable(kept, stored) ? restrict(kept, stored) : kept;
  const parts = members(stored).map((part) => {
    const accepting = kept.members.filter((member) => isAssignable(member, part));
    // A slot that no value decided yet, such as a property that so far took only null or values the compiler cannot
    // know, may hold any value: it narrows to nothing more precise.
    if (resolved(part).kind === "open") return union(accepting);
    // A member that holds the value itself, such as the `null` of `let answer = askChoice null`, says more than a slot
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
