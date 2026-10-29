import type { PlaceId } from "../../graph.js";
import { joinParts, joinSteps, keptText, pathText } from "../budget.js";
import type { Contract } from "../contract.js";
import {
  keptKey,
  keyBelow,
  keyOf,
  keyPath,
  keyPlace,
  recordPath,
  sortCost,
  type Key,
} from "../definitions.js";
import type { Callable } from "../flow-graph.js";
import { marked } from "../guards.js";
import { REASON, type IngressNode, type Item } from "../items.js";
import { stepName } from "../program.js";
import { ABSENT } from "./kinds.js";
import { indexPaths, pathBelow } from "./literal-index.js";
import type { Holder, HolderReference, ReadGroup, ReferencesByStep } from "./model.js";
import { addSource, unionOf } from "./selections.js";

// The mark holders (§8 r4.23): each holder's reads and references, and its mark at a path (§3.2).

/** A set or map: the smaller of two key sets, intersected with the larger. */
function common<T>(
  a: { readonly size: number; has(key: T): boolean; keys(): Iterable<T> },
  b: { readonly size: number; has(key: T): boolean; keys(): Iterable<T> },
): T[] {
  return a.size <= b.size
    ? [...a.keys()].filter((key) => b.has(key))
    : [...b.keys()].filter((key) => a.has(key));
}

/**
 * Whether a holder marks no path, whatever the path (`marksAt`): no holder it reaches through its references, itself
 * included, has a guarded path or a read of its own. Once per holder and pass, the references' components found on an
 * explicit stack (a holder's references are made with it, and `collectMarks` adds the rest before the first ask).
 */
export function marksNothing(contract: Contract, holder: Holder | null): boolean {
  if (holder === null) return true;
  collectMarks(contract);
  const known = contract.quiet.get(holder);
  if (known !== undefined) return known;
  const work = contract.pass.program.work;
  const index = new Map<Holder, number>();
  const low = new Map<Holder, number>();
  const open: Holder[] = [];
  const frames: { readonly holder: Holder; readonly to: Holder[]; at: number; quiet: boolean }[] =
    [];
  const enter = (each: Holder): void => {
    work.charge("invSteps");
    index.set(each, index.size);
    low.set(each, index.size - 1);
    open.push(each);
    frames.push({
      holder: each,
      to: [...each.refsAt.values()].flatMap((list) => list.map((reference) => reference.to)),
      at: 0,
      quiet: each.guarded.size === 0 && each.reads.length === 0,
    });
  };
  enter(holder);
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    if (frame.at < frame.to.length) {
      const to = frame.to[frame.at++]!;
      work.charge("invSteps");
      const done = contract.quiet.get(to);
      if (done !== undefined) frame.quiet &&= done;
      else if (!index.has(to)) enter(to);
      else if (open.includes(to))
        low.set(frame.holder, Math.min(low.get(frame.holder)!, index.get(to)!));
      continue;
    }
    frames.pop();
    const parent = frames.at(-1);
    if (low.get(frame.holder) === index.get(frame.holder)) {
      // a component: quiet where every member is and every reference out of it reaches only quiet ones
      const members: Holder[] = [];
      let quiet = frame.quiet;
      for (let member = open.pop()!; ; member = open.pop()!) {
        members.push(member);
        if (member === frame.holder) break;
      }
      for (const member of members) quiet &&= contract.pendingQuiet.get(member) ?? true;
      contract.keep(members.length);
      for (const member of members) {
        contract.pendingQuiet.delete(member);
        contract.quiet.set(member, quiet);
      }
      if (parent !== undefined) parent.quiet &&= quiet;
    } else {
      // (a member of a component still open: its own findings wait for the component's root)
      contract.pendingQuiet.set(frame.holder, frame.quiet);
      if (parent !== undefined) {
        low.set(parent.holder, Math.min(low.get(parent.holder)!, low.get(frame.holder)!));
        parent.quiet &&= frame.quiet;
      }
    }
  }
  return contract.quiet.get(holder)!;
}

export function newHolder(contract: Contract, id: string): Holder {
  contract.keepText(id.length);
  contract.facts.markNodes += 1;
  const holder: Holder = {
    id,
    reads: [],
    readSeen: new Set(),
    refsAt: new Map(),
    refSeen: new Set(),
    guarded: new Set(),
  };
  contract.holders.set(id, holder);
  return holder;
}

