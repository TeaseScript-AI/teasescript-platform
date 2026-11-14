import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import { keep, keepText } from "../budget.js";
import { isKeyId, type Rest } from "../contract/key-ids.js";
import { propertyOnly } from "../contract/kinds.js";
import { closedObject } from "../contract/levels.js";
import { marksNothing } from "../contract/marks.js";
import type { PrefixEntry, PrefixStores } from "../contract/model.js";
import { writtenOf } from "../contract.js";
import { keyOf, keyPath, keyPlace, type Definition, type Key } from "../definitions.js";
import { REASON, type Item } from "../items.js";
import type { Stop } from "./model.js";
import { stopsOf } from "./walk.js";

// #2065 (#2059, #1585): a prefix's contributions by the first step of a decided path they can hold.

/**
 * A part of what a contribution can hold below its prefix: a closed literal's names (one set per literal, shared by
 * every contribution it reaches) or one first step.
 */
type Part = ReadonlySet<string> | string;

/**
 * A list's positions by the first step their contribution can hold there, and the positions of those unproved: per
 * step, the positions of each part holding it, so a literal's names are indexed once however many contributions it
 * reaches (each list in order; a contribution two of whose parts hold a step is in two). A step's items are made at
 * its first query and kept for the snapshot (`selected`): each position list's items once, and a step that more than
 * one list holds merged once, all within `budget`, what is left of the index's own construction's charges.
 */
interface StepPositions<T> {
  readonly list: readonly T[];
  readonly steps: ReadonlyMap<string, readonly (readonly number[])[]>;
  /** Per step, its lists' positions counted (with duplicates), made with the index. */
  readonly sizes: ReadonlyMap<string, number>;
  readonly any: readonly number[];
  readonly items: Map<readonly number[], readonly T[]>;
  readonly selections: Map<string, readonly T[] | null>;
  budget: number;
}

/**
 * #2065: a prefix's contributions to the decisions of paths below it, once per admission's settled snapshot of them:
 * its whole stores as the decider's scan lists them and its settled stores as the candidates' offending scan reads
 * them, each indexed by the first steps it can hold, built only where the reads it saves pay for it (`holdersOf`).
 */
export interface PrefixHolders {
  list: readonly Definition[] | null;
  stores: PrefixStores | null;
  /** The reads the walks made that held nothing at their paths, until the holding count. */
  wasted: number;
  /** Per settled store, its literal's names (`entrySupport`, `null` unproved); `null` before the holding count. */
  supports: readonly (ReadonlySet<string> | null)[] | null;
  /** Per name, the settled stores that may hold it, and the unproved ones. */
  holding: Map<string, number> | null;
  unproved: number;
  /** The names of the settled stores' distinct literals, and the stores each store brought (`PrefixEntry.ds`). */
  names: number;
  brought: number;
  /** Twice the reads the walks since the holding count would have saved, against twice the index's construction. */
  saved: number;
  cost: number;
  /** Whether the whole stores' construction is in `cost`, once their list is known. */
  costsWhole: boolean;
  /** The settled stores' positions and the whole stores', each made once paid for. */
  entries: StepPositions<PrefixEntry> | null;
  whole: StepPositions<Definition> | null;
}

/** A path's first step where the index can select by it: an ordinary property, its name holding no `.` (`null` else). */
function firstStep(rest: Rest): string | null {
  if (rest.length === 0) return null;
  const step = rest.at(0)!;
  return propertyOnly(step) && !step.includes(".") ? step : null;
}

