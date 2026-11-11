// The type a typed parse or load reads its value as, proved against the written types that reach its value (#2307), and
// the syntax of a typed call's default the slice's contracts read.
import type { CallExpression, Expression, LetStatement } from "../../../ast.js";
import type { TypePlan } from "../../../plan/model.js";
import { typeFromAnnotation } from "../../../static-types/annotations.js";
import { typePlan } from "../../../type-plans.js";
import type { PlaceId } from "../../graph.js";
import type { Answers, PlaceAnswer } from "../answers.js";
import { joinSteps } from "../budget.js";
import type { Definition } from "../definitions.js";
import { propertyStep } from "../program.js";
import { type SliceIndex, nodeOf, unwrap } from "./slice-index.js";

/** The candidate route's reason for a typed parse or load whose type `TypedReaders.proved` does not prove. */
export const UNPROVED_READER =
  "a typed parse or load whose type the written types it lands beside do not prove";

/** A place and the path below its root. */
interface Place {
  readonly id: PlaceId;
  readonly path: readonly string[];
}

/** A level of a plan: its steps below the plan and its kinds, `null` for a level that takes every value. */
interface Level {
  readonly path: readonly string[];
  readonly kinds: ReadonlySet<string> | null;
}

/** What a value is at a level (`atLevel`): a read of a place with the steps left below it, a value no place holds, or neither. */
type AtLevel =
  | { readonly kind: "read"; readonly read: Expression; readonly rest: readonly string[] }
  | { readonly kind: "other" }
  | { readonly kind: "unsure" };

/**
 * Whether a typed parse's or load's type is proved by the written types that reach its value (#2307): F18 reads a value by
 * the written type of the place it lands in, a copy of one included, else by its default's type (ADR 0021 rule 2.6),
 * and a variable with a written type has that type whatever it holds (V30 §12), but the core answers the call by its
 * default's value, and its admission can decide a level by a value (#2337). So, at every level of the call's type, every
 * store into the place it lands in or into a level above it (its definitions), and every place its default reads, may
 * bring there only literal data, an operation, a typed parse or load (proved itself), or a read of a written variable
 * whose type there has the call's kinds, or of an unwritten one whose own stores do the same; anything else is not
 * proved, a cycle of unwritten copies included. One per `Contracts`: each definitions list, read place and unwritten
 * variable's answer is asked once.
 */
export class TypedReaders {
  readonly #definitions = new Map<string, readonly Definition[]>();
  readonly #places = new Map<Expression, Place | null>();
  readonly #variables = new Map<string, boolean>();
  readonly #asking = new Set<string>();

  public constructor(
    private readonly answers: Answers,
    private readonly index: SliceIndex,
    private readonly lets: ReadonlyMap<PlaceId, LetStatement>,
    /** The plan of a level whose value nothing settles (`ANY_VALUE`), which proves nothing to check. */
    private readonly open: TypePlan,
  ) {}