/** A reference from `holder` to `to`, seen from `shift` below `to`'s identity, standing at `at` below `holder`'s. */
function refer(
  contract: Contract,
  holder: Holder,
  to: Holder,
  shift: readonly string[] = [],
  where = 0,
): void {
  contract.pass.program.work.charge("invSteps");
  const key = joinParts(to.id, shift, where);
  if (holder.refSeen.has(key)) return;
  contract.keepText(key.length);
  holder.refSeen.add(key);
  contract.facts.markNodes += 1;
  const list = holder.refsAt.get(where);
  if (list === undefined) holder.refsAt.set(where, [{ to, shift }]);
  else list.push({ to, shift });
}

/** A key's holder: its own reads, and a reference to its prefix's at its last step (one per projection). */
export function holderOfKey(contract: Contract, key: Key): Holder {
  const known = contract.holders.get(`k${key}`);
  if (known !== undefined) return known;
  const holder = newHolder(contract, `k${key}`);
  const path = keyPath(key);
  if (path.length > 0)
    refer(
      contract,
      holder,
      holderOfKey(contract, keyOf(keyPlace(key), path.slice(0, -1))),
      path.slice(-1),
    );
  return holder;
}

/** A stored value's holder at a path below it (a place of copies of one value, lifted). */
export function holderAt(
  contract: Contract,
  holder: Holder | null,
  path: readonly string[],
): Holder | null {
  if (holder === null || path.length === 0) return holder;
  const id = `${holder.id}@${keptText(contract.work, path)}`;
  const known = contract.holders.get(id);
  if (known !== undefined) return known;
  const lifted = newHolder(contract, id);
  refer(contract, lifted, holder, path);
  return lifted;
}

/** A holder's reads grouped once: per base key the groups by callable and file, in dominator and source order. */
function readGroups(
  contract: Contract,
  reads: Holder["reads"],
): Map<Key, { readonly byCallable: Map<Callable | null, ReadGroup>; readonly list: ReadGroup[] }> {
  const known = contract.groups.get(reads);
  if (known !== undefined) return known;
  const { program } = contract.pass;
  const groups = new Map<
    Key,
    { readonly byCallable: Map<Callable | null, ReadGroup>; readonly list: ReadGroup[] }
  >();
  const byKey = new Map<string, ReadGroup>();
  const callables = new Map<Callable | null, number>();
  for (const read of reads) {
    program.work.charge("eventSteps");
    let current = read.value;
    const steps: string[] = [];
    for (let projection = program.projOf.get(current); projection !== undefined;) {
      steps.push(projection.step === "iteration" ? "element" : stepName(projection.step));
      current = projection.owner;
      projection = program.projOf.get(current);
    }
    const node = program.occNode.get(current);
    const binding = program.occurrenceOf.get(current);
    if (binding === undefined || node === undefined || node === null || !program.reached(node))
      continue;
    const callable = program.callableAt(node);
    if (!callables.has(callable)) callables.set(callable, callables.size);
    const base = keptKey(contract.work, binding, joinSteps(steps.reverse(), read.path));
    const groupKey = `${base}#${callables.get(callable)}#${node.file}`;
    let group = byKey.get(groupKey);
    if (group === undefined) {
      byKey.set(
        groupKey,
        (group = { callable, file: node.file, nodes: [], byPosition: [], byStart: [] }),
      );
      let entry = groups.get(base);
      if (entry === undefined) groups.set(base, (entry = { byCallable: new Map(), list: [] }));
      entry.byCallable.set(callable, group);
      entry.list.push(group);
    }
    group.nodes.push(node);
  }
  for (const [, entry] of groups)
    for (const group of entry.list) {
      program.work.charge("eventSteps", sortCost(group.nodes.length));
      group.byPosition = [...group.nodes].sort((a, b) => program.position(a) - program.position(b));
      group.byStart = group.nodes
        .filter((node) => node.span !== null)
        .map((node) => node.span!.start.offset)
        .sort((a, b) => a - b);
    }
  contract.groups.set(reads, groups);
  return groups;
}

