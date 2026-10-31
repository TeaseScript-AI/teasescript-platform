import type { PlaceId, TypeTerm } from "../../graph.js";
import { joinParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, keyPath, sortCost } from "../definitions.js";
import type { FlowNode } from "../flow-graph.js";
import { makeItem, REASON, type Item, type Writer } from "../items.js";
import type { Work } from "../solver.js";
import { ingressLeafOf } from "./ingress.js";
import type { Rest } from "./key-ids.js";
import { OPAQUE_MEMBER, propertyOnly, REFERENCE, unknownItem } from "./kinds.js";
import { nodeAt } from "./literal-index.js";
import type {
  LiteralIndex,
  LiteralObject,
  Selection,
  SelectionPiece,
  StoredClass,
} from "./model.js";
import { termAt, typeKinds, writtenOf } from "./terms.js";

// A selection's objects on one side (#1278, #1233): the names a choice object may hold, its pieces, stored classes.

/**
 * #1278: a selection's objects on one side, once per literal, path, selected key and depth: those that select by the
 * key, one of each stored class (`selectionObjects`), each closed where its selected value holds only its names
 * (`heldNames`), indexed by them.
 */
export function selectionOf(
  contract: Contract,
  literal: PlaceId,
  index: LiteralIndex,
  path: number,
  byValue: boolean,
  below: boolean,
  exact: boolean,
): Selection {
  const memoKey = joinParts(literal, path, byValue, below, exact);
  const known = contract.selectionsOf.get(memoKey);
  if (known !== undefined) return known;
  const { program } = contract.pass;
  const objects = selectionObjects(contract, literal, index, path, byValue, below, exact);
  const open: number[] = [];
  const closed: number[] = [];
  const sets = new Map<string, ReadonlySet<string>[]>();
  const holding = new Map<ReadonlySet<string>, number[]>();
  let units = 6 + 3 * objects.length;
  objects.forEach((object, position) => {
    program.work.charge("invSteps");
    const names = heldNames(contract, object);
    if (names === null) {
      open.push(position);
      return;
    }
    closed.push(position);
    const positions = holding.get(names);
    if (positions !== undefined) {
      positions.push(position);
      return;
    }
    holding.set(names, [position]);
    units += 2;
    for (const name of names) {
      program.work.charge("invSteps");
      const list = sets.get(name);
      units += list === undefined ? 2 : 1;
      if (list === undefined) sets.set(name, [names]);
      else list.push(names);
    }
  });
  const selection: Selection = {
    objects,
    open,
    closed,
    sets,
    holding,
    every: objects.map((_, position) => position),
    pieces: new Map(),
  };
  contract.keepText(memoKey.length);
  contract.keep(units);
  contract.selectionsOf.set(memoKey, selection);
  return selection;
}

/**
 * #1278: the parts a selection's read takes at `after`, once per selection and property: where `after` starts with an
 * author's property no test reads (`testedSteps`: a mark at any other such path is the mark at its prefix, §3.2), the
 * objects that may hold it in order (the open ones and those whose names hold it), and between them the runs of closed
 * objects that lack it, each answering there as at `ABSENT`, at any path below; else every object. A read's answer is
 * merged before it is read (each kind once, its earliest writer, kinds in the order they first come), so a run's
 * answers merged at its place leave it unchanged. So k reads of k properties below a choice of k objects each holding
 * its own read one object and a run or two each, never k objects.
 */
export function selectionPieces(
  contract: Contract,
  selection: Selection,
  after: Rest,
): readonly SelectionPiece[] {
  const step = after.length > 0 ? after.at(0) : undefined;
  if (
    step === undefined ||
    selection.closed.length === 0 ||
    !propertyOnly(step) ||
    contract.pass.guards.testedSteps().has(step)
  )
    return selection.every;
  const known = selection.pieces.get(step);
  if (known !== undefined) return known;
  const { program } = contract.pass;
  const holders = selection.sets.get(step) ?? [];
  // (each closed object's names are one set: where the sets holding the property hold every closed object, every
  // object is read)
  let count = 0;
  for (const names of holders) {
    program.work.charge("invSteps");
    count += selection.holding.get(names)!.length;
  }
  if (count === selection.closed.length) {
    contract.keepText(step.length);
    contract.keep(2);
    selection.pieces.set(step, selection.every);
    return selection.every;
  }
  const read = [...selection.open];
  for (const names of holders) read.push(...selection.holding.get(names)!);
  program.work.charge("invSteps", sortCost(read.length));
  read.sort((a, b) => a - b);
  const { closed } = selection;
  const pieces: SelectionPiece[] = [];
  let from = 0;
  for (const position of read) {
    // (the closed objects before the position: a binary search)
    let lo = from;
    let hi = closed.length;
    while (lo < hi) {
      program.work.charge("invSteps");
      const middle = (lo + hi) >> 1;
      if (closed[middle]! < position) lo = middle + 1;
      else hi = middle;
    }
    if (lo > from) pieces.push({ lo: from, hi: lo });
    pieces.push(position);
    from = closed[lo] === position ? lo + 1 : lo;
  }
  if (from < closed.length) pieces.push({ lo: from, hi: closed.length });
  contract.keepText(step.length);
  contract.keep(2 + 2 * pieces.length);
  selection.pieces.set(step, pieces);
  return pieces;
}