/**
 * The prefix's state for a decided path's walk below it, `null` where the index selects nothing: a path whose first
 * step is no ordinary property, or a prefix of fewer than three contributions (a walk of two saves at most one read). A
 * state made for another snapshot of the whole stores or the settled stores is made again. The pay rule, as #1456's
 * builds the property index (#1948's form): once the walks' reads that held nothing at their paths reach twice the
 * contributions, each name's holders among the settled stores are counted (`countHolding`); from then on each walk adds
 * the reads its path's first step would have saved, the stores without it: half of them for the decider's scan, which
 * stops at its decider (in source order, at about half), all for the candidates' offending scan, which reads every
 * store. Each index is made once those reach the construction's charges (`entriesCost`, `wholeCost`). Until its holding
 * count a prefix's state is kept uncharged, as the property index's read count is (`PrefixLevels.reads`, #1456): a
 * prefix that never reaches its holding count is charged exactly what it would be without the index, so its index
 * charges move no stop. From the holding count on, its units are kept and each walk's lookup is charged, whether or not
 * its index is then made.
 */
function holdersOf(
  admission: Admission,
  prefix: Key,
  rest: Rest,
  list: readonly Definition[] | null,
  stores: PrefixStores | null,
): PrefixHolders | null {
  const step = firstStep(rest);
  if (step === null) return null;
  const size = list?.length ?? stores!.list.length;
  if (size < 3) return null;
  const { contract, receivingDomain: domain, program } = admission.pass;
  const work = program.work;
  let state = domain.holders.get(prefix);
  if (
    state === undefined ||
    (list !== null && state.list !== null && state.list !== list) ||
    (stores !== null && state.stores !== null && state.stores !== stores)
  ) {
    domain.holders.set(
      prefix,
      (state = {
        list: null,
        stores: null,
        wasted: 0,
        supports: null,
        holding: null,
        unproved: 0,
        names: 0,
        brought: 0,
        saved: 0,
        cost: 0,
        costsWhole: false,
        entries: null,
        whole: null,
      }),
    );
  }
  state.list ??= list;
  state.stores ??= stores;
  if (state.supports === null) {
    const count = (state.list?.length ?? 0) + (state.stores?.list.length ?? 0);
    if (state.wasted < 2 * count) return state;
    keepText(admission.work, prefix.length);
    keep(admission.work, 6);
    countHolding(admission, (state.stores ??= contract.prefixStores(prefix)), state);
  }
  work.charge("checks");
  if (state.entries !== null && (state.list === null || state.whole !== null)) return state;
  if (state.list !== null && !state.costsWhole) {
    state.costsWhole = true;
    state.cost += 2 * wholeCost(admission, state);
  }
  const entries = state.stores!.list.length;
  const lacking = entries - (state.holding!.get(step) ?? 0) - state.unproved;
  state.saved += list !== null ? lacking : 2 * lacking;
  if (state.saved >= state.cost) {
    state.entries ??= positions(
      admission,
      state.stores!.list,
      state.supports!.map((own) => (own === null ? null : [own])),
    );
    if (state.list !== null) state.whole = wholePositions(admission, state);
  }
  return state;
}

/**
 * The holding count: per settled store, its literal's names (`entrySupport`), and per name of each distinct literal,
 * the stores holding it (a literal several stores share counted once); then the settled stores' index's cost.
 */
function countHolding(admission: Admission, stores: PrefixStores, state: PrefixHolders): void {
  const work = admission.pass.program.work;
  const shared = new Map<ReadonlySet<string>, number>();
  state.supports = stores.list.map((entry) => {
    work.charge("indexSteps");
    state.brought += entry.ds.size;
    const own = entrySupport(admission, entry);
    if (own === null) state.unproved += 1;
    else shared.set(own, (shared.get(own) ?? 0) + 1);
    return own;
  });
  keep(admission.work, stores.list.length);
  const holding = new Map<string, number>();
  for (const [names, count] of shared)
    for (const name of names) {
      work.charge("indexSteps");
      state.names += 1;
      const known = holding.get(name);
      if (known === undefined) keep(admission.work, 1);
      holding.set(name, (known ?? 0) + count);
    }
  state.holding = holding;
  state.cost = 2 * entriesCost(stores.list.length, state.names);
}

/** The settled stores' index's charges (`positions`): each store, its literal's part, each distinct literal's name. */
function entriesCost(entries: number, names: number): number {
  return 2 * entries + names;
}

