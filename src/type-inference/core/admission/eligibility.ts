import type { PlaceId } from "../../graph.js";
import {
  canonicalKey,
  keptKeyAt,
  keptStepsFrom,
  keyWalk,
  stepsRest,
  stepsTo,
  type CanonicalKey,
  type Rest,
  type Steps,
} from "../contract/key-ids.js";
import type { Admission } from "../admission.js";
import { joinParts, keepText, type WorkLedger } from "../budget.js";
import {
  isCursor,
  keptPrefixes,
  prefixesOf,
  recordKey,
  sortCost,
  type Definition,
  type Key,
} from "../definitions.js";
import type { Callable } from "../flow-graph.js";
import { addRest, aliasKeyAt, covers, grouped, tested } from "./classes.js";

// §4.3's eligibility: a class's earliest member no test of its read's path holds, and the whole stores A2 reads.

/**
 * A prefix's whole stores in source order (A2's lazy scan), returns, parameter defaults and single-site arguments among
 * them (a single-site parameter starts as its argument), or its adds. A read of a host value decides no path below it
 * (external data, no kind and no `null`), so the scan passes none.
 */
export function wholeOf(admission: Admission, key: Key, add: boolean): Definition[] {
  const memoKey = joinParts(key, add);
  let list = admission.whole.get(memoKey);
  if (list === undefined) {
    const { definitions, lists, program } = admission.pass;
    const stores = definitions.byKey.get(key) ?? [];
    program.work.charge("indexSteps", stores.length);
    list = stores.filter(
      (d) =>
        lists.live(d) &&
        !hostRead(admission, d.value) &&
        (add
          ? d.kind === "add"
          : d.kind === "whole" &&
            (d.how !== "argument" || lists.singleSite(d.fn)) &&
            !admission.besideDefault(d)),
    );
    program.work.charge("checks", sortCost(list.length));
    list.sort((a, b) => admission.sourceOrder(a) - admission.sourceOrder(b));
    list = grouped(admission, list);
    keepText(admission.work, memoKey.length);
    admission.whole.set(memoKey, list);
  }
  return list;
}

/**
 * A prefix's whole stores as A2's scan reads them at a rest (S6-CARRIERS §4.2, §4.3): each class's representative,
 * and where a guard of the path holds it, its class's earliest eligible member too, which stands where it is in source
 * order and decides with its own answer (a guard marks a read possible, so it decides nothing).
 */
export function eligibleOf(
  admission: Admission,
  prefix: Key,
  below: Rest,
  add = false,
): Definition[] {
  const list = wholeOf(admission, prefix, add);
  let out: Definition[] | null = null;
  for (const [index, representative] of list.entries()) {
    const members = admission.members.get(representative);
    if (members === undefined) continue;
    const rest = add ? addRest(representative, below) : below;
    if (!covers(admission, representative, rest)) {
      // (beside or above a literal's alias cell each member stands by itself)
      out ??= list.slice(0, index);
      for (const member of members) out.push(member);
      continue;
    }
    const eligible = eligibleAt(admission, representative, prefix, rest);
    if (eligible === null || eligible === representative) continue;
    out ??= list.slice(0, index);
    out.push(eligible);
  }
  if (out === null) return list;
  // (the representatives and the eligible members, in source order)
  const merged = [...new Set([...list, ...out])];
  admission.pass.program.work.charge("eligibility", sortCost(merged.length));
  return merged.sort((a, b) => admission.sourceOrder(a) - admission.sourceOrder(b));
}

/**
 * §4.3: a class's earliest member that no test of its read's path holds at `rest`, `null` where every member is
 * guarded there: by the deepest tested key on the path's chain of prefixes, from the class's eligibility index.
 */
function eligibleAt(
  admission: Admission,
  representative: Definition,
  prefix: Key,
  rest: Rest,
): Definition | null {
  const { guards } = admission.pass;
  const at = aliasKeyAt(admission.pass.contract, admission.aliases.get(representative)!, rest);
  // (a cursor's binding no test names: its family's shape requires it, G3 stage 1)
  const full = at === null || isCursor(at) ? null : recordKey(at);
  let deepest = "";
  for (const key of full === null ? [] : [full, ...prefixesOf(full)]) {
    admission.pass.program.work.charge("eligibility");
    if (tested(guards, key)) {
      deepest = key;
      break;
    }
  }
  // (while the groups are made, a path `hotSets` tests asks its chain by itself: the index wants every decided path,
  // which the groups give once made; each chain's answer is the index's, Sol's review r1 B1)
  if (admission.groupList === null) {
    let chains = admission.eligibleWhileGrouping.get(representative);
    if (chains === undefined)
      admission.eligibleWhileGrouping.set(representative, (chains = new Map()));
    if (!chains.has(deepest)) {
      keepText(admission.work, deepest.length);
      chains.set(deepest, eligibleBy(admission, representative, [deepest]));
    }
    return chains.get(deepest)!;
  }
  let index = admission.eligible.get(representative);
  if (index === undefined) {
    index = eligibility(admission, representative, prefix);
    admission.eligible.set(representative, index);
  }
  if (!index.has(deepest)) index.set(deepest, eligibleBy(admission, representative, [deepest]));
  return index.get(deepest)!;
}