/**
 * #1278: the properties a choice object's selected value may hold, such that its answer at any other author's property
 * that no test reads, at any path below, is its answer at `ABSENT` (a property no source holds); `null` where it may
 * hold any. Its cell holds objects of known properties, or reads of unwritten bindings each holding such objects
 * (`bindingNames`): their names. Anything else there (a reference, a computed value, a projection, external data, a
 * kind other than an object) may answer a property by its name. One set per source, shared by the cells that hold it
 * alone; once per cell.
 */
function heldNames(contract: Contract, object: LiteralObject): ReadonlySet<string> | null {
  const { selected } = object;
  if (selected === null || selected.type.kind !== "ref") return null;
  const cell = selected.type.place;
  const known = contract.heldNamesOf.get(cell);
  if (known !== undefined) return known;
  contract.heldNamesOf.set(cell, null);
  const index = contract.literalIndex(cell);
  const sources = new Set<ReadonlySet<string>>();
  const own = literalNames(contract, index);
  if (own === null) return null;
  if (own.size > 0 || (index.root.objects?.list.length ?? 0) > 0) addSource(contract, sources, own);
  for (const entry of [...index.root.reads, ...index.root.exact]) {
    contract.pass.program.work.charge("invSteps");
    const names = bindingNames(contract, entry.value);
    if (names === null) return null;
    addSource(contract, sources, names);
  }
  if (sources.size === 0) return null;
  const names = unionOf(contract, sources);
  contract.heldNamesOf.set(cell, names);
  return names;
}

/**
 * The names a read of a binding holds (`heldNames`): a `let` or `global` without a written type, no element added in a
 * loop, whose live definitions are all objects of known properties, with the first step of each store below it (a
 * property store; any other step: `null`); `null` for any other read (a projection, external data, a host global, a
 * parameter). Once per binding.
 */
function bindingNames(contract: Contract, value: PlaceId): ReadonlySet<string> | null {
  const { program, definitions, lists } = contract.pass;
  const binding = program.occurrenceOf.get(value);
  if (binding === undefined || definitions.ingress.has(value) || program.isHost(binding))
    return null;
  const known = contract.bindingNamesOf.get(binding);
  if (known !== undefined) return known;
  contract.bindingNamesOf.set(binding, null);
  const kind = program.place(binding).kind;
  if (kind.kind !== "binding" || writtenOf(kind) !== null) return null;
  const key = keyOf(binding, []);
  if ((definitions.loopAdds.get(key)?.length ?? 0) > 0) return null;
  const sources = new Set<ReadonlySet<string>>();
  for (const d of definitions.byKey.get(key) ?? []) {
    program.work.charge("invSteps");
    if (!lists.live(d)) continue;
    if (d.kind !== "whole" || d.value === undefined || !program.hasOf.has(d.value)) return null;
    const literal = contract.literalIndex(d.value);
    const names = literalNames(contract, literal);
    if (names === null || (literal.root.objects?.list.length ?? 0) === 0) return null;
    addSource(contract, sources, names);
  }
  if (sources.size === 0) return null;
  const stored = new Set<string>();
  for (const below of definitions.keysBelow(key)) {
    program.work.charge("invSteps");
    const step = keyPath(below)[0]!;
    if (!propertyOnly(step)) return null;
    if (stored.has(step)) continue;
    contract.keepText(step.length);
    stored.add(step);
  }
  if (stored.size > 0) addSource(contract, sources, stored);
  const names = unionOf(contract, sources);
  contract.bindingNamesOf.set(binding, names);
  return names;
}

/**
 * The names a literal's index holds at its root (`heldNames`): its objects' there, each of known properties, where
 * nothing but objects stands (no read, no computed value, no reference, no other kind); else `null`.
 */
