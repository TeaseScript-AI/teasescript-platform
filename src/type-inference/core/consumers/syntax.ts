import type { PlaceId, TypeTerm } from "../../graph.js";
import { joinSteps, keptSteps } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { defaultOf, termAt, typeTags, writtenOf } from "../contract.js";
import { keptKey, keyOf, keyPath, keyPlace, type Definition, type Key } from "../definitions.js";
import type { ItemTag } from "../items.js";
import { conversionCategory, dictList } from "../method-categories.js";
import { propertyName, propertyStep, stepName } from "../program.js";
import { LITERALS } from "./kinds.js";
import type { CheapDecision, CheapFrontier, CheapShape } from "./model.js";
import { readKey } from "./names.js";

// What the stores' syntax decides (source 4): the shape below a read's key by syntax, built once per path.

/** The property names a type term gives, through its unions. */
function termNames(term: TypeTerm): string[] {
  if (term.kind === "union") return term.members.flatMap(termNames);
  return term.kind === "object" ? (term.properties ?? []).map((property) => property.name) : [];
}

/** The type a collection or object literal has of its own. */
const OWN_TAGS: ReadonlyMap<string, ItemTag> = new Map([
  ["listLiteral", "list"],
  ["setLiteral", "set"],
  ["dictLiteral", "dict"],
  ["objectLiteral", "object"],
]);

function cheapShape(): CheapShape {
  return {
    tags: new Set(),
    written: [],
    children: new Map(),
    names: new Set(),
    properties: null,
    first: null,
    opaque: false,
  };
}

function cheapChild(shape: CheapShape, step: string): CheapShape {
  let child = shape.children.get(step);
  if (child === undefined) shape.children.set(step, (child = cheapShape()));
  return child;
}

/** Of two stores, the earlier in source order. */
function earlierStore(a: Definition | null, b: Definition): Definition {
  return a === null ||
    b.site.file < a.site.file ||
    (b.site.file === a.site.file && b.site.start < a.site.start)
    ? b
    : a;
}

/** A store gives `shape` a value of type `tag`: an unknown one is not told by its syntax; a `null` decides nothing. */
function cheapGive(shape: CheapShape, tag: ItemTag, by: Definition): void {
  if (tag === "empty") return;
  if (tag === "unknown") shape.opaque = true;
  else {
    shape.tags.add(tag);
    if (tag !== "null") shape.first = earlierStore(shape.first, by);
  }
}

/** A collection or object literal's own type (`OWN_TAGS`); `undefined` for any other value. */
function literalTag(walk: Consumers, value: PlaceId): ItemTag | undefined {
  const place = walk.pass.program.places[value]?.kind;
  return place?.kind === "value" ? OWN_TAGS.get(place.node) : undefined;
}

/** Each walk's projections of literals no place holds, by value: their cells (`placelessCells`), else `null`. */
const placeless = new WeakMap<Consumers, Map<PlaceId, readonly Definition[] | null>>();

/**
 * A projection of a collection or object literal no place holds, through such projections (`[hostValue, 4][0]`,
 * `[[1, 2]][0][1]`, #1563): the literal's cells it reads along its steps, each its own value, as a read of the literal
 * at that path reads them; `null` for any other value, and where a step finds no cell or meets a value that is no
 * such literal. Structure only, the finishing read's and the stores' syntax's alike; each projection made once a walk.
 */
export function placelessCells(walk: Consumers, value: PlaceId): readonly Definition[] | null {
  let memo = placeless.get(walk);
  if (memo === undefined) placeless.set(walk, (memo = new Map()));
  const known = memo.get(value);
  if (known !== undefined) return known;
  const { program } = walk.pass;
  const projection = program.projOf.get(value);
  let found: readonly Definition[] | null = null;
  // (a constant step inside the charged read or store that asks it; each literal's cells charged where they are found,
  // `literalChildren`, and each cell stepped through, TABLE r4.261)
  if (projection !== undefined && projection.step !== "iteration") {
    const literals = placelessLiterals(walk, projection.owner);
    if (literals !== null) {
      const step = stepName(projection.step);
      const cells: Definition[] = [];
      for (const literal of literals) cells.push(...walk.admission.literalChildren(literal, step));
      found = cells.length === 0 ? null : cells;
    }
  }
  memo.set(value, found);
  return found;
}