  /**
   * Whether `expected`, the call's type, is proved where its value lands (`landing`, with each of its levels' answers as
   * the call's reader read them) and by its default (`fallback`).
   */
  public proved(
    expected: TypePlan,
    landing: Place | null,
    fallback: Expression | null,
    answered: ReadonlyMap<string, PlaceAnswer>,
  ): boolean {
    const levels = levelsWithKinds(expected, this.open);
    if (landing !== null && !this.#storesAgree(landing.id, landing.path, levels, answered))
      return false;
    if (fallback === null) return true;
    for (const { path, kinds } of levels.values()) {
      if (kinds === null) continue;
      for (const at of atLevel(fallback, path))
        if (
          at.kind === "unsure" ||
          (at.kind === "read" && !this.#readAgrees(at.read, at.rest, kinds))
        )
          return false;
    }
    return true;
  }

  /**
   * Whether every store into a place at each level below `base` (its definitions there and at every level above) brings
   * there only what agrees with the level's kinds (`#readAgrees`).
   */
  #storesAgree(
    id: PlaceId,
    base: readonly string[],
    levels: ReadonlyMap<string, Level>,
    answered: ReadonlyMap<string, PlaceAnswer> = new Map(),
  ): boolean {
    const definitions = new Map<number, Definition>();
    for (const [key, { path }] of levels) {
      const at = joinSteps(base, path);
      for (const definition of this.#definitionsOf(id, at, answered.get(key)))
        definitions.set(definition.uid, definition);
      for (let depth = 0; depth < at.length; depth += 1)
        for (const definition of this.#definitionsOf(id, at.slice(0, depth)))
          definitions.set(definition.uid, definition);
    }
    for (const { path, kinds } of levels.values()) {
      if (kinds === null) continue;
      const at = joinSteps(base, path);
      for (const definition of definitions.values()) {
        if (definition.path.length > at.length || definition.path.some((step, i) => at[i] !== step))
          continue;
        const value = this.index.findExpressionAt(definition.site);
        if (value === undefined) return false;
        for (const part of atLevel(value, at.slice(definition.path.length))) {
          if (part.kind === "unsure") return false;
          // (a copy of the level onto itself, `d = d`, brings nothing)
          if (part.kind === "read" && !this.#selfCopy(part.read, part.rest, id, at)) {
            if (!this.#readAgrees(part.read, part.rest, kinds)) return false;
          }
        }
      }
    }
    return true;
  }

  /**
   * Whether a read brings `kinds` at `rest` below it: a written variable whose type there has them (or takes every value
   * there), or an unwritten one whose stores agree (`#storesAgree`, once per variable, level and kinds; a variable asked
   * again while its own stores are asked is a cycle of copies, not proved).
   */
  #readAgrees(read: Expression, rest: readonly string[], kinds: ReadonlySet<string>): boolean {
    const place = this.#placeOf(read);
    if (place === null) return false;
    const steps = joinSteps(place.path, rest);
    const annotation = this.lets.get(place.id)?.typeAnnotation ?? null;
    if (annotation !== null) {
      const plan = typePlan(typeFromAnnotation(annotation));
      const level =
        plan === null ? undefined : levelsWithKinds(plan, this.open).get(levelKey(steps));
      return level?.kinds == null || sameKinds(level.kinds, kinds);
    }
    const key = `${place.id}\u0001${levelKey(steps)}\u0001${[...kinds].sort().join("|")}`;
    const known = this.#variables.get(key);
    if (known !== undefined) return known;
    if (this.#asking.has(key)) return false;
    this.#asking.add(key);
    const agrees = this.#storesAgree(
      place.id,
      [],
      new Map([[levelKey(steps), { path: steps, kinds }]]),
    );
    this.#asking.delete(key);
    this.#variables.set(key, agrees);
    return agrees;
  }

  /** Whether a read at `rest` below it is the level `at` of place `id` itself. */
  #selfCopy(
    read: Expression,
    rest: readonly string[],
    id: PlaceId,
    at: readonly string[],
  ): boolean {
    const place = this.#placeOf(read);
    if (place === null || place.id !== id) return false;
    const steps = joinSteps(place.path, rest);
    return steps.length === at.length && steps.every((step, i) => step === at[i]);
  }

  /** The place a read reads, once. */
  #placeOf(read: Expression): Place | null {
    let place = this.#places.get(read);
    if (place === undefined) {
      place = this.answers.at(nodeOf(this.answers, this.index, read))?.place ?? null;
      this.#places.set(read, place);
    }
    return place;
  }

  /** A place's definitions at a path (`PlaceAnswer.definitions`), from `answer` where the caller read it, once. */
  #definitionsOf(
    id: PlaceId,
    path: readonly string[],
    answer?: PlaceAnswer,
  ): readonly Definition[] {
    const key = `${id}\u0001${levelKey(path)}`;
    let found = this.#definitions.get(key);
    if (found === undefined) {
      found = (answer ?? this.answers.place(id, path)).definitions.list;
      this.#definitions.set(key, found);
    }
    return found;
  }
}

/** A level's key among a plan's levels. */
function levelKey(path: readonly string[]): string {
  return path.join("\u0000");
}

/**
 * Each level of a plan by its key, with its kinds: a union's members' at the same level, a whole number among numbers
 * folded into `number`; `null` at a level that is `open` (and below it nothing).
 */
function levelsWithKinds(plan: TypePlan, open: TypePlan): Map<string, Level> {
  const levels = new Map<string, { path: readonly string[]; kinds: Set<string> | null }>();
  const pending: [TypePlan, readonly string[]][] = [[plan, []]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [at, path] = next;
    const key = levelKey(path);
    if (at === open) {
      levels.set(key, { path, kinds: null });
      continue;
    }
    if (at.kind === "union") {
      for (const member of at.members) pending.push([member, path]);
      continue;
    }
    const level = levels.get(key) ?? { path, kinds: new Set<string>() };
    levels.set(key, level);
    level.kinds?.add(at.kind);
    if ((at.kind === "list" || at.kind === "set" || at.kind === "dict") && at.element !== null)
      pending.push([at.element, joinSteps(path, ["element"])]);
    else if (at.kind === "object")
      for (const property of at.properties)
        pending.push([property.type, joinSteps(path, [propertyStep(property.name)])]);
  }
  return levels;
}

/** Whether two levels' kinds are one, a whole number among numbers folded into `number` on each side. */
function sameKinds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const fold = (kinds: ReadonlySet<string>) =>
    new Set([...kinds].filter((kind) => kind !== "integer" || !kinds.has("number")));
  const [x, y] = [fold(a), fold(b)];
  return x.size === y.size && [...x].every((kind) => y.has(kind));
}