/** Whether a sorted list holds a position in [low, high]. */
function within<T>(
  contract: Contract,
  list: readonly T[],
  position: (entry: T) => number,
  low: number,
  high: number,
): boolean {
  let a = 0;
  let b = list.length;
  while (a < b) {
    const middle = (a + b) >> 1;
    contract.pass.program.work.charge("eventSteps");
    if (position(list[middle]!) < low) a = middle + 1;
    else b = middle;
  }
  return a < list.length && position(list[a]!) <= high;
}

/** A group's reads under a guard region of tested key t: the cheaper of each read's search and each region's. */
function groupHit(contract: Contract, group: ReadGroup, tested: Key): boolean {
  const { program, guards } = contract.pass;
  const branches = guards.branchesOf(tested, group.callable);
  const regions = guards.operandsOf(tested, group.file);
  program.work.charge("eventSteps");
  const branchCount = branches?.list.length ?? 0;
  const regionCount = regions?.list.length ?? 0;
  if (branchCount + regionCount === 0) return false;
  if (group.nodes.length <= branchCount + regionCount)
    return group.byPosition.some(
      (node) =>
        (branches !== undefined &&
          guards.encloses(branches, (entry) => program.position(entry), program.position(node))) ||
        (regions !== undefined &&
          node.span !== null &&
          guards.encloses(regions, (region) => region.start, node.span.start.offset)),
    );
  return (
    (branches?.list.some((entry) =>
      within(
        contract,
        group.byPosition,
        (node) => program.position(node),
        program.position(entry),
        program.positionEnd(entry),
      ),
    ) ??
      false) ||
    (regions?.list.some((region) =>
      within(contract, group.byStart, (start) => start, region.start, region.end),
    ) ??
      false)
  );
}

/**
 * A holder's own reads at path `rest` below it: per non-empty prefix q, the keys tested q below them and the reads of
 * such a key (the smaller side walked), each group of only the callables and files a test of the tested path stands
 * in (W40, r4.28, r4.33); the first hit ends the lookup; every visit charged.
 */
function readsAt(contract: Contract, reads: Holder["reads"], rest: readonly string[]): boolean {
  const { program, guards } = contract.pass;
  const byBase = readGroups(contract, reads);
  const visit = (group: ReadGroup, tested: Key): boolean => {
    program.work.charge("eventSteps");
    contract.facts.markVisits += 1;
    return groupHit(contract, group, tested);
  };
  for (let length = 1; length <= rest.length; length += 1) {
    const q = rest.slice(0, length);
    const candidates = guards.testedBelow(pathText(q));
    if (candidates === undefined) continue;
    program.work.charge("eventSteps", Math.min(candidates.size, byBase.size) + 1);
    for (const base of common(candidates, byBase)) {
      const entry = byBase.get(base)!;
      const tested = keyBelow(base, q);
      const branchCallables = guards.branchCallables(tested);
      const operandCallables = guards.operandCallables(tested);
      if (branchCallables !== undefined) {
        program.work.charge("eventSteps", Math.min(branchCallables.size, entry.byCallable.size));
        for (const callable of common(branchCallables, entry.byCallable))
          if (visit(entry.byCallable.get(callable)!, tested)) return true;
      }
      // a logical operand's regions stand in its expression's callable: the groups of those callables only
      if (operandCallables !== undefined) {
        program.work.charge("eventSteps", Math.min(operandCallables.size, entry.byCallable.size));
        for (const callable of common(operandCallables, entry.byCallable))
          if (
            branchCallables?.has(callable) !== true &&
            visit(entry.byCallable.get(callable)!, tested)
          )
            return true;
      }
    }
  }
  return false;
}

/**
 * Every contribution, once per pass before the first query: each live stored read of a key with a tested key below
 * it into its source's holder (stores, adds, arguments, returns, literal cells, alias bindings); each literal's reads
 * as references from the literal's holder under their path, and its guarded reads' paths. A literal another literal
 * holds is among that literal's: its reads stand in the outer literal's index at their paths below it, so its own
 * would repeat them, and its identity would walk its whole depth again at every level (TABLE r4.100 (2)).
 */