/**
 * The collection or object literals a value no place holds is: the literal itself, each cell of a projection of one
 * (`placelessCells`) that is such a literal in turn, or a dictionary literal's `values` list, whose elements are the
 * dictionary's own (#1452); `null` where any is another value.
 */
function placelessLiterals(walk: Consumers, value: PlaceId): readonly PlaceId[] | null {
  const { program } = walk.pass;
  if (literalTag(walk, value) !== undefined && program.hasOf.has(value)) return [value];
  const cells = placelessCells(walk, value);
  if (cells === null) {
    const projection = program.projOf.get(value);
    if (projection === undefined || dictList(projection.step) !== "values") return null;
    const dicts = placelessLiterals(walk, projection.owner);
    return dicts?.every((dict) => literalTag(walk, dict) === "dict") ? dicts : null;
  }
  const literals: PlaceId[] = [];
  for (const cell of cells) {
    program.work.charge("checks");
    const inner = cell.value === undefined ? null : placelessLiterals(walk, cell.value);
    if (inner === null) return null;
    literals.push(...inner);
  }
  return literals;
}

/**
 * What the stores' syntax decides at a read's key path and `rest` (`cheapDecided`), else `null`; the key made only
 * where syntax may decide (`syntaxDecides`).
 */
export function syntaxRead(
  walk: Consumers,
  value: PlaceId,
  rest: readonly string[],
): readonly ItemTag[] | null {
  if (!syntaxDecides(walk)) return null;
  const key = readKey(walk, value);
  return key === null
    ? null
    : (walk.cheapDecided(keyPlace(key), joinSteps(keyPath(key), rest))?.kinds ?? null);
}

/**
 * The syntax decision, source 4 (TABLE r4.89 (2), r4.100, r4.135): at a settled stop, where admission retained no
 * decision at `path`, the type a place has there where every store into the key or a key above it gives a value its
 * syntax tells there: a literal (its own types there, a `null` deciding nothing but admitting `null`), a copy of a place
 * with a written type (that type there), a typed parse or load by its default (F18), or a host value (external,
 * deciding nothing). Integers beside numbers decide numbers, as admission's family does (ADR 1.2); `null` where any
 * other store, or only `null`s, reach it, or where object literals with other properties or a store of another kind
 * meet it. Asks no demand; made once per key and path from each key's shape, which each store's syntax enters once.
 * A path admission left undecided is one it decides lazily; a decision that stopped at its allowance, at the key or
 * above it, is undecided by the stop, and syntax decides nothing there (S3 §5: every read of it `budget`).
 */
export function cheapDecided(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
): CheapDecision | null {
  if (!syntaxDecides(walk) || walk.admission.decisionStopped(root, path)) return null;
  const memo = keptKey(walk.pass.program.work, root, path);
  const known = walk.cheapDecisions.get(memo);
  if (known !== undefined) return known;
  const frontier = cheapFrontier(walk, root, path);
  const tags = new Set<ItemTag>();
  const names = new Set<string>();
  let decider: Definition | null = null;
  let inherited = false;
  let told = frontier.told;
  const take = (tag: ItemTag, by: Definition, written: boolean): void => {
    tags.add(tag);
    if (tag === "null") return;
    const earlier = earlierStore(decider, by);
    if (earlier !== decider) inherited = written;
    decider = earlier;
  };
  for (const shape of told ? frontier.shapes : []) {
    for (const tag of shape.tags) if (tag !== "null") take(tag, shape.first!, false);
    if (shape.tags.has("null")) tags.add("null");
    for (const name of shape.names) names.add(name);
  }
  for (const { term, by } of told ? frontier.written : []) {
    const written = typeTags(term);
    if (written.length === 0 || written.includes("unknown")) told = false;
    for (const tag of written) take(tag, by, true);
    for (const name of termNames(term)) names.add(name);
  }
  let kinds = [...tags].filter((tag) => tag !== "null");
  if (kinds.includes("integer") && kinds.includes("number"))
    kinds = kinds.filter((tag) => tag !== "integer");
  const decision: CheapDecision | null =
    !told || decider === null || kinds.length === 0
      ? null
      : { kinds: tags.has("null") ? [...kinds, "null"] : kinds, names, decider, inherited };
  walk.cheapDecisions.set(memo, decision);
  return decision;
}

