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

/** A list's positions by the first step their contribution can hold there, and the positions of those unproved. */
interface StepPositions {
  readonly steps: ReadonlyMap<string, readonly number[]>;
  readonly any: readonly number[];
}

/**
 * #2065: a prefix's contributions to the decisions of paths below it, once per admission's settled snapshot of them
 * (`ReceivingDomain.holders`, cleared by its `reset()`): its whole stores as A2's scan lists them (`wholeOf`) and its
 * settled stores as A5's offending scan reads them (`PrefixStores.list`), each indexed by the first steps it can hold
 * (`supportOf`), built only where the reads it saves pay for it (`holdersOf`).
 */
export interface PrefixHolders {
  list: readonly Definition[] | null;
  stores: PrefixStores | null;
  /** The reads the walks made that held nothing at their paths, until the holding count. */
  wasted: number;
  /** Per name, the settled stores that may hold it, and the unproved ones; `null` before the holding count. */
  holding: Map<string, number> | null;
  unproved: number;
  /** Twice the reads the walks since the holding count would have saved, against twice the index's construction. */
  saved: number;
  cost: number;
  /** The settled stores' positions, the index made; and the whole stores', made once their list is known too. */
  entries: StepPositions | null;
  whole: StepPositions | null;
  /** Per settled store, the names it holds (`entrySupport`), kept for the whole stores' positions. */
  supports: readonly (ReadonlySet<string> | null)[] | null;
}

/** A path's first step where the index can select by it: an ordinary property, its name holding no `.` (`null` else). */
function firstStep(rest: Rest): string | null {
  if (rest.length === 0) return null;
  const step = rest.at(0)!;
  return propertyOnly(step) && !step.includes(".") ? step : null;
}

/**
 * The prefix's state for a decided path's walk below it, `null` where the index selects nothing: a path whose first
 * step is no ordinary property, or a prefix of fewer than three contributions (a walk of two saves at most one read).
 * A state made for another snapshot of the whole stores or the settled stores is made again. The pay rule, as #1456's
 * builds the property index (#1948's form): once the walks' reads that held nothing at their paths reach twice the
 * contributions, each name's holders among the settled stores are counted (`entrySupport`, each charged); from then on
 * each walk adds the reads its path's first step would have saved, the stores without it: half of them for A2's scan,
 * which stops at its decider (in source order, at about half), all for A5's offending scan, which reads every store;
 * the index is made (`indexEntries`) once those reach its construction, the contributions and their names.
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
  work.charge("checks");
  let state = domain.holders.get(prefix);
  if (
    state === undefined ||
    (list !== null && state.list !== null && state.list !== list) ||
    (stores !== null && state.stores !== null && state.stores !== stores)
  ) {
    keepText(admission.work, prefix.length);
    keep(admission.work, 6);
    domain.holders.set(
      prefix,
      (state = {
        list: null,
        stores: null,
        wasted: 0,
        holding: null,
        unproved: 0,
        saved: 0,
        cost: 0,
        entries: null,
        whole: null,
        supports: null,
      }),
    );
  }
  state.list ??= list;
  state.stores ??= stores;
  if (state.entries !== null) {
    if (state.whole === null && state.list !== null) wholePositions(admission, state);
    return state;
  }
  const count = (state.list?.length ?? 0) + (state.stores?.list.length ?? 0);
  if (state.holding === null) {
    if (state.wasted < 2 * count) return state;
    const settled = (state.stores ??= contract.prefixStores(prefix));
    const holding = new Map<string, number>();
    let names = 0;
    for (const entry of settled.list) {
      work.charge("indexSteps");
      const own = entrySupport(admission, entry);
      if (own === null) {
        state.unproved += 1;
        continue;
      }
      for (const name of own) {
        work.charge("indexSteps");
        names += 1;
        const known = holding.get(name);
        if (known === undefined) keep(admission.work, 1);
        holding.set(name, (known ?? 0) + 1);
      }
    }
    state.holding = holding;
    state.cost = 2 * ((state.list?.length ?? settled.list.length) + settled.list.length + names);
  }
  const entries = state.stores!.list.length;
  const lacking = entries - (state.holding.get(step) ?? 0) - state.unproved;
  state.saved += list !== null ? lacking : 2 * lacking;
  if (state.saved >= state.cost) {
    indexEntries(admission, prefix, state);
    if (state.list !== null) wholePositions(admission, state);
  }
  return state;
}

/** Whether a contribution's items at a path hold nothing there: none, or F11's `missing` alone. */
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
  return selected(admission, state.whole, firstStep(rest)!, list);
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
  return selected(admission, state.entries, firstStep(rest)!, stores.list);
}

/** A list's items at the step's positions and the unproved ones, merged in the list's order, each charged. */
function selected<T>(
  admission: Admission,
  index: StepPositions,
  step: string,
  list: readonly T[],
): T[] {
  const along = index.steps.get(step) ?? [];
  const any = index.any;
  admission.pass.program.work.charge("checks", along.length + any.length);
  keep(admission.work, along.length + any.length);
  const out: T[] = [];
  for (let i = 0, j = 0; i < along.length || j < any.length;)
    out.push(
      list[j >= any.length || (i < along.length && along[i]! < any[j]!) ? along[i++]! : any[j++]!]!,
    );
  return out;
}

/**
 * The index of a prefix's settled stores (`PrefixHolders`), each charged as it is made: per store, the names its value
 * holds (`entrySupport`), each a position under each name.
 */
