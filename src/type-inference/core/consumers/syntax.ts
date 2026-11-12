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
import { propertyStep, stepName } from "../program.js";
import { LITERALS } from "./kinds.js";
import {
  FRONTIER_COPIES,
  type CheapDecision,
  type CheapFrontier,
  type CheapShape,
} from "./model.js";
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
  // `literalChildren`, and each cell stepped through)
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
 * The syntax decision, source 4: at a settled stop, where admission retained no
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
  // (#2289: nor where a literal's stopped element left the key or a key above it undecided)
  if (
    !syntaxDecides(walk) ||
    walk.admission.decisionStopped(root, path) ||
    walk.admission.budgetUndecidedAt(root, path, true)
  )
    return null;
  const memo = keptKey(walk.pass.program.work, root, path);
  const known = walk.cheapDecisions.get(memo);
  if (known !== undefined) return known;
  const frontier = cheapFrontier(walk, root, path);
  // (an untold frontier decides nothing: its summary is not made, as on `main`, Codex r6's B1 on #1653)
  if (!frontier.told) {
    walk.cheapDecisions.set(memo, null);
    return null;
  }
  const summary = summaryOf(walk, frontier);
  // (the stores' kinds together in their one order, #1398: a written spelling's where it alone covers them)
  const all = [...summary.tags].filter((tag) => tag !== "null");
  const spelled = covering(all, summary.spelling);
  let kinds = kindsInItsOrder(all, spelled);
  if (kinds.includes("integer") && kinds.includes("number"))
    kinds = kinds.filter((tag) => tag !== "integer");
  const decision: CheapDecision | null =
    !summary.told || summary.decider === null || kinds.length === 0
      ? null
      : {
          kinds: summary.tags.has("null") ? [...kinds, "null"] : kinds,
          ...(spelled === undefined ? {} : { spelling: spelled }),
          decider: summary.decider,
          inherited: !summary.byShape,
        };
  walk.cheapDecisions.set(memo, decision);
  return decision;
}

/**
 * Whether the stores' syntax may decide (source 4): not in a finishing walk before admission settled, where admission's
 * decision rests on a contract a fresh pass has not solved.
 */
function syntaxDecides(walk: Consumers): boolean {
  return !walk.finishing || walk.settled;
}

/**
 * Each walk's following of copies of inferred places (`linkedFrontier`): the levels being made (a copy reaching one
 * again is a cycle of copies, not told); the chain's depth now; how often a chain was cut at `FRONTIER_COPIES`; and
 * each level found cut, by the least depth it was made at (`cutFrom`).
 */
interface Following {
  readonly making: Set<Key>;
  depth: number;
  cuts: number;
  readonly cutFrom: Map<Key, number>;
}

const following = new WeakMap<Consumers, Following>();

function followingOf(walk: Consumers): Following {
  let state = following.get(walk);
  if (state === undefined)
    following.set(walk, (state = { making: new Set(), depth: 0, cuts: 0, cutFrom: new Map() }));
  return state;
}

/**
 * What reaches `path` of `root` by syntax (`CheapFrontier`): made from its owner path's by one step (`levelBelow`), so
 * each path is made once and a deep path costs one step per level, not a walk from the root at each. A copy of an
 * inferred place there links its source's frontier at the copied path (`linkedFrontier`), by the copying store; one
 * step down, the link is that frontier's own next level (#1604).
 */
function cheapFrontier(walk: Consumers, root: PlaceId, path: readonly string[]): CheapFrontier {
  const state = followingOf(walk);
  // (the longest prefix already made, from the end: a deeper path is mostly asked after its owner)
  let made = path.length;
  let frontier: CheapFrontier | undefined;
  for (; made >= 0; made -= 1) {
    frontier = walk.cheapFrontiers.get(keyOf(root, path.slice(0, made)));
    if (frontier !== undefined) break;
  }
  // (a prefix whose chain reaches past the bound from here is cut, as its levels below are)
  let cut = frontier !== undefined && state.depth + frontier.reach > FRONTIER_COPIES;
  if (cut) state.cuts += 1;
  for (let at = made + 1; at <= path.length; at += 1) {
    const level = levelBelow(walk, root, path.slice(0, at), frontier, cut);
    [frontier, cut] = [level.frontier, level.cut];
    // (a level a cut chain left untold is kept only where its chain started, where the cut is the key's own: past the
    // bound from it, so never told there whatever was made before; elsewhere it is made again; a level a cycle of
    // copies reaches is untold wherever it is made, and kept)
    if (!cut || state.depth === 0)
      walk.cheapFrontiers.set(keptKey(walk.pass.program.work, root, path.slice(0, at)), frontier);
  }
  return frontier!;
}