export function collectMarks(contract: Contract): void {
  if (contract.collected) return;
  contract.collected = true;
  // (a key's lane asked meanwhile would read the marks unfinished: `keyLane`)
  contract.building += 1;
  try {
    collectAll(contract);
  } finally {
    contract.building -= 1;
  }
}

function collectAll(contract: Contract): void {
  const { program, definitions, lists, guards } = contract.pass;
  const stores = new Set([...definitions.storeDefs, ...definitions.transferDefs]);
  const held = new Set<PlaceId>();
  for (const [, cells] of definitions.cellDefs)
    for (const d of cells) {
      stores.add(d);
      if (d.value !== undefined) held.add(d.value);
    }
  for (const d of stores) {
    program.work.charge("invSteps");
    if (d.value === undefined || !lists.live(d)) continue;
    const copied = contract.copiedKey(d.value);
    if (copied === null || !guards.belowTested.has(copied)) continue;
    const holder = contract.identityOf(d.value).holder;
    if (holder === null || holder.readSeen.has(d.value)) continue;
    holder.readSeen.add(d.value);
    contract.facts.markNodes += 1;
    holder.reads.push({ value: d.value, path: [] });
  }
  for (const value of program.hasOf.keys()) {
    program.work.charge("invSteps");
    if (held.has(value)) continue;
    const holder = contract.identityOf(value).holder;
    if (holder === null) continue;
    for (const [path, node] of indexPaths(contract, contract.literalIndex(value), "marks"))
      for (const entry of node.reads) {
        program.work.charge("invSteps");
        if (entry.guarded) holder.guarded.add(path);
        if (entry.holder !== null) refer(contract, holder, entry.holder, [], path);
      }
  }
}

/**
 * How many leading steps of a path a holder's answer can depend on: the longest tested path, its guarded literal
 * paths, and each reference's place plus what the referenced holder needs beyond the shift; a cycle: no limit. A walk
 * on an explicit stack, each holder once.
 */
export function depthOf(contract: Contract, holder: Holder): number {
  if (holder.depth !== undefined) return holder.depth;
  const { guards, program } = contract.pass;
  const stack: {
    readonly holder: Holder;
    readonly references: readonly (readonly [number, HolderReference])[];
    index: number;
    depth: number;
  }[] = [];
  const open = (each: Holder): void => {
    each.depth = Infinity;
    let depth = guards.testedLength();
    for (const at of each.guarded) depth = Math.max(depth, contract.pathDepths[at]!);
    stack.push({
      holder: each,
      references: [...each.refsAt].flatMap(([at, list]) =>
        list.map((reference) => [at, reference] as const),
      ),
      index: 0,
      depth,
    });
  };
  open(holder);
  while (stack.length > 0) {
    const top = stack.at(-1)!;
    if (top.index < top.references.length) {
      const [at, reference] = top.references[top.index]!;
      if (reference.to.depth === undefined) {
        open(reference.to);
        continue;
      }
      top.index += 1;
      program.work.charge("invSteps");
      top.depth = Math.max(
        top.depth,
        contract.pathDepths[at]! + Math.max(0, reference.to.depth - reference.shift.length),
      );
      continue;
    }
    stack.pop();
    top.holder.depth = top.depth;
  }
  return holder.depth!;
}

/**
 * §3.2: a holder's mark at `path` (memoised per holder and the leading steps it can depend on): a literal's guarded
 * read at a prefix, the references standing at a prefix (each asked once, for the rest under its shift), its own
 * reads; a choice's selection step as the record key it reads. A walk on an explicit stack: a holder's ask waits on the
 * references it asks. #1278: a mark at a path cut by a property no source holds (`ABSENT`) holds at the path it cuts,
 * and a reference whose mark depends on no path starting with the next step (`markFirsts`; no test reads that step)
 * answers as there: so the references at a path are asked by that step (`referencesBy`) and, for the rest, the
 * holder once at the path and `ABSENT`. k references asked below k different properties are asked once each, not
 * k times.
 */