/**
 * Whether the stores' syntax may decide (source 4): not in a finishing walk before admission settled, where admission's
 * decision rests on a contract a fresh pass has not solved (TABLE r4.135).
 */
function syntaxDecides(walk: Consumers): boolean {
  return !walk.finishing || walk.settled;
}

/**
 * What reaches `path` of `root` by syntax (`CheapFrontier`): made from its owner path's by one step, so each path is
 * made once and a deep path costs one step per level, not a walk from the root at each.
 */
function cheapFrontier(walk: Consumers, root: PlaceId, path: readonly string[]): CheapFrontier {
  const { program } = walk.pass;
  // (the longest prefix already made, from the end: a deeper path is mostly asked after its owner)
  let made = path.length;
  let frontier: CheapFrontier | undefined;
  for (; made >= 0; made -= 1) {
    frontier = walk.cheapFrontiers.get(keyOf(root, path.slice(0, made)));
    if (frontier !== undefined) break;
  }
  for (let at = made + 1; at <= path.length; at += 1) {
    program.work.charge("checks");
    const shapes: CheapShape[] = [];
    const written: { readonly term: TypeTerm; readonly by: Definition }[] = [];
    let told = frontier?.told ?? true;
    if (frontier !== undefined && told) {
      const step = path[at - 1]!;
      for (const shape of frontier.shapes) {
        const child = shape.children.get(step);
        if (child !== undefined) shapes.push(child);
        // (a value of another kind has no such part: what a read finds there only the analysis tells)
        for (const tag of shape.tags)
          if (
            tag !== "null" &&
            (step === "element" ? !["list", "set", "dict"].includes(tag) : tag !== "object")
          )
            told = false;
      }
      for (const { term, by } of frontier.written) {
        const below = termAt(term, [step]);
        if (below === null) told = false;
        else written.push({ term: below, by });
      }
    }
    const key = keptKey(program.work, root, path.slice(0, at));
    if (told) shapes.push(cheapShapeOf(walk, key));
    // (a copy enters where its store lands, with its source's type from the copied path on)
    for (const shape of told ? shapes : []) {
      if (shape.opaque) told = false;
      for (const { term, path: from, by } of shape.written) {
        const entered = termAt(term, from);
        if (entered === null) told = false;
        else written.push({ term: entered, by });
      }
    }
    frontier = { shapes, written, told };
    walk.cheapFrontiers.set(key, frontier);
  }
  return frontier!;
}