/**
 * One level of a frontier (`cheapFrontier`): at `path` of `root`, below the owner's frontier `above` (none at the root),
 * whether a chain was cut on the way (`cut`); with whether a chain was cut by now.
 */
function levelBelow(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
  above: CheapFrontier | undefined,
  cutAbove: boolean,
): { readonly frontier: CheapFrontier; readonly cut: boolean } {
  const { program } = walk.pass;
  const state = followingOf(walk);
  program.work.charge("checks");
  const key = keptKey(program.work, root, path);
  // (a level found cut where it was made at `d` has a chain of copies longer than `FRONTIER_COPIES` - `d` below it:
  // cut again wherever it is asked at `d` or deeper, made again only where it is asked higher up, so each level is
  // made at most `FRONTIER_COPIES` + 1 times; a level cut higher up may be told lower down, never the other way,
  // Codex r5's B1 on #1653)
  const cutFrom = state.cutFrom.get(key);
  if (cutFrom !== undefined && state.depth >= cutFrom) {
    state.cuts += 1;
    return { frontier: CUT, cut: true };
  }
  const shapes: CheapShape[] = [];
  const written: { term: TypeTerm; by: Definition }[] = [];
  const links: {
    root: PlaceId;
    path: readonly string[];
    by: Definition;
    frontier: CheapFrontier;
  }[] = [];
  // (each shape, written type and copied source once a level, a type and a source given by the earliest store that
  // brings it, as the decider is: copies of one source through several stores or levels bring the same again, Codex
  // r1's and r2's B1 on #1653; a source's frontier is linked, never copied into this one)
  const entered = new Set<CheapShape>();
  const enter = (shape: CheapShape): void => {
    if (entered.has(shape)) return;
    entered.add(shape);
    shapes.push(shape);
  };
  const enteredTerms = new Map<TypeTerm, number>();
  const enterTerm = (term: TypeTerm, by: Definition): void => {
    const known = enteredTerms.get(term);
    if (known === undefined) {
      enteredTerms.set(term, written.length);
      written.push({ term, by });
    } else written[known]!.by = earlierStore(written[known]!.by, by);
  };
  let told = !cutAbove && (above?.told ?? true);
  let reach = above?.reach ?? 0;
  const linked = new Map<Key, number>();
  // (a copied source's frontier at `from`, by the store `by`; `parent`: the frontier linked one step above, whose own
  // next level it is)
  const link = (
    source: PlaceId,
    from: readonly string[],
    by: Definition,
    parent?: CheapFrontier,
  ): void => {
    program.work.charge("checks");
    const at = keptKey(program.work, source, from);
    const known = linked.get(at);
    if (known !== undefined) {
      links[known]!.by = earlierStore(links[known]!.by, by);
      return;
    }
    const found =
      parent === undefined
        ? linkedFrontier(walk, source, from)
        : linkedBelow(walk, source, from, parent);
    if (found === null || !found.told) told = false;
    else {
      linked.set(at, links.length);
      links.push({ root: source, path: from, by, frontier: found });
      reach = Math.max(reach, found.reach + 1);
    }
  };
  const step = path.at(-1);
  if (above !== undefined && step !== undefined && told) {
    // (each shape and written type above looked at once here, charged)
    program.work.charge("checks", above.shapes.length + above.written.length);
    for (const shape of above.shapes) {
      const child = shape.children.get(step);
      if (child !== undefined) enter(child);
      // (a value of another kind has no such part: what a read finds there only the analysis tells)
      for (const tag of shape.tags)
        if (
          tag !== "null" &&
          (step === "element" ? !["list", "set", "dict"].includes(tag) : tag !== "object")
        )
          told = false;
    }
    for (const { term, by } of above.written) {
      const below = termAt(term, [step]);
      if (below === null) told = false;
      else enterTerm(below, by);
    }
  }
  // (a level below one being made, reached again through copies: what it holds only the analysis tells)
  const again = state.making.has(key);
  if (again) told = false;
  if (told) enter(cheapShapeOf(walk, key));
  const cuts = state.cuts;
  if (!again) state.making.add(key);
  try {
    // (a copied source's frontier one step down: its own next level, by the store that copied it)
    if (above !== undefined && step !== undefined && told)
      for (const each of above.links) {
        link(each.root, joinSteps(each.path, [step]), each.by, each.frontier);
        if (!told) break;
      }
    // (a copy enters where its store lands, with its source's type from the copied path on; a copy of an inferred
    // place by its source's frontier there, linked)
    for (let index = 0; index < shapes.length && told; index += 1) {
      const shape = shapes[index]!;
      program.work.charge("checks", 1 + shape.written.length);
      if (shape.opaque) told = false;
      for (const { term, path: from, by } of shape.written) {
        const below = termAt(term, from);
        if (below === null) told = false;
        else enterTerm(below, by);
      }
      for (const copy of shape.copies) {
        link(copy.root, copy.path, copy.by);
        if (!told) break;
      }
    }
  } finally {
    if (!again) state.making.delete(key);
  }
  // (object literals with other properties where a copy brought some of the level's shapes, beside the key's own or
  // another copy's: a read of one may find it missing, which only the analysis tells, as within one key's shape)
  if (told && links.some((each) => summaryOf(walk, each.frontier).shaped)) {
    let properties: number | null = null;
    for (const shape of shapes) properties = joinProperties(properties, propertyToken(walk, shape));
    for (const each of links)
      properties = joinProperties(properties, summaryOf(walk, each.frontier).properties);
    if (properties === CONFLICT) told = false;
  }
  const cut = cutAbove || state.cuts !== cuts;
  if (cut) state.cutFrom.set(key, Math.min(cutFrom ?? Infinity, state.depth));
  return {
    frontier: { shapes, written, links, told: told && !cut, reach: cut ? Infinity : reach },
    cut,
  };
}