export function marksAt(
  contract: Contract,
  holder: Holder | null,
  read: readonly string[],
): boolean {
  if (holder === null) return false;
  collectMarks(contract);
  // G3 3b: a holder that reaches no guarded path and no read marks no path (`marksNothing`, once per holder)
  if (marksNothing(contract, holder)) return false;
  const work = contract.pass.program.work;
  const tested = contract.pass.guards.testedSteps();
  const stack: {
    readonly holder: Holder;
    readonly rest: readonly string[];
    readonly memoKey: string;
    length: number;
    /** The id of the rest's first `length` steps, -1 where no literal index holds them (`pathBelow`). */
    path: number;
    references: readonly HolderReference[];
    /** The holder is still to be asked at the rest's first `length` steps and `ABSENT` (`referencesAt`). */
    absent: boolean;
    index: number;
    hit: boolean;
  }[] = [];
  // an ask: its answer if known, else a frame for it
  const ask = (asked: Holder, at: readonly string[]): boolean | undefined => {
    // every ask, an answered one too
    work.charge("eventSteps");
    const depth = depthOf(contract, asked);
    const rest = at.length > depth ? at.slice(0, depth) : at;
    const memoKey = pathText(rest);
    asked.memo ??= new Map();
    const known = asked.memo.get(memoKey);
    if (known !== undefined) return known;
    // a reference back to itself answers no
    contract.keepText(memoKey.length);
    asked.memo.set(memoKey, false);
    work.charge("eventSteps", 1 + rest.length);
    const { references, absent } = referencesAt(contract, asked, 0, rest, 0, tested);
    stack.push({
      holder: asked,
      rest,
      memoKey,
      length: 0,
      path: 0,
      references,
      absent,
      index: 0,
      hit: asked.guarded.has(0),
    });
    return undefined;
  };
  let answer = ask(holder, recordPath(read));
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (answer === true) frame.hit = true;
    answer = undefined;
    if (frame.absent) {
      frame.absent = false;
      if (!frame.hit)
        answer = ask(frame.holder, joinSteps(frame.rest.slice(0, frame.length), [ABSENT]));
      continue;
    }
    if (frame.index < frame.references.length) {
      const reference = frame.references[frame.index++]!;
      work.charge("eventSteps");
      contract.facts.markVisits += 1;
      if (!frame.hit)
        answer = ask(reference.to, joinSteps(reference.shift, frame.rest.slice(frame.length)));
      continue;
    }
    if (!frame.hit && frame.length < frame.rest.length) {
      frame.length += 1;
      frame.path = pathBelow(contract, frame.path, frame.rest[frame.length - 1]!);
      frame.index = 0;
      // (a holder's guarded reads and references stand at the paths of literal indexes: none at a path no index
      // holds, nor below it)
      if (frame.path < 0) {
        frame.length = frame.rest.length;
        frame.references = [];
        continue;
      }
      if (frame.holder.guarded.has(frame.path)) frame.hit = true;
      ({ references: frame.references, absent: frame.absent } = referencesAt(
        contract,
        frame.holder,
        frame.path,
        frame.rest,
        frame.length,
        tested,
      ));
      continue;
    }
    if (
      !frame.hit &&
      frame.holder.reads.length > 0 &&
      readsAt(contract, frame.holder.reads, frame.rest)
    )
      frame.hit = true;
    frame.holder.memo!.set(frame.memoKey, frame.hit);
    stack.pop();
    answer = frame.hit;
  }
  return answer!;
}

/**
 * #1278: the references a holder's mark walk asks at `where`, the rest's first `length` steps (`marksAt`): where the
 * next step is a property no test reads and several stand there, those whose mark can depend on a path starting with
 * it, and every one that may depend on any (`referencesBy`), with the holder asked at the path and `ABSENT` for the
 * others (`absent`); else all of them.
 */
function referencesAt(
  contract: Contract,
  holder: Holder,
  where: number,
  rest: readonly string[],
  length: number,
  tested: ReadonlySet<string>,
): { readonly references: readonly HolderReference[]; readonly absent: boolean } {
  const references = holder.refsAt.get(where) ?? [];
  const step = rest[length];
  if (references.length < 2 || step === undefined || step === ABSENT || tested.has(step))
    return { references, absent: false };
  const by = referencesBy(contract, holder, where, references);
  const stepping = by.byStep.get(step) ?? [];
  return { references: by.any.length === 0 ? stepping : [...stepping, ...by.any], absent: true };
}