function literalNames(contract: Contract, index: LiteralIndex): ReadonlySet<string> | null {
  const { root } = index;
  if (root.reference || root.others.length > 0) return null;
  for (const [tag] of root.terms) if (tag !== "object") return null;
  const sources = new Set<ReadonlySet<string>>();
  for (const object of root.objects?.list ?? []) {
    contract.pass.program.work.charge("invSteps");
    if (object.term.properties === null) return null;
    addSource(contract, sources, object.names);
  }
  return unionOf(contract, sources);
}

/**
 * A name set's source added once (#1278): by its identity, in order, its membership charged as kept, so one binding of
 * k definitions or a holder of k references adds each in constant time.
 */
export function addSource(
  contract: Contract,
  sources: Set<ReadonlySet<string>>,
  names: ReadonlySet<string>,
): void {
  if (sources.has(names)) return;
  contract.keep(1);
  sources.add(names);
}

/** The union of name sets: the one set itself where there is one, else a new set, charged. */
export function unionOf(
  contract: Contract,
  sources: ReadonlySet<ReadonlySet<string>>,
): ReadonlySet<string> {
  if (sources.size === 1) return sources.values().next().value!;
  const union = new Set<string>();
  for (const names of sources)
    for (const name of names) {
      contract.pass.program.work.charge("invSteps");
      if (union.has(name)) continue;
      contract.keep(1);
      union.add(name);
    }
  return union;
}

/**
 * The objects a selection reads on one side (#1233, #1291), once per literal, path, selected key, depth and side: those
 * that select by the key, each left out whose contribution at every path an earlier one's holds. An answer is merged
 * before it is read (each kind once, its earliest writer, kinds in the order they first come), so of the objects whose
 * selected properties store one value on the side (`storedClass`) one counts, the earliest: its span ends before the
 * others' start, so each writer of its answer from inside its option comes first, and the rest (a missing property's)
 * are the class's own, alike in each. So do the objects with unknown keys and those with neither key.
 * So k questions below a choice of k objects storing one value read one object each, not k.
 */
function selectionObjects(
  contract: Contract,
  literal: PlaceId,
  index: LiteralIndex,
  path: number,
  byValue: boolean,
  below: boolean,
  exact: boolean,
): readonly LiteralObject[] {
  const memoKey = joinParts(literal, path, byValue, below, exact);
  const known = contract.selections.get(memoKey);
  if (known !== undefined) return known;
  const { program } = contract.pass;
  const kept: LiteralObject[] = [];
  // Per class, the kept option whose span ends first; class-common writers may lie outside it.
  const firsts = new Map<string, Writer | null>();
  for (const object of nodeAt(contract, index, path)?.objects?.list ?? []) {
    program.work.charge("invSteps");
    const { selected } = object;
    if (object.term.properties === null ? !byValue : (selected?.name === "value") !== byValue)
      continue;
    let alike: readonly [string, Writer | null] | null = null;
    if (object.term.properties === null) alike = ["o", null];
    else if (selected === null) alike = [joinParts("m", object.token.file), object.token];
    else if (selected.type.kind === "ref") {
      const stored = storedClass(contract, selected.type.place, exact);
      const { token } = object;
      if (
        stored !== null &&
        (stored.end < stored.start ||
          (stored.file === token.file && stored.start >= token.start && stored.end <= token.end))
      )
        alike = [joinParts("h", token.file, stored.name), token];
    }
    if (alike !== null) {
      const [key, writer] = alike;
      const first = firsts.get(key);
      if (first !== undefined && (writer === null || first!.end <= writer.start)) continue;
      if (first === undefined || (writer !== null && writer.end < first!.end))
        firsts.set(key, writer);
    }
    kept.push(object);
  }
  contract.keepText(memoKey.length);
  contract.keep(1 + kept.length);
  contract.selections.set(memoKey, kept);
  return kept;
}

/**
 * #1233: what a cell stores, as a class: two cells of one class answer every question of the side below them alike
 * but for the writers inside them, which lie inside the extent kept with the class; the others (a missing property's,
 * which keeps its source's) are the class's own, alike in both. The rule: a cell stores the sequence of its
 * live definitions' values; a read stores its read class on the side (`readClass`: its source resolved through
 * unchanged whole copies, its own steps, the guards that hold it at and below its path; on the value side, #1291, its
 * snapshot and its narrowing too) and whether its identity is guarded; an inline
 * literal stores its structure (an object its properties in order, each its cell's class; a list, set or dict its
 * element cell's; a kind its name); a computed value, external data, a reference kind, an object of unknown properties
 * and a written property type store no class. So a store into a copy makes it no alias (its own read class), a guard
 * holding a read is part of its class, and an ingress gives none. Once per cell, each class named by a short name, so
 * wrappers k deep cost k.
 */