/** A level cut at `FRONTIER_COPIES` (`levelBelow`): untold, its chain past the bound. */
const CUT: CheapFrontier = { shapes: [], written: [], links: [], told: false, reach: Infinity };

/**
 * A linked source's next level (`levelBelow`) below the frontier `parent` it was linked at one step above, one link
 * further along the chain, as `linkedFrontier` takes a level.
 */
function linkedBelow(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
  parent: CheapFrontier,
): CheapFrontier | null {
  const state = followingOf(walk);
  const key = keptKey(walk.pass.program.work, root, path);
  // (a cycle of copies: what it holds only the analysis tells, whatever order its keys are asked in, #1604)
  if (state.making.has(key)) return null;
  const known = walk.cheapFrontiers.get(key);
  if (known !== undefined && state.depth + 1 + known.reach <= FRONTIER_COPIES) return known;
  if (state.depth + 1 > FRONTIER_COPIES || known !== undefined) {
    state.cuts += 1;
    return null;
  }
  state.depth += 1;
  try {
    const level = levelBelow(walk, root, path, parent, false);
    if (!level.cut) walk.cheapFrontiers.set(key, level.frontier);
    return level.frontier;
  } finally {
    state.depth -= 1;
  }
}

/** Two object literals' property sets that differ (`joinProperties`). */
const CONFLICT = -1;

/** Two property-set tokens together: `null` for none, the one token where they agree, else `CONFLICT`. */
function joinProperties(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null || a === b ? a : CONFLICT;
}

/** Each walk's written types' kinds (`termKinds`). */
const kindsByTerm = new WeakMap<Consumers, WeakMap<TypeTerm, readonly ItemTag[]>>();

/**
 * A written type's kinds, each once in the order first written (`spelledBy` reads them so): made once a type and walk,
 * each member of its unions looked at then and charged, so a wide type read through many frontiers is looked at once
 * (Codex r6's B1 on #1653).
 */
function termKinds(walk: Consumers, term: TypeTerm): readonly ItemTag[] {
  let terms = kindsByTerm.get(walk);
  if (terms === undefined) kindsByTerm.set(walk, (terms = new WeakMap()));
  let kinds = terms.get(term);
  if (kinds === undefined) {
    const members = typeTags(term);
    walk.pass.program.work.charge("checks", members.length);
    kinds = [...new Set(members)];
    terms.set(term, kinds);
  }
  return kinds;
}

/**
 * What a frontier's syntax decides, its linked sources' included, each source's contribution given by the store that
 * copied it (`summaryOf`): whether every written type there is told; the kinds; the written spelling; the property sets'
 * token; the earliest store giving a kind other than `null` and whether it gave a shape's (else only a written type's);
 * whether a shape, or only a written type, gives one. No property names: no reader of a decision asks them, so none
 * travels through a link (Codex r4's B1 on #1653).
 */
interface Summary {
  readonly told: boolean;
  readonly tags: ReadonlySet<ItemTag>;
  readonly spelling: Spelling | undefined;
  readonly properties: number | null;
  readonly decider: Definition | null;
  readonly byShape: boolean;
  readonly shaped: boolean;
  readonly typed: boolean;
}

const summaries = new WeakMap<CheapFrontier, Summary>();

/**
 * A frontier's summary (`Summary`), made once a frontier from its own shapes and written types and its links' summaries,
 * each looked at once and charged, so a source copied into many keys is summed once, never copied into each (#1604;
 * Codex r2's B1 on #1653).
 */
