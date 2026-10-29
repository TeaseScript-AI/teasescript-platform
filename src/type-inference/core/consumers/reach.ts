import type { PlaceId, SourceSite } from "../../graph.js";
import { joinParts, keepText, keptArray } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { keyOf, type Definition } from "../definitions.js";
import { propertyStep } from "../program.js";
import type { KeyReach, Reach } from "./model.js";
import { ownSpan } from "./names.js";

// A2, ADR 0021 1.1: the first direct read or store of a path, and what reaches a place only through copies.

const LITERAL_NODES: ReadonlySet<string> = new Set([
  "objectLiteral",
  "listLiteral",
  "dictLiteral",
  "setLiteral",
]);

/**
 * The first direct read or store of a place's path in source order (ADR 0021 rule 1.1): where an error about a property
 * that reached the place only through copies of whole objects is reported, the copy its related site (A2, r4.75 (4)).
 */
export function firstDirect(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
): SourceSite | null {
  const { program, definitions } = walk.pass;
  if (walk.directSites === null) {
    const sites = new Map<string, SourceSite>();
    const earliest = (key: string, site: SourceSite | null): void => {
      program.work.charge("indexSteps");
      if (site === null) return;
      const known = sites.get(key);
      if (
        known === undefined ||
        site.file < known.file ||
        (site.file === known.file && site.start < known.start)
      ) {
        if (known === undefined) keepText(program.work, key.length);
        sites.set(key, site);
      }
    };
    for (const c of program.constraints)
      if (c.kind === "project") {
        const { root: owner, path: steps } = program.targetRoot(c.into);
        earliest(joinParts(owner, steps), c.site);
      }
    for (const d of definitions.storeDefs)
      if (d.kind === "whole" && d.path.length > 0)
        earliest(
          joinParts(d.place, d.path),
          d.into === undefined ? d.site : ownSpan(walk, d.into, d.site),
        );
    walk.directSites = sites;
  }
  return walk.directSites.get(joinParts(root, path)) ?? null;
}

/**
 * A2, ADR 0021 rule 1.1: a property that reaches a place only through copies of whole objects, where they were not
 * found to meet at the copy (a cycle of copies that adds or takes steps, TABLE r4.154), is checked at its first direct
 * read or store, the copy that brought the other type its related site (`copy`, else `site`); any other error stays
 * at `site`. `eligible`: the error is that property's, its offending contribution through whole copies.
 */
export function deferred(
  walk: Consumers,
  site: SourceSite,
  root: PlaceId,
  path: readonly string[],
  eligible: boolean,
  copy: () => PlaceId | null,
): { readonly site: SourceSite; readonly brought: SourceSite | null } {
  const last = path.at(-1);
  const kept = { site, brought: null };
  if (!eligible || last === undefined || last === "element" || last === "entry") return kept;
  const first = firstDirect(walk, root, path);
  if (first === null) return kept;
  const brought = copy();
  return {
    site: first,
    brought: (brought === null ? null : walk.pass.program.places[brought]?.site) ?? site,
  };
}

/**
 * Whether a value is a whole copy of another place's: a variable's read, or a projection of one (`bundle.left`,
 * `xs[0]`), never a literal, a call or an operation.
 */
function isCopy(walk: Consumers, value: PlaceId | undefined): boolean {
  const { program } = walk.pass;
  let at = value;
  for (let depth = 0; at !== undefined && depth < 256; depth += 1) {
    if (program.occurrenceOf.has(at)) return true;
    const projection = program.projOf.get(at);
    if (projection === undefined || projection.step === "iteration") return false;
    at = projection.owner;
  }
  return false;
}

/** Whether a value is a literal: a list, set, dict or object literal, whose children stand below it. */
function isLiteral(walk: Consumers, value: PlaceId): boolean {
  const { program } = walk.pass;
  const kind = program.places[value]?.kind;
  return program.hasOf.has(value) || (kind?.kind === "value" && LITERAL_NODES.has(kind.node));
}

/**
 * A literal's children by step: its element and dict value cells as `element` (the key's step, as `targetRoot` makes
 * it), its properties by name. Once for the program.
 */
function childrenOf(
  walk: Consumers,
  literal: PlaceId,
): ReadonlyMap<string, readonly PlaceId[]> | undefined {
  if (walk.literalChildren === null) {
    const { program, definitions } = walk.pass;
    const index = new Map<PlaceId, Map<string, PlaceId[]>>();
    for (const place of program.places) {
      program.work.charge("indexSteps");
      const kind = place.kind;
      if (kind.kind !== "cell" && kind.kind !== "property") continue;
      const step = kind.kind === "cell" ? "element" : propertyStep(kind.name);
      let byStep = index.get(kind.owner);
      if (byStep === undefined) index.set(kind.owner, (byStep = new Map()));
      let values = byStep.get(step);
      if (values === undefined) byStep.set(step, (values = []));
      for (const d of definitions.cellDefs.get(place.id) ?? [])
        if (d.value !== undefined) values.push(d.value);
    }
    walk.literalChildren = index;
  }
  return walk.literalChildren.get(literal);
}

