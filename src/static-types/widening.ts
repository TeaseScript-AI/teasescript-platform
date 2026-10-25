import { compileChild, runCompileTask, type CompileTask } from "../compiler/continuation.js";
import {
  isCollection,
  isScalar,
  members,
  nonNullType,
  NUMBER_TYPE,
  replacedOrigins,
  resolved,
  scalarOrigins,
  union,
  withOrigins,
  type StaticType,
} from "../static-types.js";
import { mergedOrigins, Origins, type Origin } from "./origins.js";

// Integers that widen to numbers (ADR 0021 rule 1.2): the origins of a place's numbers, and the parts that widen.

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
): { readonly path: readonly string[]; readonly origins: Origins }[] {
  const parts: { readonly path: readonly string[]; readonly origins: Origins }[] = [];
  runCompileTask(integerPartsTask(type, [], parts));
  return parts;
}

function* integerPartsTask(
  typeToSearch: StaticType,
  path: readonly string[],
  parts: { readonly path: readonly string[]; readonly origins: Origins }[],
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

/**
 * Like {@link ownPartOrigins}, but only for the parts at `path` inside a place's own type, such as a property that a store
 * added or decided: the other parts already have their origins.
 */
export function ownPartOriginsAt(
  type: StaticType,
  origin: (path: readonly string[]) => Origin,
  path: readonly string[],
): void {
  runCompileTask(ownPartOriginsAtTask(type, origin, path, 0));
}

function* ownPartOriginsAtTask(
  type: StaticType,
  origin: (path: readonly string[]) => Origin,
  path: readonly string[],
  step: number,
): CompileTask<StaticType> {
  if (step === path.length) return yield* compileChild(ownPartOriginsTask(type, origin, path));
  if (type.kind === "open") {
    if (type.resolved !== null)
      type.resolved = yield* compileChild(ownPartOriginsAtTask(type.resolved, origin, path, step));
    return type;
  }
  if (type.kind === "union") {
    const parts: StaticType[] = [];
    for (const member of type.members)
      parts.push(yield* compileChild(ownPartOriginsAtTask(member, origin, path, step)));
    return parts.every((part, index) => part === type.members[index]) ? type : union(parts);
  }
  const name = path[step]!;
  if (name === "[]" && isCollection(type)) {
    // EVIDENCE: invariant: a place's own collection type belongs to that place alone; values read from it are copied.
    (type as { element: StaticType }).element = yield* compileChild(
      ownPartOriginsAtTask(type.element, origin, path, step + 1),
    );
  } else if (type.kind === "object" && type.properties !== null) {
    const kept = type.properties.get(name);
    if (kept !== undefined)
      type.properties.set(
        name,
        yield* compileChild(ownPartOriginsAtTask(kept, origin, path, step + 1)),
      );
  }
  return type;
}

/**
 * Whether the parts at `path` inside a place's own type include every part of `part` that a store can add to or
 * decide, so that a store into `part` changed nothing outside the parts at `path`.
 */
export function holdsAt(type: StaticType, path: readonly string[], part: StaticType): boolean {
  let reached = expanded(type);
  for (const name of path) {
    const next: StaticType[] = [];
    for (const value of reached) {
      const kept =
        name === "[]" && isCollection(value)
          ? value.element
          : value.kind === "object" && value.properties !== null
            ? value.properties.get(name)
            : undefined;
      if (kept !== undefined) for (const found of expanded(kept)) next.push(found);
    }
    reached = next;
  }
  const held = new Set(reached);
  return expanded(part).every(
    (value) =>
      held.has(value) || (value.kind !== "open" && value.kind !== "object" && !isCollection(value)),
  );
}

/** The decided types a type stands for: itself, what decided it, or the members of a union. */
function expanded(type: StaticType): StaticType[] {
  const found: StaticType[] = [];
  const pending = [type];
  while (pending.length > 0) {
    const value = resolved(pending.pop()!);
    if (value.kind === "union") for (const member of value.members) pending.push(member);
    else found.push(value);
  }
  return found;
}