function summaryOf(walk: Consumers, frontier: CheapFrontier): Summary {
  const known = summaries.get(frontier);
  if (known !== undefined) return known;
  const tags = new Set<ItemTag>();
  const stores = new Map<Definition, boolean>();
  let told = true;
  let spelling: Spelling | undefined;
  let properties: number | null = null;
  let [shaped, typed] = [false, false];
  const give = (by: Definition, shape: boolean): void => {
    stores.set(by, (stores.get(by) ?? false) || shape);
    if (shape) shaped = true;
    else typed = true;
  };
  walk.pass.program.work.charge(
    "checks",
    1 + frontier.shapes.length + frontier.written.length + frontier.links.length,
  );
  for (const shape of frontier.shapes) {
    for (const tag of shape.tags) {
      tags.add(tag);
      if (tag !== "null") give(shape.first!, true);
    }
    const token = propertyToken(walk, shape);
    properties = joinProperties(properties, token);
  }
  for (const { term, by } of frontier.written) {
    const kinds = termKinds(walk, term);
    if (kinds.length === 0 || kinds.includes("unknown")) told = false;
    spelling = joinSpelling(spelling, spelledBy(kinds).spelling);
    for (const tag of kinds) {
      tags.add(tag);
      if (tag !== "null") give(by, false);
    }
  }
  for (const { by, frontier: source } of frontier.links) {
    const other = summaryOf(walk, source);
    // (its kinds and stores looked at once here, charged)
    walk.pass.program.work.charge("checks", other.tags.size);
    told &&= other.told;
    for (const tag of other.tags) tags.add(tag);
    spelling = joinSpelling(spelling, other.spelling);
    properties = joinProperties(properties, other.properties);
    if (other.shaped) give(by, true);
    else if (other.typed) give(by, false);
  }
  let decider: Definition | null = null;
  for (const by of stores.keys()) decider = earlierStore(decider, by);
  const summary: Summary = {
    told,
    tags,
    spelling,
    properties,
    decider,
    byShape: decider !== null && stores.get(decider) === true,
    shaped,
    typed,
  };
  summaries.set(frontier, summary);
  return summary;
}

/** Each shape's object literal's properties as a token (`propertyToken`), and each walk's tokens by their sets. */
const propertyTokens = new WeakMap<CheapShape, number | null>();
const tokensOf = new WeakMap<Consumers, Map<string, number>>();

/**
 * A shape's object literal's properties as a token, one per set of names in the walk, `null` where it has none: made and
 * charged once a shape, its names looked at once there, so a level compares its shapes in one step each whatever their
 * width, also where distinct shapes hold the same names (#1604; Codex r1's B2 on #1653).
 */
function propertyToken(walk: Consumers, shape: CheapShape): number | null {
  let token = propertyTokens.get(shape);
  if (token === undefined) {
    if (shape.properties === null) token = null;
    else {
      walk.pass.program.work.charge("checks", shape.properties.size);
      let tokens = tokensOf.get(walk);
      if (tokens === undefined) tokensOf.set(walk, (tokens = new Map()));
      const names = [...shape.properties].sort().join(" ");
      token = tokens.get(names);
      if (token === undefined) tokens.set(names, (token = tokens.size));
    }
    propertyTokens.set(shape, token);
  }
  return token;
}

/**
 * A copy's source's frontier at its copied path (`cheapFrontier`), one link further along the chain; `null` where the
 * chain reaches a level still being made (a cycle of copies: a key it reaches is untold, whatever the order its keys are
 * asked in, so a kept frontier's `reach` is the longest chain of copies from it, the same from wherever it is asked), or
 * reaches past `FRONTIER_COPIES` from the key being decided (counted in `cuts`, so no level made on it is kept for another
 * chain).
 */
function linkedFrontier(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
): CheapFrontier | null {
  const state = followingOf(walk);
  const key = keptKey(walk.pass.program.work, root, path);
  // (a cycle of copies: what it holds only the analysis tells, whatever order its keys are asked in, #1604)
  if (state.making.has(key)) return null;
  const known = walk.cheapFrontiers.get(key);
  if (known !== undefined && state.depth + 1 + known.reach <= FRONTIER_COPIES) return known;
  if (state.depth + 1 > FRONTIER_COPIES || known !== undefined) {
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
 * its projections, and the path it is copied from; `null` for anything else. Its source's stores below its root are its
 * frontier's own there, one step down a link (`linkedBelow`).
 */
function inferredCopy(
  walk: Consumers,
  value: PlaceId,
): { readonly root: PlaceId; readonly path: readonly string[] } | null {
  const { program } = walk.pass;
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
  return { root, path: joinSteps(path, copied.reverse()) };
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