function indexEntries(admission: Admission, prefix: Key, state: PrefixHolders): void {
  const work = admission.pass.program.work;
  const stores = (state.stores ??= admission.pass.contract.prefixStores(prefix));
  const supports = stores.list.map((entry) => {
    work.charge("indexSteps");
    return entrySupport(admission, entry);
  });
  state.supports = supports;
  state.entries = positions(admission, supports);
}

/**
 * The index of a prefix's whole stores (`wholeOf`'s classes), once the settled stores' is made and the list is known,
 * each charged: per class, its members' names (`supportOf`), each a position under each name.
 */
function wholePositions(admission: Admission, state: PrefixHolders): void {
  const work = admission.pass.program.work;
  const stores = state.stores!;
  // (each whole store's settled stores, by the stores that brought them)
  const brought = new Map<Definition, number[]>();
  for (const [at, entry] of stores.list.entries())
    for (const d of entry.ds) {
      work.charge("indexSteps");
      if (d === null) continue;
      const list = brought.get(d);
      if (list === undefined) {
        keep(admission.work, 2);
        brought.set(d, [at]);
      } else list.push(at);
    }
  // (the stores that bring a layer of a source's own stores below its root, which adds what no entry shows)
  const layered = new Set<Definition | null>(stores.inheritedBy);
  for (const { defs } of stores.also) for (const d of defs) layered.add(d);
  state.whole = positions(
    admission,
    state.list!.map((representative) => {
      const names = new Set<string>();
      for (const d of [representative, ...(admission.members.get(representative) ?? [])]) {
        const own = supportOf(admission, d, brought, state.supports!, layered);
        if (own === null) return null;
        for (const name of own) names.add(name);
      }
      return names;
    }),
  );
}

/**
 * A settled store's names, where its value is a closed object literal stored whole whose holder marks nothing
 * (`closedObject`, `marksNothing`): at a path below a property it lacks, its read is F11's `missing` alone; `null` for
 * any other store, which the index takes for every step.
 */
function entrySupport(admission: Admission, entry: PrefixEntry): ReadonlySet<string> | null {
  const { contract } = admission.pass;
  if (!closedObject(contract, entry) || !marksNothing(contract, entry.holder)) return null;
  return contract.literalIndex(entry.value!).root.objects!.list[0]!.names;
}

/**
 * #2065: the first steps a whole store can hold below its prefix, both parts proved: its value's, from the settled
 * stores it brought, each a closed object literal (`entrySupport`), with no layer of its source's own stores below
 * their root; and its written part's, from its own stops (`stopsOf`): a copy of a written binding or a value no
 * literal holds stands at its path's first step, and at the root it may answer every path. `null` (every step) for
 * any other store: not an initializer or an assignment, bringing no settled store or an unproved one, or with a
 * written or unproved value at its root.
 */
function supportOf(
  admission: Admission,
  d: Definition,
  brought: ReadonlyMap<Definition, readonly number[]>,
  entries: readonly (ReadonlySet<string> | null)[],
  layered: ReadonlySet<Definition | null>,
): ReadonlySet<string> | null {
  const work = admission.pass.program.work;
  work.charge("indexSteps");
  if (d.kind !== "whole" || (d.how !== "initializer" && d.how !== "assignment")) return null;
  if (d.value === undefined || layered.has(d)) return null;
  const at = brought.get(d);
  if (at === undefined) return null;
  const names = new Set<string>();
  for (const position of at) {
    const own = entries[position]!;
    if (own === null) return null;
    for (const name of own) {
      work.charge("indexSteps");
      names.add(name);
    }
  }
  const stops = stopsOf(admission, d.value, d.node);
  for (const [text, list] of stops.written) {
    work.charge("indexSteps");
    if (text !== "") names.add(text.split(".", 1)[0]!);
    else
      for (const stop of list) {
        const source = copySupport(admission, stop, true);
        if (source === null) return null;
        for (const name of source) names.add(name);
      }
  }
  for (const [text, list] of stops.values) {
    work.charge("indexSteps");
    if (text !== "") names.add(text.split(".", 1)[0]!);
    else
      for (const stop of list) {
        const source = copySupport(admission, stop, false);
        if (source === null) return null;
        for (const name of source) names.add(name);
      }
  }
  return names;
}

/**
 * The first steps a stop at a value's root can bring an answer to, where it is a whole copy of an unwritten place,
 * through no operation, the place's one settled store a closed object literal (`entrySupport`) with no layer below its
 * root: that literal's names. `inherits`: the copy's inherited written type (A4, `inheritedInto`), which the place's
 * stores decide, its literal's written parts standing below its own properties; else the copy's value (a read of the
 * place, `Contract.copiedKey`), the place's contract, its literal's. `null` for any other stop, unproved.
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
  return entrySupport(admission, source.list[0]!);
}

/** A list's positions by the names each supports (`null`: every step), each posting charged. */
function positions(
  admission: Admission,
  supports: readonly (ReadonlySet<string> | null)[],
): StepPositions {
  const work = admission.pass.program.work;
  const steps = new Map<string, number[]>();
  const any: number[] = [];
  for (const [at, names] of supports.entries()) {
    work.charge("indexSteps");
    if (names === null) {
      any.push(at);
      continue;
    }
    for (const name of names) {
      work.charge("indexSteps");
      const list = steps.get(name);
      if (list === undefined) {
        keepText(admission.work, name.length);
        steps.set(name, [at]);
      } else list.push(at);
    }
  }
  keep(admission.work, any.length + steps.size);
  return { steps, any };
}