/**
 * The whole stores' index's charges (`wholePositions`, `positions`), each charged once its list is known: the stores
 * each settled store brought, read once to sort them and once by their stores, and once more as their classes' parts;
 * each class, three times; each member; and each name of the distinct literals. Beyond this the construction reads each
 * member's stops (`stopsOf`, once an admission, which the decider's own walk shares) and indexes the steps they add.
 */
function wholeCost(admission: Admission, state: PrefixHolders): number {
  const work = admission.pass.program.work;
  let members = 0;
  for (const representative of state.list!) {
    work.charge("indexSteps");
    members += admission.members.get(representative)?.length ?? 0;
  }
  return 3 * state.brought + 3 * state.list!.length + members + state.names;
}

/** Whether a contribution's items at a path hold nothing there: none, or a `missing` property alone. */
export function holdsNothing(items: readonly Item[]): boolean {
  return items.every((item) => item.tag === "unknown" && item.reasons === REASON.missing);
}

/**
 * The prefix's whole stores a decided path's scan reads (`eligibleOf`), where the index is made: those that may hold
 * the path's first step and those unproved, in their order; `null` where the walk takes every one.
 */
export function wholeHolding(
  admission: Admission,
  prefix: Key,
  rest: Rest,
  list: readonly Definition[],
): readonly Definition[] | null {
  const state = holdersOf(admission, prefix, rest, list, null);
  if (state?.whole == null) return null;
  return selected(admission, state.whole, firstStep(rest)!);
}

/** The prefix's settled stores a decided path's offending scan reads (`decide`), as `wholeHolding` selects. */
export function entriesHolding(
  admission: Admission,
  prefix: Key,
  rest: Rest,
  stores: PrefixStores,
): readonly PrefixEntry[] | null {
  const state = holdersOf(admission, prefix, rest, null, stores);
  if (state?.entries == null) return null;
  return selected(admission, state.entries, firstStep(rest)!);
}

/**
 * A list's items at the positions of the parts holding the step and the unproved ones, in the list's order and each
 * once, made at the step's first query and kept (the walks' later queries cost their lookup alone): one list's items,
 * made once for every step it alone holds, or the lists merged, each position each round charged, then their items;
 * `null`, the whole list, where no store can be left out or the index's budget does not cover them. A new step costs
 * one charge to judge (its lists' sizes counted with the index, `sizes`), so what the selections make and keep is at
 * most the index's construction again and one a step.
 */
function selected<T>(
  admission: Admission,
  index: StepPositions<T>,
  step: string,
): readonly T[] | null {
  const known = index.selections.get(step);
  if (known !== undefined) return known;
  const work = admission.pass.program.work;
  work.charge("indexSteps");
  const parts = index.steps.get(step) ?? [];
  const lists = parts.length + (index.any.length === 0 ? 0 : 1);
  // (the one list, where one holds the step)
  const first = parts[0] ?? index.any;
  let found: readonly T[] | null = lists === 0 ? [] : null;
  const single = lists === 1 ? index.items.get(first) : undefined;
  if (single !== undefined) found = single;
  else if (lists > 0) {
    const size = (index.sizes.get(step) ?? 0) + index.any.length;
    const cost = size * (lists === 1 ? 1 : Math.ceil(Math.log2(lists)) + 1);
    if (size < index.list.length && cost <= index.budget) {
      index.budget -= cost;
      const at =
        lists === 1
          ? first
          : merged(admission, index.any.length === 0 ? parts : [...parts, index.any]);
      work.charge("indexSteps", at.length);
      keep(admission.work, at.length);
      found = at.map((position) => index.list[position]!);
      if (lists === 1) index.items.set(first, found);
    }
  }
  keep(admission.work, 1);
  index.selections.set(step, found);
  return found;
}

/**
 * Ordered position lists merged in pairs, each round a linear pass over what is left (as many rounds as the log2 of
 * the lists' count, rounded up), every position each round charged; a position in two lists is kept once.
 */