/** The values standing at one level, after `above`: each a whole copy, a literal, or another value. */
function reachOf(
  walk: Consumers,
  values: readonly PlaceId[],
  above: Reach | null,
  added: readonly PlaceId[] = [],
): Reach {
  const { program } = walk.pass;
  const literals: PlaceId[] = [];
  let copies = above?.copies ?? 0;
  let copy = above?.copy ?? null;
  let other = above?.other ?? false;
  for (const value of values) {
    program.work.charge("checks");
    if (isCopy(walk, value)) {
      copies += 1;
      copy ??= value;
    } else if (isLiteral(walk, value)) literals.push(value);
    else other = true;
  }
  keptArray(program.work, literals);
  return {
    literals,
    copies,
    copy,
    other,
    here: values.length,
    added,
    next: new Map(),
    children: null,
  };
}

/** The level below `reach` at `step`: its literals' children there, and the elements its key's adds bring. */
function below(walk: Consumers, reach: Reach, step: string): Reach {
  const known = reach.next.get(step);
  if (known !== undefined) return known;
  if (reach.children === null) {
    // its literals' children indexed by step once, so each step below asks only its own; kept only whole (a stop
    // inside leaves none for the finishing path to read)
    const children = new Map<string, PlaceId[]>();
    for (const literal of reach.literals)
      for (const [at, values] of childrenOf(walk, literal) ?? []) {
        walk.pass.program.work.charge("checks", values.length);
        let list = children.get(at);
        if (list === undefined) children.set(at, (list = []));
        for (const value of values) list.push(value);
      }
    reach.children = children;
  }
  const values: PlaceId[] = [];
  for (const value of reach.children.get(step) ?? []) values.push(value);
  if (step === "element") for (const value of reach.added) values.push(value);
  const found = reachOf(walk, values, reach);
  reach.next.set(step, found);
  return found;
}

/**
 * What a value brings at `steps` (A2): `brought` where it brings the property the last step names only through whole
 * copies (a copy, or literals whose children reach copies above the property's level, none giving the property
 * itself, none of another kind on the way), and `copy` the one copy that does, if one. Once per value and level.
 */
export function valueReach(
  walk: Consumers,
  value: PlaceId,
  steps: readonly string[],
): { readonly brought: boolean; readonly copy: PlaceId | null } {
  let reach = walk.valueReaches.get(value);
  if (reach === undefined) walk.valueReaches.set(value, (reach = reachOf(walk, [value], null)));
  for (let at = 0; at + 1 < steps.length; at += 1) reach = below(walk, reach, steps[at]!);
  const last = below(walk, reach, steps.at(-1)!);
  const brought = reach.copies > 0 && last.here === 0 && !last.other;
  return { brought, copy: brought && reach.copies === 1 ? reach.copy : null };
}

/** What a store brings at `path` below its destination's root (`valueReach`), or `null` where it brings nothing there. */
export function storeReach(
  walk: Consumers,
  d: Definition,
  path: readonly string[],
): { readonly brought: boolean; readonly copy: PlaceId | null } | null {
  if (d.value === undefined || d.path.some((step, at) => path[at] !== step)) return null;
  const rest = path.slice(d.path.length);
  if (d.kind === "whole") return rest.length === 0 ? null : valueReach(walk, d.value, rest);
  if (d.kind !== "add" || rest[0] !== "element") return null;
  // (an added list brings its elements; an added element stands one step below)
  if (d.how === "elements") return valueReach(walk, d.value, rest);
  return rest.length < 2 ? null : valueReach(walk, d.value, rest.slice(1));
}

/**
 * Whether a property reaches a place only through copies of whole objects (ADR 0021 rule 1.1, A2): along its path,
 * at each key the stores into it and what the keys above bring there, no literal gives the property itself and no
 * value on the way is of another kind (the stores at the path itself are its direct stores). Each level of a place's
 * paths is made once, so paths that share a prefix share it.
 */
export function copiesOnly(walk: Consumers, root: PlaceId, path: readonly string[]): boolean {
  let level: KeyReach | undefined = walk.keyReaches.get(root);
  if (level === undefined) {
    level = keyLevel(walk, root, [], null);
    walk.keyReaches.set(root, level);
  }
  for (let at = 0; at + 1 < path.length; at += 1) {
    const step = path[at]!;
    let next: KeyReach | undefined = level.next.get(step);
    if (next === undefined) {
      next = keyLevel(walk, root, path.slice(0, at + 1), level);
      level.next.set(step, next);
    }
    level = next;
  }
  const last = below(walk, level.reach, path.at(-1)!);
  return last.here === 0 && !last.other;
}

/** A level of a place's paths: what the level above brings at its step, with the stores into its own key. */
function keyLevel(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
  above: KeyReach | null,
): KeyReach {
  const { program, definitions } = walk.pass;
  const key = keyOf(root, path);
  keepText(program.work, key.length);
  const values: PlaceId[] = [];
  const added: PlaceId[] = [];
  for (const d of definitions.byKey.get(key) ?? []) {
    program.work.charge("checks");
    if (d.value === undefined) continue;
    if (d.kind === "whole" || (d.kind === "add" && d.how === "elements")) values.push(d.value);
    else if (d.kind === "add") added.push(d.value);
  }
  const own = reachOf(walk, values, null, keptArray(program.work, added));
  if (above === null) return { reach: own, key, next: new Map() };
  const from = below(walk, above.reach, path.at(-1)!);
  const literals: PlaceId[] = [];
  for (const literal of from.literals) literals.push(literal);
  for (const literal of own.literals) literals.push(literal);
  keptArray(program.work, literals);
  return {
    reach: {
      literals,
      copies: from.copies + own.copies,
      copy: from.copy ?? own.copy,
      other: from.other || own.other,
      here: from.here + own.here,
      added: own.added,
      next: new Map(),
      children: null,
    },
    key,
    next: new Map(),
  };
}
