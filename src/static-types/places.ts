import { compileChild, runCompileTask, type CompileTask } from "../compiler/continuation.js";
import type { SourceSpan } from "../source.js";
import {
  canonical,
  decidedValue,
  isCollection,
  members,
  nonNullType,
  openType,
  optional,
  replacedOrigins,
  resolved,
  scalar,
  settledForms,
  union,
  UNKNOWN_TYPE,
  type OpenType,
  type StaticType,
} from "../static-types.js";
import { feed, flowInto, lineage, openTables, PropertyTable } from "./property-tables.js";
import { widenedType } from "./widening.js";

// The types of places: the copy a new place keeps of a value, and what later stores decide in it.

let decisions = 0;

/** The next number in checking order for a slot that a value decides (see {@link OpenType.order}). */
export function nextDecision(): number {
  decisions += 1;
  return decisions;
}

/**
 * Records what a stored value decides: undecided open slots in `target` take the value's type, and an object place
 * adds the value's new properties. Call it only after {@link isAssignable} accepted the value.
 */
export function settle(target: StaticType, source: StaticType, at: SourceSpan): void {
  flowInto(target, source);
  runCompileTask(settleTask(target, source, at));
}

function* settleTask(
  target: StaticType,
  sourceType: StaticType,
  at: SourceSpan,
): CompileTask<void> {
  const source = canonical(sourceType);
  if (source.kind === "unknown") {
    yield* compileChild(heldUnknownTask(target, at));
    return;
  }
  if (source.kind === "never") return;
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
    target.order = nextDecision();
    if (target.heldUnknown !== undefined) {
      // The slot may still hold the value the compiler cannot know when the script runs, with any properties.
      openTables(value);
      // Another place that is still undecided decides nothing yet, so the slot may still hold the value the compiler
      // cannot know that it held: the copy of that place keeps it, since reading the slot now reads the copy.
      if (decidedValue(value).kind === "never")
        yield* compileChild(heldUnknownTask(value, target.heldUnknown));
    }
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
 * Notes in every undecided slot of a place, also inside its elements and properties, that a value the compiler cannot
 * know was stored at `at`: such a value may replace any of them (see {@link OpenType.heldUnknown}).
 */
function* heldUnknownTask(type: StaticType, at: SourceSpan): CompileTask<void> {
  if (type.kind === "open") {
    if (type.resolved === null) type.heldUnknown ??= at;
    else yield* compileChild(heldUnknownTask(type.resolved, at));
  } else if (type.kind === "union")
    for (const member of type.members) yield* compileChild(heldUnknownTask(member, at));
  else if (isCollection(type)) yield* compileChild(heldUnknownTask(type.element, at));
  else if (type.kind === "object" && type.properties !== null)
    for (const value of type.properties.values()) yield* compileChild(heldUnknownTask(value, at));
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
      // A copy keeps what the original saw: a first null stays a first null. It may hold what the original held when
      // it was taken, so it takes the type that decides the original, also when a later check finds it.
      type.observed = true;
      const copy: OpenType = {
        ...openType(),
        sawNull: type.sawNull,
        copiedFrom: type,
        ...(type.heldUnknown === undefined ? {} : { heldUnknown: type.heldUnknown }),
      };
      // The objects that decide the original may reach the copy.
      lineage?.flows.push([copy, type]);
      return copy;
    case "list":
    case "set":
    case "dict":
      return { kind: type.kind, element: yield* compileChild(copyTask(type.element)) };
    case "object": {
      if (type.properties === null) return type;
      const properties = new PropertyTable();
      for (const [name, value] of type.properties)
        properties.set(name, yield* compileChild(copyTask(value)));
      feed(properties, type.properties);
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
      // A copy of a value keeps the values an `askChoice` restricted it to; only a place drops them.
      return type;
  }
}

/** The type without the values an `askChoice` restricted it to: a place keeps the plain type (#511 C5). */
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

/**
 * A fresh copy of a slot that took null before any other value, such as an element read from a list after `add(null)`,
 * with that null as a member of its own, as after `let x = null`, instead of the mark that its later value is optional.
 * A test that excludes null then keeps only the slot, so that the value that decides it does not bring the null back.
 * Other types are returned as they are, also a slot that held a value the compiler cannot know: what it holds is of
 * unknown type, which a known place checks when the script runs, null included (rule 1.7). Only a copy that no other
 * place shares may be given.
 */
export function ownNull(copy: StaticType): StaticType {
  if (
    copy.kind !== "open" ||
    copy.resolved !== null ||
    !copy.sawNull ||
    copy.heldUnknown !== undefined
  )
    return copy;
  copy.sawNull = false;
  return optional(copy);
}

function* placeTask(typeToPlace: StaticType, copy = true): CompileTask<StaticType> {
  const type = resolved(typeToPlace);
  if (type.kind === "null") return optional(openType());
  if (type.kind === "never") return openType();
  if (isCollection(type))
    return { kind: type.kind, element: yield* compileChild(placeTask(type.element, copy)) };
  // A place keeps the plain type: values an `askChoice` restricts it to are not a type of their own.
  const plain = yield* compileChild(plainTask(type));
  return copy || plain !== type ? yield* compileChild(copyTask(plain)) : plain;
}

/** Notes that a read saw the undecided slot that a place's type is, or that one of its members is. */
export function observe(type: StaticType): void {
  for (const member of members(type)) {
    const value = resolved(member);
    if (value.kind === "open") value.observed = true;
  }
}

/** A slot in a place's type, decided or not, with its path there (see {@link widenPath}). */
export interface PlacedSlot {
  readonly slot: OpenType;
  readonly path: readonly string[];
}

/** The slots in a place's type, also those decided since they were created, with their paths. */
export function placedSlots(type: StaticType): PlacedSlot[] {
  const slots: PlacedSlot[] = [];
  runCompileTask(placedSlotsTask(type, [], slots));
  return slots;
}

function* placedSlotsTask(
  type: StaticType,
  path: readonly string[],
  slots: PlacedSlot[],
): CompileTask<void> {
  if (type.kind === "open") {
    slots.push({ slot: type, path });
    if (type.resolved !== null) yield* compileChild(placedSlotsTask(type.resolved, path, slots));
  } else if (type.kind === "union")
    for (const member of type.members) yield* compileChild(placedSlotsTask(member, path, slots));
  else if (isCollection(type))
    yield* compileChild(placedSlotsTask(type.element, [...path, "[]"], slots));
  else if (type.kind === "object" && type.properties !== null)
    for (const [name, value] of type.properties)
      yield* compileChild(placedSlotsTask(value, [...path, name], slots));
}

/**
 * Decides the undecided slot at `path` in a place's own type with `value`, as a store at `at` would, so that reads
 * before that store, in the order the compiler checks, also see the decided type (ADR 0021 rule 1.2). Returns whether
 * the type has that path yet: a property that a later store adds does not exist before it.
 */
export function decidePath(
  type: StaticType,
  path: readonly string[],
  value: StaticType,
  at: SourceSpan,
): boolean {
  return runCompileTask(decidePathTask(type, path, 0, value, at));
}

/**
 * Whether `path` certainly leads to no part of a type, because a step names a property or element it does not have:
 * then {@link decidePath} decides nothing there. It answers without walking a union, so `false` only means "maybe".
 */
export function lacksPath(type: StaticType, path: readonly string[]): boolean {
  let part = type;
  for (const name of path) {
    const value = resolved(part);
    if (value.kind === "union") return false;
    if (name === "[]" && isCollection(value)) part = value.element;
    else if (value.kind !== "object" || value.properties === null) return true;
    else {
      const kept = value.properties.get(name);
      if (kept === undefined) return true;
      part = kept;
    }
  }
  return false;
}

function* decidePathTask(
  typeToDecide: StaticType,
  path: readonly string[],
  step: number,
  value: StaticType,
  at: SourceSpan,
): CompileTask<boolean> {
  const type = resolved(typeToDecide);
  if (step === path.length) {
    if (members(type).some((member) => resolved(member).kind === "open"))
      yield* compileChild(settleTask(type, value, at));
    return true;
  }
  if (type.kind === "union") {
    let found = false;
    for (const member of type.members)
      if (yield* compileChild(decidePathTask(member, path, step, value, at))) found = true;
    return found;
  }
  const name = path[step]!;
  if (name === "[]" && isCollection(type))
    return yield* compileChild(decidePathTask(type.element, path, step + 1, value, at));
  if (type.kind !== "object" || type.properties === null) return false;
  const kept = type.properties.get(name);
  return (
    kept !== undefined && (yield* compileChild(decidePathTask(kept, path, step + 1, value, at)))
  );
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
      const properties = new PropertyTable();
      for (const [name, value] of type.properties)
        properties.set(name, yield* compileChild(decidedTask(value)));
      feed(properties, type.properties);
      return { kind: "object", properties };
    }
    default:
      return type;
  }
}