function merged(admission: Admission, lists: readonly (readonly number[])[]): readonly number[] {
  const work = admission.pass.program.work;
  let round = lists;
  while (round.length > 1) {
    const next: (readonly number[])[] = [];
    for (let i = 0; i < round.length; i += 2) {
      const [x, y] = [round[i]!, round[i + 1] ?? []];
      work.charge("indexSteps", x.length + y.length);
      const out: number[] = [];
      for (let a = 0, b = 0; a < x.length || b < y.length;) {
        const taken = b >= y.length || (a < x.length && x[a]! <= y[b]!) ? x[a++]! : y[b++]!;
        if (out.at(-1) !== taken) out.push(taken);
      }
      next.push(out);
    }
    round = next;
  }
  return round[0] ?? [];
}

/**
 * The index of a prefix's whole stores (`wholeOf`'s classes), each charged: each store's parts from the settled stores
 * it brought (read once, by `PrefixEntry.ds`), then per class, its members' parts (`supportOf`), each class under each.
 */
function wholePositions(admission: Admission, state: PrefixHolders): StepPositions<Definition> {
  const work = admission.pass.program.work;
  const stores = state.stores!;
  // (each whole store's literals from the settled stores it brought; `null` where one is unproved)
  const brought = new Map<Definition, Set<Part> | null>();
  for (const [at, entry] of stores.list.entries()) {
    const own = state.supports![at]!;
    for (const d of entry.ds) {
      work.charge("indexSteps");
      if (d === null) continue;
      const parts = brought.get(d);
      if (parts === null) continue;
      if (own === null) brought.set(d, null);
      else if (parts === undefined) {
        keep(admission.work, 2);
        brought.set(d, new Set([own]));
      } else if (!parts.has(own)) {
        keep(admission.work, 1);
        parts.add(own);
      }
    }
  }
  // (the stores that bring a layer of a source's own stores below its root, which adds what no entry shows)
  const layered = new Set<Definition | null>(stores.inheritedBy);
  for (const { defs } of stores.also) for (const d of defs) layered.add(d);
  return positions(
    admission,
    state.list!,
    state.list!.map((representative) => {
      work.charge("indexSteps");
      const parts = new Set<Part>();
      for (const d of [representative, ...(admission.members.get(representative) ?? [])])
        if (!supportOf(admission, d, brought, layered, parts)) return null;
      return parts;
    }),
  );
}

/**
 * A settled store's names, where its value is a closed object literal stored whole whose holder marks nothing
 * (`closedObject`, `marksNothing`): at a path below a property it lacks, its read is a `missing` property alone; `null`
 * for any other store, which the index takes for every step.
 */
function entrySupport(admission: Admission, entry: PrefixEntry): ReadonlySet<string> | null {
  const { contract } = admission.pass;
  if (!closedObject(contract, entry) || !marksNothing(contract, entry.holder)) return null;
  return contract.literalIndex(entry.value!).root.objects!.list[0]!.names;
}

/**
 * #2065: adds to `parts` what a whole store can hold below its prefix, both parts proved: its value's, the literals of
 * the settled stores it brought, each closed (`entrySupport`), with no layer of its source's own stores below their
 * root; and its written part's, from its own stops (`stopsOf`): a copy of a written binding or a value no literal holds
 * stands at its path's first step, and at the root it may answer every path. `false` (every step) for any other store:
 * not an initializer or an assignment, bringing no settled store or an unproved one, or with a written or unproved
 * value at its root.
 */