/** A holder's references at a path by the first steps their marks can depend on (`markFirsts`), once per path. */
function referencesBy(
  contract: Contract,
  holder: Holder,
  where: number,
  references: readonly HolderReference[],
): ReferencesByStep {
  holder.byStep ??= new Map();
  const known = holder.byStep.get(where);
  if (known !== undefined) return known;
  const byStep = new Map<string, HolderReference[]>();
  const any: HolderReference[] = [];
  let units = 3 + references.length;
  for (const reference of references) {
    contract.pass.program.work.charge("eventSteps");
    const firsts = reference.shift.length > 0 ? null : markFirsts(contract, reference.to);
    if (firsts === null) {
      any.push(reference);
      continue;
    }
    for (const step of firsts) {
      contract.pass.program.work.charge("eventSteps");
      const list = byStep.get(step);
      units += list === undefined ? 2 : 1;
      if (list === undefined) byStep.set(step, [reference]);
      else list.push(reference);
    }
  }
  const by: ReferencesByStep = { byStep, any };
  contract.keep(units);
  holder.byStep.set(where, by);
  return by;
}

/**
 * #1278: the first steps of the paths a holder's mark can depend on, `null` for any: those its guarded reads and its
 * references stand below, and those of each holder it refers to where it stands (a reference with a shift: any; a
 * cycle: any). Its own reads are marked by tests (`readsAt`), so a step a test reads is never left out
 * (`referencesAt`). Once per holder, on an explicit walk; one set where a holder only refers to one.
 */
function markFirsts(contract: Contract, holder: Holder): ReadonlySet<string> | null {
  if (holder.firsts !== undefined) return holder.firsts;
  const stack: Holder[] = [holder];
  const opened = new Set<Holder>();
  const done = new Set<Holder>();
  while (stack.length > 0) {
    const top = stack.at(-1)!;
    if (!opened.has(top)) {
      opened.add(top);
      // (a cycle back to it may depend on any step)
      top.firsts = null;
      for (const reference of top.refsAt.get(0) ?? [])
        if (reference.shift.length === 0 && reference.to.firsts === undefined)
          stack.push(reference.to);
      continue;
    }
    stack.pop();
    if (done.has(top)) continue;
    done.add(top);
    top.firsts = ownFirsts(contract, top);
  }
  return holder.firsts!;
}

/** A holder's first steps (`markFirsts`), those of the holders it refers to known. */
function ownFirsts(contract: Contract, holder: Holder): ReadonlySet<string> | null {
  const own = new Set<string>();
  const sources = new Set<ReadonlySet<string>>();
  const add = (where: number): void => {
    contract.pass.program.work.charge("eventSteps");
    if (where === 0) return;
    // (its first step: the path's ancestor one step deep)
    let first = where;
    while (contract.pathParents[first]! > 0) first = contract.pathParents[first]!;
    const step = contract.pathLastSteps[first]!;
    if (own.has(step)) return;
    contract.keepText(step.length);
    own.add(step);
  };
  for (const where of holder.guarded) add(where);
  for (const [where, references] of holder.refsAt) {
    add(where);
    if (where !== 0) continue;
    for (const reference of references) {
      contract.pass.program.work.charge("eventSteps");
      if (reference.shift.length > 0) return null;
      const inner = reference.to.firsts;
      if (inner === null || inner === undefined) return null;
      addSource(contract, sources, inner);
    }
  }
  if (own.size > 0) addSource(contract, sources, own);
  return unionOf(contract, sources);
}

/**
 * An entry's answer with its annotations: its guard bit or a mark at the path marks it (§3.2); the ingress stores of
 * every value it stands for go to its external items (C9: one boundary check per ingress store).
 */
export function annotated(
  contract: Contract,
  entry: {
    readonly guarded: boolean;
    readonly holder: Holder | null;
    readonly ingress: IngressNode | undefined;
  },
  rest: readonly string[],
  items: readonly Item[],
): readonly Item[] {
  const ingress = contract.pass.program.scope.ingress;
  const annotated =
    entry.ingress === undefined
      ? items
      : items.map((item) =>
          item.tag === "unknown" && (item.reasons & REASON.external) !== 0
            ? { ...item, ingress: ingress.union(item.ingress, entry.ingress)! }
            : item,
        );
  return entry.guarded || marksAt(contract, entry.holder, rest) ? marked(annotated) : annotated;
}