/**
 * §4.3's index of a class, once per class and pass: the tested keys on the chains of its demanded paths as a trie,
 * walked depth first over a segment tree of its members in flow order (each leaf a guard count, each node its least
 * count and the earliest member with it): entering a key adds one to every member a test of that key holds (a branch
 * a range of the flow order, or each member asked where its callable holds more branches than members; an operand
 * region each member it holds, a range of the text order), leaving it undoes that. Each key's eligible member is the
 * earliest with no count.
 */
function eligibility(
  admission: Admission,
  representative: Definition,
  prefix: Key,
): Map<string, Definition | null> {
  const { guards } = admission.pass;
  const alias = admission.aliases.get(representative)!;
  const children = new Map<string, Set<string>>([["", new Set()]]);
  for (const demanded of demandsOf(admission, prefix)) {
    // (an add's class answers below its added value: a demand below the list's element)
    if (
      representative.kind === "add" &&
      representative.how !== "elements" &&
      demanded.at(0) !== "element"
    )
      continue;
    // (a record's rest read as its steps, a view: `stepsRest`)
    const rest = stepsRest(demanded);
    const at = aliasKeyAt(
      admission.pass.contract,
      alias,
      representative.kind === "add" ? addRest(representative, rest) : rest,
    );
    // (a cursor's binding no test names: its family's shape requires it, G3 stage 1)
    if (at === null || isCursor(at)) continue;
    const full = recordKey(at);
    let parent = "";
    for (const key of [...keptPrefixes(admission.work, full).reverse(), full]) {
      admission.pass.program.work.charge("eligibility");
      if (!tested(guards, key)) continue;
      if (!children.has(key)) children.set(key, new Set());
      children.get(parent)!.add(key);
      parent = key;
    }
  }
  const out = new Map<string, Definition | null>();
  const walk = walkGuards(admission, representative);
  walk.enter(null);
  out.set("", walk.eligible());
  const pending: { readonly key: string; readonly leave: boolean }[] = [
    ...[...children.get("")!].map((key) => ({ key, leave: false })),
  ];
  while (pending.length > 0) {
    const { key, leave } = pending.pop()!;
    admission.pass.program.work.charge("eligibility");
    if (leave) {
      walk.leave();
      continue;
    }
    walk.enter(key);
    out.set(key, walk.eligible());
    pending.push({ key, leave: true });
    for (const child of children.get(key) ?? []) pending.push({ key: child, leave: false });
  }
  return out;
}

/** A class's eligible member under a chain of tested keys, the index's walk for one chain (a path not demanded). */
function eligibleBy(
  admission: Admission,
  representative: Definition,
  chain: readonly string[],
): Definition | null {
  const { guards } = admission.pass;
  const walk = walkGuards(admission, representative);
  walk.enter(null);
  const keys = chain[0] === "" ? [] : [...prefixesOf(chain[0]!).reverse(), chain[0]!];
  for (const key of keys) if (tested(guards, key)) walk.enter(key);
  return walk.eligible();
}