/** The shape the stores into `key` give the paths below it by their syntax (`CheapShape`), each value entered once. */
function cheapShapeOf(walk: Consumers, key: Key): CheapShape {
  const known = walk.cheapShapes.get(key);
  if (known !== undefined) return known;
  const { program, definitions } = walk.pass;
  const shape = cheapShape();
  walk.cheapShapes.set(key, shape);
  // (each value with the shape it reaches; `elements`: only its elements reach it, as `addAll` adds them)
  const pending: [CheapShape, PlaceId, Definition, boolean][] = [];
  for (const d of definitions.byKey.get(key) ?? []) {
    program.work.charge("checks");
    // (a clear or a removal takes a value away; it gives none)
    if (d.kind === "clear" || d.kind === "weaken") continue;
    if (d.kind === "const") for (const item of d.items ?? []) cheapGive(shape, item.tag, d);
    else if (d.value === undefined) shape.opaque = true;
    else if (d.kind === "add")
      pending.push([cheapChild(shape, "element"), d.value, d, d.how === "elements"]);
    else pending.push([shape, d.value, d, false]);
  }
  while (pending.length > 0) {
    const [at, value, d, elements] = pending.pop()!;
    program.work.charge("checks");
    const place = program.places[value]?.kind;
    const node = place?.kind === "value" ? place.node : null;
    // a projection of a literal no place holds: what its cells give, each its own value (or its elements), as the
    // finishing read takes them (#1563)
    const cells = placelessCells(walk, value);
    if (cells !== null) {
      for (const cell of cells)
        if (cell.value === undefined) at.opaque = true;
        else pending.push([at, cell.value, d, elements]);
      continue;
    }
    if (elements) {
      // a collection's elements: a list's or a set's literal ones, a written copy's element type, a host value's none
      if (node === "listLiteral" || node === "setLiteral") {
        for (const child of walk.admission.literalChildren(value, "element"))
          if (child.value === undefined) at.opaque = true;
          else pending.push([at, child.value, d, false]);
        continue;
      }
      const literal = node !== null && (LITERALS.has(node) || OWN_TAGS.has(node));
      const source = literal ? null : copySource(walk, value);
      if (source === null) at.opaque = true;
      else if (source !== "external")
        at.written.push({
          term: source.term,
          path: keptSteps(program.work, source.path, ["element"]),
          by: d,
        });
      continue;
    }
    if (node !== null && LITERALS.has(node)) {
      const has = program.hasOf.get(value);
      if (has?.length === 1 && has[0]!.type.kind === "atom") cheapGive(at, has[0]!.type.name, d);
      else at.opaque = true;
      continue;
    }
    const own = node === null ? undefined : OWN_TAGS.get(node);
    if (own !== undefined) {
      cheapGive(at, own, d);
      const steps = literalSteps(walk, value, own);
      if (own === "object") {
        for (const step of steps) at.names.add(propertyName(step));
        // (objects with other properties: a read of one may find it missing, which only the analysis tells)
        if (at.properties === null) at.properties = steps;
        else if (at.properties.size !== steps.size) at.opaque = true;
        else
          for (const step of steps) {
            program.work.charge("checks");
            if (!at.properties.has(step)) at.opaque = true;
          }
      }
      for (const step of steps) {
        const below = cheapChild(at, step);
        for (const child of walk.admission.literalChildren(value, step))
          if (child.value === undefined) below.opaque = true;
          else pending.push([below, child.value, d, false]);
      }
      continue;
    }
    // a typed parse or load (F18): what its default's syntax gives, as its typed default reads it (a written
    // destination's type is the store's own); none without a default
    const fallback = typedFallback(walk, value);
    if (fallback !== null) {
      if (fallback === undefined) at.opaque = true;
      else pending.push([at, fallback, d, false]);
      continue;
    }
    const source = copySource(walk, value);
    if (source === null) at.opaque = true;
    else if (source !== "external") at.written.push({ ...source, by: d });
  }
  return shape;
}

/** A typed parse's or load's default (F18), `undefined` where it has none; `null` for any other value. */
function typedFallback(walk: Consumers, value: PlaceId): PlaceId | undefined | null {
  const c = walk.pass.program.opOf.get(value);
  if (c?.kind === "load") return c.fallback ?? undefined;
  return c?.kind === "operation" &&
    c.contract.family === "conversion" &&
    conversionCategory(c.contract.name)?.kind === "parses"
    ? (defaultOf(c) ?? undefined)
    : null;
}

/** A collection or object literal's steps to its parts: its properties, else `element` (a dict's values too). */
function literalSteps(walk: Consumers, value: PlaceId, own: ItemTag): Set<string> {
  const steps = new Set<string>();
  if (own !== "object") return steps.add("element");
  for (const has of walk.pass.program.hasOf.get(value) ?? [])
    for (const name of termNames(has.type)) steps.add(propertyStep(name));
  return steps;
}

/**
 * What a copy copies by its syntax: a written place's type and the path it is copied from; `external` for a host
 * value the script never stores into; `null` for anything else.
 */
function copySource(
  walk: Consumers,
  value: PlaceId,
): { readonly term: TypeTerm; readonly path: readonly string[] } | "external" | null {
  const { program, definitions } = walk.pass;
  const copied: string[] = [];
  let at = value;
  for (let projection = program.projOf.get(at); projection !== undefined;) {
    program.work.charge("checks");
    if (projection.step === "iteration") return null;
    copied.push(stepName(projection.step));
    at = projection.owner;
    projection = program.projOf.get(at);
  }
  const binding = program.occurrenceOf.get(at);
  if (binding === undefined) return null;
  const { root, path } = program.targetRoot(binding);
  const kind = program.place(root).kind;
  const written = writtenOf(kind);
  if (written !== null) return { term: written, path: joinSteps(path, copied.reverse()) };
  if (walk.storedRoots === null) {
    walk.storedRoots = new Set();
    for (const key of definitions.byKey.keys()) walk.storedRoots.add(keyPlace(key));
  }
  return kind.kind === "binding" &&
    kind.declared === "host" &&
    !walk.storedRoots.has(root) &&
    (program.hasOf.get(at) ?? []).every((has) => has.type.kind === "dynamic")
    ? "external"
    : null;
}