/**
 * What a value is at `path` below it, through parentheses, either operand of `otherwise`, a list's or set's elements, an
 * object's properties, a projection of literal data (`projectedLiteral`) and a `get` (its receiver's element, or its
 * default): a read of a variable or a part of one with the steps left; `other` for literal data, an operation and a
 * typed parse or load, a named function's call; `unsure` for anything else (a method but `get`, a dict literal below its
 * root, an interaction).
 */
function atLevel(value: Expression, path: readonly string[]): AtLevel[] {
  const at = unwrap(value);
  switch (at.kind) {
    case "identifier":
      return [{ kind: "read", read: at, rest: path }];
    case "propertyAccessExpression":
    case "indexExpression": {
      const selected = projectedLiteral(at);
      return selected === undefined
        ? [{ kind: "read", read: at, rest: path }]
        : selected.flatMap((part) => atLevel(part, path));
    }
    case "listLiteral":
    case "setLiteral":
      if (path.length === 0) return [{ kind: "other" }];
      return path[0] === "element"
        ? at.elements.flatMap((element) => atLevel(element, path.slice(1)))
        : [{ kind: "unsure" }];
    case "objectLiteral": {
      if (path.length === 0) return [{ kind: "other" }];
      const property = at.properties.find((each) => propertyStep(each.name.name) === path[0]);
      return property === undefined ? [{ kind: "other" }] : atLevel(property.value, path.slice(1));
    }
    case "binaryExpression":
      return at.operator === "otherwise"
        ? [...atLevel(at.left, path), ...atLevel(at.right, path)]
        : [{ kind: "other" }];
    case "callExpression": {
      // (a typed parse or load is proved itself; a named function's value, a conversion's, is its own type, which no
      // variable's written type reaches; a method is a part of its receiver only as a `get`)
      if (typedDefault(at) !== undefined || at.callee.kind === "identifier")
        return [{ kind: "other" }];
      const receiver = getReceiver(at);
      if (receiver === null) return [{ kind: "unsure" }];
      const fallback = defaultOf(at);
      return [
        ...atLevel(receiver, joinSteps(["element"], path)),
        ...(fallback === null ? [] : atLevel(fallback, path)),
      ];
    }
    case "loadExpression":
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
    case "durationLiteral":
    case "stringLiteral":
    case "regexLiteral":
    case "unitExpression":
    case "angleExpression":
    case "unaryExpression":
    case "rangeExpression":
    case "typeTestExpression":
      return [{ kind: "other" }];
    case "dictLiteral":
      return path.length === 0 ? [{ kind: "other" }] : [{ kind: "unsure" }];
    default:
      return [{ kind: "unsure" }];
  }
}

/**
 * A typed parse's or load's default, which its value is where it gives one: `null` for a typed one without a default,
 * `undefined` for any other expression.
 */
export function typedDefault(node: Expression): Expression | null | undefined {
  if (node.kind === "loadExpression") return node.defaultValue;
  return node.kind === "callExpression" &&
    node.callee.kind === "identifier" &&
    node.callee.name === "fromJson"
    ? defaultOf(node)
    : undefined;
}

/** The `default:` a call's value falls back on, or `null`. */
export function defaultOf(call: CallExpression): Expression | null {
  return (
    call.arguments.find(
      (argument) => argument.kind === "namedArgument" && argument.name.name === "default",
    )?.value ?? null
  );
}

/**
 * What an expression may select through parentheses and projections of literals: an object literal's literal property,
 * or any element of a list literal, whatever the index reads (Codex r9: `[0][load("i", default: 0)]` and
 * `[0][({i: 0}).i]` are elements of `[0]`); a selected part that is itself a projection is followed (Codex r8:
 * `({p: ({n: 0}).n}).p`); an empty list's none. `undefined` where a step leaves the literal's syntax: another receiver,
 * a missing property. Recursive over the syntax alone.
 */
export function projectedLiteral(expression: Expression): readonly Expression[] | undefined {
  const at = unwrap(expression);
  if (at.kind !== "propertyAccessExpression" && at.kind !== "indexExpression") return [at];
  const holders = projectedLiteral(at.object);
  if (holders === undefined) return undefined;
  const selected: Expression[] = [];
  for (const holder of holders) {
    let values: readonly (Expression | undefined)[];
    if (at.kind === "propertyAccessExpression")
      values =
        holder.kind === "objectLiteral"
          ? [holder.properties.find((property) => property.name.name === at.property.name)?.value]
          : [undefined];
    // (an element of a list literal at any index, a literal or computed one alike: its elements are of one type)
    else values = holder.kind === "listLiteral" ? holder.elements : [undefined];
    for (const value of values) {
      const parts = value === undefined ? undefined : projectedLiteral(value);
      if (parts === undefined) return undefined;
      selected.push(...parts);
    }
  }
  return selected;
}

/** A `get` call's receiver, else `null`. */
export function getReceiver(expression: Expression): Expression | null {
  return expression.kind === "callExpression" &&
    expression.callee.kind === "propertyAccessExpression" &&
    expression.callee.property.name === "get"
    ? expression.callee.object
    : null;
}