/** §4.3's walk over a class's members: guard counts per tested key entered, undone in reverse. */
function walkGuards(
  admission: Admission,
  representative: Definition,
): {
  readonly enter: (key: string | null) => void;
  readonly leave: () => void;
  readonly eligible: () => Definition | null;
} {
  const { program, guards } = admission.pass;
  const work = program.work;
  const members = [representative, ...(admission.members.get(representative) ?? [])];
  const reads = members.map((d) => admission.aliases.get(d)!.read);
  // (an unreached read is never guarded: always eligible)
  const unreached = members.findIndex((_, index) => !program.reached(reads[index]!));
  // members in flow order (their reads' positions) and in text order (file, offset), as leaf indexes
  const flow = members.map((_, index) => index);
  flow.sort((a, b) => program.position(reads[a]!) - program.position(reads[b]!));
  work.charge("eligibility", sortCost(flow.length));
  const leafOf = new Map<number, number>(flow.map((member, leaf) => [member, leaf]));
  const positions = flow.map((member) => program.position(reads[member]!));
  const text = members.map((_, index) => index).filter((index) => reads[index]!.span !== null);
  text.sort(
    (a, b) =>
      reads[a]!.file - reads[b]!.file ||
      reads[a]!.span!.start.offset - reads[b]!.span!.start.offset,
  );
  work.charge("eligibility", sortCost(text.length));
  const byCallable = new Map<Callable | null, number[]>();
  for (const member of flow) {
    const callable = program.callableAt(reads[member]!);
    const list = byCallable.get(callable);
    if (list === undefined) byCallable.set(callable, [member]);
    else list.push(member);
  }
  const tree = new GuardTree(flow, work);
  const log: (readonly [number, number])[][] = [];
  const lowerBound = (list: readonly number[], value: number, from = 0): number => {
    let low = from;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      work.charge("eligibility");
      if (list[middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const textStarts = text.map((member) => reads[member]!.span!.start.offset);
  const textFiles = text.map((member) => reads[member]!.file);
  return {
    enter: (key) => {
      const done: (readonly [number, number])[] = [];
      log.push(done);
      if (key === null) return;
      const add = (low: number, high: number): void => {
        tree.add(low, high, 1);
        done.push([low, high]);
      };
      for (const [callable, inCallable] of byCallable) {
        const branches = guards.branchesOf(key, callable);
        if (branches === undefined) continue;
        if (branches.list.length > inCallable.length) {
          for (const member of inCallable)
            if (guards.branchHolds(key, reads[member]!)) {
              const leaf = leafOf.get(member)!;
              add(leaf, leaf);
            }
          continue;
        }
        for (const entry of branches.list) {
          const low = lowerBound(positions, program.position(entry));
          const high = lowerBound(positions, program.positionEnd(entry) + 1) - 1;
          if (low <= high) add(low, high);
        }
      }
      for (const file of new Set(textFiles)) {
        const regions = guards.operandsOf(key, file);
        if (regions === undefined) continue;
        const first = lowerBound(textFiles, file);
        for (const region of regions.list) {
          let at = lowerBound(textStarts, region.start, first);
          for (
            ;
            at < text.length && textFiles[at] === file && textStarts[at]! <= region.end;
            at += 1
          ) {
            const leaf = leafOf.get(text[at]!)!;
            add(leaf, leaf);
          }
        }
      }
    },
    leave: () => {
      for (const [low, high] of log.pop() ?? []) tree.add(low, high, -1);
    },
    eligible: () => {
      const leaf = tree.eligible();
      const found = leaf === null ? -1 : flow[leaf]!;
      const index = unreached >= 0 && (found < 0 || unreached < found) ? unreached : found;
      return index < 0 ? null : members[index]!;
    },
  };
}

/** The rests below a key of the paths the pass decides (`groups()`): every split of every decided path, once. */
function demandsOf(admission: Admission, asked: Key): readonly Steps[] {
  if (admission.demands === null) {
    const demands = new Map<CanonicalKey, Steps[]>();
    for (const group of admission.groups()) {
      // (a cursor's steps made through the charged boundary, its prefixes its ancestors: G3 stage 1)
      const path = admission.stepsAt(group);
      const walk = group.key === undefined ? null : keyWalk(admission.pass.contract, group.key);
      for (let length = 0; length < path.length; length += 1) {
        admission.pass.program.work.charge("eligibility");
        const key =
          walk === null
            ? keptKeyAt(admission.pass.contract, group.root, stepsTo(path, length))
            : walk.prefix(length);
        const rest = keptStepsFrom(admission.work, path, length);
        const list = demands.get(key);
        if (list === undefined) demands.set(key, [rest]);
        else list.push(rest);
      }
    }
    admission.demands = demands;
  }
  // (a prefix in its identity, as the groups' prefixes hold it: G3 stage 1)
  return admission.demands.get(canonicalKey(admission.pass.contract, asked)) ?? [];
}

/**
 * Stores as their classes stand for them (§4.1): each store's class representative, from its key's own list, once
 * each, in source order; any other store as itself.
 */
function representatives(admission: Admission, list: readonly Definition[]): Definition[] {
  const out: Definition[] = [];
  const seen = new Set<Definition>();
  for (const d of list) {
    admission.pass.program.work.charge("indexSteps");
    if (d.kind === "whole" || d.kind === "add") wholeOf(admission, d.key, d.kind === "add");
    const representative = admission.representative.get(d) ?? d;
    if (seen.has(representative)) continue;
    seen.add(representative);
    out.push(representative);
  }
  return out;
}

/**
 * A5: the stores that brought a prefix's source, as candidates: live, no multi-site argument (F21) (a return, a
 * parameter default and a single-site argument are stores into the result or the parameter, F20–F23), and a read of
 * a host value only against a written type (a read of one below its store owes nothing
 * at a decided type: A7's whole-store exception leaves it the boundary check its own path's candidate owes, C9, and it
 * holds no kind and no `null`); the whole stores and the adds, once per set of stores.
 */
export function takeable(
  admission: Admission,
  stores: ReadonlySet<Definition | null>,
  byWritten: boolean,
): { readonly wholes: readonly Definition[]; readonly adds: readonly Definition[] } {
  let known = admission.takeables.get(stores);
  if (known === undefined) admission.takeables.set(stores, (known = []));
  const index = byWritten ? 1 : 0;
  const found = known[index];
  if (found !== undefined) return found;
  const { lists, program } = admission.pass;
  program.work.charge("indexSteps", stores.size);
  const wholes: Definition[] = [];
  const adds: Definition[] = [];
  for (const d of stores)
    if (
      d !== null &&
      (byWritten || !hostRead(admission, d.value)) &&
      lists.live(d) &&
      (d.how !== "argument" || lists.singleSite(d.fn)) &&
      !admission.besideDefault(d)
    )
      if (d.kind === "whole") wholes.push(d);
      else if (d.kind === "add") adds.push(d);
  wholes.sort((a, b) => admission.sourceOrder(a) - admission.sourceOrder(b));
  adds.sort((a, b) => admission.sourceOrder(a) - admission.sourceOrder(b));
  return (known[index] = {
    wholes: representatives(admission, wholes),
    adds: representatives(admission, adds),
  });
}

/** Whether a value is a read of a host value: external data, with no kind and no `null` at any path. */
export function hostRead(admission: Admission, value: PlaceId | undefined): boolean {
  const { program } = admission.pass;
  const binding = value === undefined ? undefined : program.occurrenceOf.get(value);
  return binding !== undefined && program.isHost(binding);
}

/**
 * §4.3's segment tree over a class's members in flow order: per leaf a guard count; per node its least count and,
 * among its leaves with it, the earliest member (the least index in the class's source order); range additions are
 * lazy. Every node a change visits is charged.
 */
class GuardTree {
  readonly #size: number;
  readonly #min: Int32Array;
  readonly #least: Int32Array;
  readonly #lazy: Int32Array;

  public constructor(
    /** The class's member index at each leaf. */
    private readonly members: readonly number[],
    private readonly work: WorkLedger,
  ) {
    this.#size = Math.max(1, members.length);
    this.#min = new Int32Array(4 * this.#size);
    this.#least = new Int32Array(4 * this.#size);
    this.#lazy = new Int32Array(4 * this.#size);
    this.#build(1, 0, this.#size - 1);
  }

  #build(node: number, low: number, high: number): void {
    this.work.charge("eligibility");
    if (low === high) {
      this.#least[node] = low < this.members.length ? low : -1;
      return;
    }
    const middle = (low + high) >> 1;
    this.#build(2 * node, low, middle);
    this.#build(2 * node + 1, middle + 1, high);
    this.#pull(node);
  }

  #pull(node: number): void {
    const left = 2 * node;
    const right = left + 1;
    const a = this.#min[left]!;
    const b = this.#min[right]!;
    if (a !== b) this.#least[node] = a < b ? this.#least[left]! : this.#least[right]!;
    else {
      const x = this.#least[left]!;
      const y = this.#least[right]!;
      this.#least[node] = x < 0 ? y : y < 0 ? x : this.members[x]! <= this.members[y]! ? x : y;
    }
    this.#min[node] = Math.min(a, b) + this.#lazy[node]!;
  }

  /** Adds `delta` to the counts of the leaves `low` to `high`. */
  public add(low: number, high: number, delta: number): void {
    this.#add(1, 0, this.#size - 1, low, high, delta);
  }

  #add(node: number, from: number, to: number, low: number, high: number, delta: number): void {
    this.work.charge("eligibility");
    if (high < from || to < low) return;
    if (low <= from && to <= high) {
      this.#min[node]! += delta;
      this.#lazy[node]! += delta;
      return;
    }
    const middle = (from + to) >> 1;
    this.#add(2 * node, from, middle, low, high, delta);
    this.#add(2 * node + 1, middle + 1, to, low, high, delta);
    this.#pull(node);
  }

  /** The leaf of the earliest member with no guard count, or `null`. */
  public eligible(): number | null {
    return this.#min[1] === 0 && this.#least[1]! >= 0 ? this.#least[1]! : null;
  }
}