function supportOf(
  admission: Admission,
  d: Definition,
  brought: ReadonlyMap<Definition, ReadonlySet<Part> | null>,
  layered: ReadonlySet<Definition | null>,
  parts: Set<Part>,
): boolean {
  const work = admission.pass.program.work;
  work.charge("indexSteps");
  if (d.kind !== "whole" || (d.how !== "initializer" && d.how !== "assignment")) return false;
  if (d.value === undefined || layered.has(d)) return false;
  const own = brought.get(d);
  if (own == null) return false;
  for (const part of own) {
    work.charge("indexSteps");
    parts.add(part);
  }
  const stops = stopsOf(admission, d.value, d.node);
  for (const [inherits, map] of [
    [true, stops.written],
    [false, stops.values],
  ] as const)
    for (const [text, list] of map) {
      work.charge("indexSteps");
      if (text !== "") parts.add(text.split(".", 1)[0]!);
      else
        for (const stop of list) {
          const source = copySupport(admission, stop, inherits);
          if (source === null) return false;
          parts.add(source);
        }
    }
  return true;
}

/**
 * The first steps a stop at a value's root can bring an answer to, where it is a whole copy of an unwritten place,
 * through no operation, the place's one settled store a closed object literal (`entrySupport`) that only its own stores
 * of that literal brought, with no layer below its root: that literal's names. These are `sourceSteps`' exclusions (no
 * copy into the place, no cycle or forwarding, no deeper store). `inherits`: the copy's inherited written type
 * (`inheritedInto`), which the place's stores decide, its literal's written parts standing below its own properties;
 * else the copy's value (a read of the place, `Contract.copiedKey`), the place's contract, its literal's. `null` for any
 * other stop, unproved.
 */
function copySupport(
  admission: Admission,
  stop: Stop,
  inherits: boolean,
): ReadonlySet<string> | null {
  const { contract, program } = admission.pass;
  program.work.charge("indexSteps");
  if (stop.strip.length > 0 || stop.via !== null) return null;
  let place: PlaceId;
  if (inherits) {
    if (stop.term !== null || stop.from === null) return null;
    place = stop.from;
  } else {
    const key = contract.copiedKey(stop.value);
    if (key === null || isKeyId(key) || keyPath(key).length > 0) return null;
    if (contract.ingressOf(stop.value) !== null) return null;
    place = keyPlace(key);
  }
  if (writtenOf(program.place(place).kind) !== null) return null;
  const source = contract.prefixStores(keyOf(place, []));
  if (source.list.length !== 1 || source.subs !== null || source.also.length > 0) return null;
  const entry = source.list[0]!;
  // (no copy into the place, so no cycle or forwarding through it: each store that brought its literal stores it)
  for (const d of entry.ds) {
    program.work.charge("indexSteps");
    if (d === null || d.value !== entry.value) return null;
  }
  return entrySupport(admission, entry);
}

/**
 * A list's positions by the parts each holds (`null`: every step), then each part's positions under each step it
 * holds, every position, posting and name charged and kept.
 */
function positions<T>(
  admission: Admission,
  list: readonly T[],
  supports: readonly (Iterable<Part> | null)[],
): StepPositions<T> {
  const work = admission.pass.program.work;
  const byPart = new Map<Part, number[]>();
  const any: number[] = [];
  let kept = 0;
  for (const [at, parts] of supports.entries()) {
    work.charge("indexSteps");
    if (parts === null) {
      any.push(at);
      continue;
    }
    for (const part of parts) {
      work.charge("indexSteps");
      kept += 1;
      const list = byPart.get(part);
      if (list === undefined) byPart.set(part, [at]);
      else list.push(at);
    }
  }
  const steps = new Map<string, (readonly number[])[]>();
  const sizes = new Map<string, number>();
  for (const [part, list] of byPart)
    for (const name of typeof part === "string" ? [part] : part) {
      work.charge("indexSteps");
      kept += 1;
      const known = steps.get(name);
      if (known === undefined) {
        keepText(admission.work, name.length);
        steps.set(name, [list]);
      } else known.push(list);
      sizes.set(name, (sizes.get(name) ?? 0) + list.length);
    }
  keep(admission.work, any.length + kept + sizes.size);
  // (the selections' budget: this construction's charges, one a position and one a part or name it posts)
  return {
    list,
    steps,
    sizes,
    any,
    items: new Map(),
    selections: new Map(),
    budget: supports.length + kept,
  };
}
