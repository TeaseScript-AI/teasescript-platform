import type { PlaceId, TypeTerm } from "../../graph.js";
import { joinSteps, keptSteps } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { defaultOf, termAt, typeTags, writtenOf } from "../contract.js";
import { keptKey, keyOf, keyPath, keyPlace, type Definition, type Key } from "../definitions.js";
import {
  covering,
  joinSpelling,
  kindsInItsOrder,
  spelledBy,
  type ItemTag,
  type Spelling,
} from "../items.js";
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
    copies: [],
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
 * at that path reads them; `null` for any other value, and where a step meets a value that is no such literal or a
 * literal with no part there (its absence is the analysis's to tell, the read's obligations with it). Structure only,
 * the finishing read's and the stores' syntax's alike; each projection made once a walk.
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
      let every = true;
      for (const literal of literals) {
        const parts = walk.admission.literalChildren(literal, step);
        every &&= parts.length > 0;
        cells.push(...parts);
      }
      found = every && cells.length > 0 ? cells : null;
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
 * What the stores' syntax decides at a read's key path and `rest` (`cheapDecided`): its kinds and the spelling that
 * orders them, if any; else `null`; the key made only where syntax may decide (`syntaxDecides`).
 */
export function syntaxRead(
  walk: Consumers,
  value: PlaceId,
  rest: readonly string[],
): Pick<CheapDecision, "kinds" | "spelling"> | null {
  if (!syntaxDecides(walk)) return null;
  const key = readKey(walk, value);
  return key === null ? null : walk.cheapDecided(keyPlace(key), joinSteps(keyPath(key), rest));
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
  for (const { shape, by } of told ? frontier.shapes : []) {
    for (const tag of shape.tags) if (tag !== "null") take(tag, by ?? shape.first!, false);
    if (shape.tags.has("null")) tags.add("null");
    for (const name of shape.names) names.add(name);
  }
  let spelling: Spelling | undefined;
  for (const { term, by } of told ? frontier.written : []) {
    const written = typeTags(term);
    if (written.length === 0 || written.includes("unknown")) told = false;
    spelling = joinSpelling(spelling, spelledBy(written).spelling);
    for (const tag of written) take(tag, by, true);
    for (const name of termNames(term)) names.add(name);
  }
  // (the stores' kinds together in their one order, #1398: a written spelling's where it alone covers them)
  const all = [...tags].filter((tag) => tag !== "null");
  const spelled = covering(all, spelling);
  let kinds = kindsInItsOrder(all, spelled);
  if (kinds.includes("integer") && kinds.includes("number"))
    kinds = kinds.filter((tag) => tag !== "integer");
  const decision: CheapDecision | null =
    !told || decider === null || kinds.length === 0
      ? null
      : {
          kinds: tags.has("null") ? [...kinds, "null"] : kinds,
          ...(spelled === undefined ? {} : { spelling: spelled }),
          names,
          decider,
          inherited,
        };
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
 * How long a chain of copies of inferred places the stores' syntax follows from the key it decides (#1604): a copy past
 * it is not told by syntax, as before the chain was followed.
 */
const SYNTAX_COPIES = 8;

/**
 * Each walk's following of copies of inferred places (`linkedFrontier`): the levels being made, each with the chain's
 * depth it is made at (a copy reaching one again closes a cycle of copies); the chain's depth now; the least depth a
 * cycle closed at while the running level was made (`back`); and how often a chain was cut at `SYNTAX_COPIES`.
 */
interface Following {
  readonly making: Map<Key, number>;
  depth: number;
  back: number;
  cuts: number;
}

const following = new WeakMap<Consumers, Following>();

function followingOf(walk: Consumers): Following {
  let state = following.get(walk);
  if (state === undefined)
    following.set(walk, (state = { making: new Map(), depth: 0, back: Infinity, cuts: 0 }));
  return state;
}

/** A copy closing a cycle of copies brings nothing of its own: its source's values are the cycle's, which its first level unites. */
const CLOSED: CheapFrontier = { shapes: [], written: [], told: true, reach: 0 };

/**
 * What reaches `path` of `root` by syntax (`CheapFrontier`): made from its owner path's by one step, so each path is
 * made once and a deep path costs one step per level, not a walk from the root at each. A copy of an inferred place
 * there brings its source's frontier at the copied path (`linkedFrontier`), each of its shapes and written types given
 * by the copying store; its parts are its shapes' children on the next step, so each level is made once (#1604).
 */
function cheapFrontier(walk: Consumers, root: PlaceId, path: readonly string[]): CheapFrontier {
  const { program } = walk.pass;
  const state = followingOf(walk);
  // (the longest prefix already made, from the end: a deeper path is mostly asked after its owner)
  let made = path.length;
  let frontier: CheapFrontier | undefined;
  for (; made >= 0; made -= 1) {
    frontier = walk.cheapFrontiers.get(keyOf(root, path.slice(0, made)));
    if (frontier !== undefined) break;
  }
  // (a prefix whose chain reaches past the bound from here is cut, as its levels below are)
  let cut = frontier !== undefined && state.depth + frontier.reach > SYNTAX_COPIES;
  if (cut) state.cuts += 1;
  let partial = false;
  for (let at = made + 1; at <= path.length; at += 1) {
    program.work.charge("checks");
    const shapes: { shape: CheapShape; by: Definition | null }[] = [];
    const written: { readonly term: TypeTerm; readonly by: Definition }[] = [];
    let told = !cut && (frontier?.told ?? true);
    let reach = frontier?.reach ?? 0;
    if (frontier !== undefined && told) {
      const step = path[at - 1]!;
      for (const { shape, by } of frontier.shapes) {
        const child = shape.children.get(step);
        if (child !== undefined) shapes.push({ shape: child, by });
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
    // (a level below one being made, reached again through copies: what it holds only the analysis tells)
    const again = state.making.has(key);
    if (again) told = false;
    if (told) shapes.push({ shape: cheapShapeOf(walk, key), by: null });
    const [cuts, back] = [state.cuts, state.back];
    state.back = Infinity;
    if (!again) state.making.set(key, state.depth);
    try {
      // (a copy enters where its store lands, with its source's type from the copied path on; a copy of an inferred
      // place with its source's frontier there, entered whole: its shapes' own parts are its, not entered again)
      const own = told ? shapes.length : 0;
      for (let index = 0; index < own && told; index += 1) {
        const { shape, by } = shapes[index]!;
        if (shape.opaque) told = false;
        for (const { term, path: from, by: store } of shape.written) {
          const entered = termAt(term, from);
          if (entered === null) told = false;
          else written.push({ term: entered, by: by ?? store });
        }
        for (const copy of shape.copies) {
          const source = linkedFrontier(walk, copy.root, copy.path);
          if (source === null || !source.told) {
            told = false;
            break;
          }
          // (each of the source's shapes and types looked at once, charged)
          program.work.charge("checks", source.shapes.length + source.written.length);
          for (const each of source.shapes) shapes.push({ shape: each.shape, by: by ?? copy.by });
          for (const each of source.written) written.push({ term: each.term, by: by ?? copy.by });
          reach = Math.max(reach, source.reach + 1);
        }
      }
    } finally {
      if (!again) state.making.delete(key);
    }
    // (object literals with other properties where a copy brought some of the level's shapes, beside the key's own or
    // another copy's: a read of one may find it missing, which only the analysis tells, as within one key's shape)
    let properties: ReadonlySet<string> | null = null;
    for (const { shape } of told && shapes.some(({ by }) => by !== null) ? shapes : []) {
      if (shape.properties === null) continue;
      program.work.charge("checks", shape.properties.size);
      if (properties === null) properties = shape.properties;
      else if (
        properties.size !== shape.properties.size ||
        [...shape.properties].some((step) => !properties!.has(step))
      ) {
        told = false;
        break;
      }
    }
    cut ||= state.cuts !== cuts;
    // (a level whose copies closed a cycle at a level made before it, further up the chain, holds that cycle's values
    // only in part, and so does each level below it: made again where it is asked, never kept; the cycle's first level
    // unites them and is kept)
    partial ||= state.back < state.depth;
    state.back = Math.min(back, state.back);
    // (a level a cut chain left untold is kept only where its chain started, where the cut is the key's own: past the
    // bound from it, so never told there whatever was made before; elsewhere it is made again from where it is asked)
    frontier = { shapes, written, told: told && !cut, reach: cut ? Infinity : reach };
    if ((!cut || state.depth === 0) && !partial) walk.cheapFrontiers.set(key, frontier);
  }
  return frontier!;
}

/**
 * A copy's source's frontier at its copied path (`cheapFrontier`), one link further along the chain: `CLOSED` where the
 * chain reaches that level while it is being made (a cycle of copies, whose first level unites its values); `null`
 * where it reaches past `SYNTAX_COPIES` from the key being decided (counted in `cuts`, so no level made on it is kept for
 * another chain).
 */
function linkedFrontier(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
): CheapFrontier | null {
  const state = followingOf(walk);
  const key = keptKey(walk.pass.program.work, root, path);
  const closing = state.making.get(key);
  if (closing !== undefined) {
    state.back = Math.min(state.back, closing);
    return CLOSED;
  }
  const known = walk.cheapFrontiers.get(key);
  if (known !== undefined && state.depth + 1 + known.reach <= SYNTAX_COPIES) return known;
  if (state.depth + 1 > SYNTAX_COPIES || known !== undefined) {
    state.cuts += 1;
    return null;
  }
  state.depth += 1;
  try {
    return cheapFrontier(walk, root, path);
  } finally {
    state.depth -= 1;
  }
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
    if (source !== null) {
      if (source !== "external") at.written.push({ ...source, by: d });
      continue;
    }
    // (a copy of an inferred place: its source's own syntax there, read through its frontier, #1604)
    const copied = inferredCopy(walk, value);
    if (copied === null) at.opaque = true;
    else at.copies.push({ ...copied, by: d });
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
 * A copy of an inferred place by its syntax (#1604): a read of a `let` or global binding with no written type, through
 * its projections, and the path it is copied from; `null` for anything else, and for a place the script stores into
 * below its root (an add among them), whose parts its root's stores alone do not tell, so its frontier there is its
 * root's shapes' parts and nothing else.
 */
function inferredCopy(
  walk: Consumers,
  value: PlaceId,
): { readonly root: PlaceId; readonly path: readonly string[] } | null {
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
  if (kind.kind !== "binding" || (kind.declared !== "let" && kind.declared !== "global"))
    return null;
  if (walk.storedBelow === null) {
    walk.storedBelow = new Set();
    for (const key of definitions.byKey.keys()) {
      program.work.charge("checks");
      if (keyPath(key).length > 0) walk.storedBelow.add(keyPlace(key));
    }
  }
  return walk.storedBelow.has(root) ? null : { root, path: joinSteps(path, copied.reverse()) };
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