function storedClass(contract: Contract, cell: PlaceId, exact: boolean): StoredClass | null {
  const classes = contract.storedClasses[exact ? 1 : 0]!;
  const known = classes.get(cell);
  if (known !== undefined) return known;
  // (a cell its own literal holds has no class)
  classes.set(cell, null);
  const { program, definitions, lists } = contract.pass;
  let file = -1;
  let start = Infinity;
  let end = -Infinity;
  const take = (at: {
    readonly file: number;
    readonly start: number;
    readonly end: number;
  }): boolean => {
    if (at.end < at.start) return true;
    if (file !== -1 && at.file !== file) return false;
    file = at.file;
    start = Math.min(start, at.start);
    end = Math.max(end, at.end);
    return true;
  };
  const term = (type: TypeTerm): string | null => {
    program.work.charge("invSteps");
    if (type.kind === "ref") {
      const inner = storedClass(contract, type.place, exact);
      return inner !== null && take(inner) ? inner.name : null;
    }
    if (type.kind === "list" || type.kind === "set" || type.kind === "dict") {
      const element = term(type.element);
      return element === null ? null : `${type.kind}[${element}]`;
    }
    if (type.kind === "atom") return REFERENCE.has(type.name) ? null : type.name;
    if (type.kind !== "object" || type.properties === null) return null;
    const parts: string[] = [];
    for (const property of type.properties) {
      const inner = term(property.type);
      if (inner === null) return null;
      parts.push(`${property.name}:${inner}`);
    }
    return `{${parts.join(",")}}`;
  };
  const value = (stored: PlaceId): string | null => {
    const literals = program.hasOf.get(stored) ?? [];
    if (literals.length > 0) {
      const parts: string[] = [];
      for (const has of literals) {
        const inner = take(has.site) ? term(has.type) : null;
        if (inner === null) return null;
        parts.push(inner);
      }
      return `l(${parts.join("&")})`;
    }
    if (contract.copiedKey(stored) === null || ingressLeafOf(contract, stored) !== undefined)
      return null;
    const read = contract.readClass(stored, exact);
    return read === null ? null : `r${contract.identityOf(stored).guarded ? "g" : ""}(${read})`;
  };
  const parts: string[] = [];
  for (const d of definitions.cellDefs.get(cell) ?? []) {
    program.work.charge("invSteps");
    if (!lists.live(d)) continue;
    const stored =
      d.value !== undefined && definitions.writerOf(d) !== null && take(d.site)
        ? value(d.value)
        : null;
    if (stored === null) return null;
    parts.push(stored);
  }
  const text = parts.join(";");
  let name = contract.storedNames.get(text);
  if (name === undefined) {
    contract.keepText(text.length);
    contract.storedNames.set(text, (name = `s${contract.storedNames.size}`));
  }
  const found: StoredClass = { name, file, start, end };
  contract.keep(2);
  classes.set(cell, found);
  return found;
}

/** One object's contribution to a selection (`selectedAt`): its selected key's items at `after`, or none. */
export function* selectedObject(
  contract: Contract,
  object: LiteralObject,
  byValue: boolean,
  after: Rest,
  node: FlowNode | null,
  exact: boolean,
  below: boolean,
): Work<readonly Item[]> {
  contract.pass.program.work.charge("invSteps");
  contract.facts.selectionVisits += 1;
  const { selected } = object;
  if (object.term.properties === null ? !byValue : (selected?.name === "value") !== byValue)
    return [];
  if (object.term.properties === null) return [exact ? OPAQUE_MEMBER : unknownItem(REASON.opaque)];
  if (selected === null)
    return [
      exact
        ? makeItem("unknown", object.token, { reasons: REASON.missing, context: "missing" })
        : unknownItem(REASON.missing, object.token),
    ];
  // (one by one: a selected property's items grow with its literal, past one call's arguments)
  if (selected.type.kind === "ref")
    return yield* contract.indexItems(selected.type.place, after, node, exact, below);
  const at = termAt(selected.type, after);
  return at === null ? [] : typeKinds(at).map((tag) => makeItem(tag, object.token));
}
