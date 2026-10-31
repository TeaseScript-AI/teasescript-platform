import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  isKeyId,
  keyIdPath,
  keptKeyBelowIn,
  keptKeyWalk,
  someStep,
  stepsArray,
  stepsOfId,
  type CanonicalKey,
} from "./contract/key-ids.js";
import { keptArray, keptParts, keptSlice, keptSteps } from "./budget.js";
import { carried, type Dispatch } from "./carriers.js";
import { heldReference, type IndexNode } from "./contract.js";
import { keyPath, recordPath } from "./definitions.js";
import { dictList } from "./method-categories.js";
import { propertyName } from "./program.js";
import type { Work } from "./solver.js";

/** A task of a property name search (`propertyNames`): a value at a path, a key, or a literal at a path. */
export type PropertyNamesTask =
  | { readonly value: PlaceId; readonly path: readonly string[] }
  | { readonly key: CanonicalKey }
  | { readonly literal: PlaceId; readonly path: readonly string[] };

/**
 * A task the search has taken up (`propertyNames`): its position on the search's chain and how many of its scheduling
 * task's last steps its own path keeps untouched, neither cut, changed nor read by the step between them (#1493's pump
 * bound).
 */
interface Visit {
  readonly at: PlaceId;
  /** Its kind and place as one number. */
  readonly slot: number;
  readonly path: readonly string[];
  readonly kept: number;
  /** Its position on the chain, the search's first task's 0. */
  readonly depth: number;
  /** The least `kept` of the last 2, 4, 8, ... visits on the chain down to it, its own included (a sparse table). */
  readonly least: readonly number[];
  /**
   * Its own kind and place's nearest visit above it and the least `kept` on the way down since; the shortest path among
   * it and its place's visits above it.
   */
  readonly same: Visit | null;
  readonly keptSince: number;
  readonly shortestSame: number;
}

/**
 * Test-only (`withNameRecords`): what the searches did, all of them together: the tasks they took up (a seen one too),
 * the prefixes they visited, the earlier tasks their pump checks walked and the longest such walk, the head steps those
 * checks compared, the longest path a task held, their path index's entries and longest chain, the tasks that pumped,
 * and the units of `checks` the ledger counted meanwhile.
 */
export interface NameRecords {
  tasks: number;
  prefixes: number;
  ancestors: number;
  depth: number;
  heads: number;
  longest: number;
  entries: number;
  chain: number;
  pumped: number;
  checks: number;
}

let recording: NameRecords | null = null;

/** Test-only: `run`'s result and what the property-name searches inside it did (`NameRecords`). */
export function withNameRecords<T>(run: () => T): {
  readonly result: T;
  readonly records: Readonly<NameRecords>;
} {
  if (recording !== null) throw new Error("Name records are already being recorded.");
  const records: NameRecords = {
    tasks: 0,
    prefixes: 0,
    ancestors: 0,
    depth: 0,
    heads: 0,
    longest: 0,
    entries: 0,
    chain: 0,
    pumped: 0,
    checks: 0,
  };
  recording = records;
  try {
    return { result: run(), records };
  } finally {
    recording = null;
  }
}

/** A task to take up, the visit that scheduled it, and how many of that visit's last steps it keeps untouched. */
interface Scheduled {
  readonly task: PropertyNamesTask;
  readonly from: Visit | null;
  readonly kept: number;
}

/**
 * The names of a value's known properties (S3 §1): those the keys below its sources store, and those the objects of
 * its literals and of the values its collections' adds insert have at its path. One worklist of sources, each once: a value read further at a path is followed
 * through its projections and the operations that pass a value on (the value side's transfers) to a copied key, a
 * call's result key or a literal; a key to its prefixes' stores and their sources' own stores; a literal to the
 * reads and calls standing at its path or above it. Each task it schedules and each prefix it visits is charged, and
 * every key, path and identity it keeps, through the kept helpers.
 *
 * #1493, the pump bound: each task has the task that scheduled it (`from`) and records how many of that one's last steps
 * its path keeps untouched (`kept`): a key's step at a stored prefix keeps the rest below it (an add's one step less), a
 * literal's at a depth the rest below that depth, a carrier's all but the two steps it reads, and a record path the
 * steps it leaves unchanged. A task pumps an earlier one on its chain where both are of one kind and place, its path is
 * longer, and it starts with that one's head: that one's path without the last steps no task between them touched (the
 * least `kept` on the way). Its own names are taken; its sources are not followed. Since every step reads and cuts a
 * bounded front of its path and pushes a bounded head, a chain of tasks that never ends holds such a pair, and from it
 * the same steps repeat forever, each turn longer (a feedback copy `w = r.z`: `w|`, `w|z`, `w|z.z`, ...); a search that
 * ends without the bound meets none, so its names are as before, whatever the answer at a key is, stopped or not. The
 * check walks only the new task's own kind and place's visits above it, one charge per visit, until none with a shorter
 * path is left, and compares heads only with those, one charge per step of the head. The worklist is a stack, so a
 * task's chain is the current depth-first path, its scheduling visit last (checked at each task taken up): the search
 * keeps that path, each kind and place's positions on it, and on each visit the least `kept` of the last 2, 4, 8, ...
 * visits down to it, so a visit finds its place's nearest visit above it and the least `kept` since in two reads. Each
 * visit is added once, removed at most once and makes at most ⌈log₂ D⌉ such entries on a chain of D visits, each
 * charged. The check's total: at most the new tasks times (2 + ⌈log₂ D⌉), plus their place's earlier tasks walked, plus
 * head steps each no longer than the earlier task's path.
 */
export function propertyNames(
  pass: CorePass,
  run: <T>(work: Work<T>) => T,
  start: PropertyNamesTask,
  /** Each object of a literal the value holds, with its names in the literal's order (a first property's question). */
  objects?: (literal: PlaceId, names: ReadonlySet<string>) => void,
): ReadonlySet<string> {
  const { program, contract, definitions } = pass;
  const work = program.work;
  const names = new Set<string>();
  const pending: Scheduled[] = [{ task: start, from: null, kept: 0 }];
  const seen = new Set<string>();
  // (the current depth-first path, the search's first visit first, and each kind and place's positions on it)
  const chain: Visit[] = [];
  const positions = new Map<number, number[]>();
  /** The least `kept` of the visits at positions `low` to `high` on the chain, from two of their sparse entries. */
  const leastKept = (low: number, high: number): number => {
    const level = 31 - Math.clz32(high - low + 1);
    const at = (position: number): number =>
      level === 0 ? chain[position]!.kept : chain[position]!.least[level - 1]!;
    return Math.min(at(high), at(low + 2 ** level - 1));
  };
  const checksBefore = recording === null ? 0 : (work.counts().get("checks") ?? 0);
  const dispatch: Dispatch = {
    kinds: (of) => new Set(run(contract.contractOfValue(of)).map((item) => item.tag)),
    reference: (receiver) => heldReference(run(contract.valueReceiver(receiver))),
    joined: (operand) => pass.lists.joined(operand),
  };
  /**
   * Whether a visit pumps one before it: the same kind and place, a longer path, that one's head before its untouched
   * tail. Only its place's visits above it are walked, through `same`, until none with a shorter path is left.
   */
  const pumps = (visit: Visit): boolean => {
    let tail = visit.keptSince;
    let depth = 0;
    for (
      let above = visit.same;
      above !== null && above.shortestSame < visit.path.length;
      above = above.same
    ) {
      work.charge("checks");
      if (recording !== null) {
        recording.ancestors += 1;
        recording.depth = Math.max(recording.depth, (depth += 1));
      }
      if (visit.path.length > above.path.length) {
        const head = above.path.length - Math.min(tail, above.path.length);
        work.charge("checks", head);
        if (recording !== null) recording.heads += head;
        let same = true;
        for (let index = 0; index < head && same; index += 1)
          same = visit.path[index] === above.path[index];
        if (same) return true;
      }
      tail = Math.min(tail, above.keptSince);
    }
    return false;
  };
  /** A path's record steps (`recordPath`), and how many of its last steps they keep unchanged. */
  const recorded = (
    path: readonly string[],
  ): { readonly path: readonly string[]; readonly kept: number } => {
    const record = recordPath(path);
    if (record === path) return { path, kept: path.length };
    let kept = 0;
    while (kept < path.length && path[path.length - 1 - kept] === record[record.length - 1 - kept])
      kept += 1;
    return { path: record, kept };
  };
  while (pending.length > 0) {
    const { task, from, kept } = pending.pop()!;
    const id =
      "key" in task
        ? keptParts(work, "k", task.key)
        : "literal" in task
          ? keptParts(work, `l${task.literal}`, task.path)
          : keptParts(work, `v${task.value}`, task.path);
    // (each task it schedules, a seen one too, whose identity it made)
    work.charge("checks");
    if (recording !== null) recording.tasks += 1;
    if (seen.has(id)) continue;
    seen.add(id);
    // (a key's path and place through its walk, `keptKeyWalk`: a text's kept, a cursor's steps through the charged
    // boundary and copied out once, G3 stage 1)
    const walk = "key" in task ? keptKeyWalk(contract, task.key) : null;
    const taken: readonly string[] = "key" in task ? stepsArray(walk!.path) : task.path;
    const at = "key" in task ? walk!.place : "literal" in task ? task.literal : task.value;
    const slot = at * 3 + ("key" in task ? 0 : "literal" in task ? 2 : 1);
    // (the chain back to the scheduling visit, each visit below it removed once, charged)
    // EVIDENCE: invariant: the worklist is a stack, so the visit that scheduled a task is on the current path.
    if (from === null ? chain.length > 0 : chain[from.depth] !== from)
      throw new Error(
        "A property-name task's scheduling visit is not on the search's current path.",
      );
    const position = from === null ? 0 : from.depth + 1;
    while (chain.length > position) {
      positions.get(chain.pop()!.slot)!.pop();
      work.charge("checks");
      if (recording !== null) recording.entries += 1;
    }
    let own = positions.get(slot);
    if (own === undefined) positions.set(slot, (own = []));
    const nearest = own.length === 0 ? null : own[own.length - 1]!;
    // (the visit added, charged, with its sparse entries: the least `kept` of the last 2, 4, 8, ... visits, each charged)
    const least: number[] = [];
    for (let level = 1; 2 ** level <= position + 1; level += 1) {
      const below = chain[position - 2 ** (level - 1)]!;
      least.push(
        Math.min(
          level === 1 ? kept : least[level - 2]!,
          level === 1 ? below.kept : below.least[level - 2]!,
        ),
      );
    }
    work.charge("checks", 1 + least.length);
    if (recording !== null) recording.entries += 1 + least.length;
    const same = nearest === null ? null : chain[nearest]!;
    const visit: Visit = {
      at,
      slot,
      path: taken,
      kept,
      depth: position,
      least,
      same,
      keptSince:
        nearest === null
          ? Number.POSITIVE_INFINITY
          : nearest + 1 === position
            ? kept
            : Math.min(kept, leastKept(nearest + 1, position - 1)),
      shortestSame: Math.min(taken.length, same?.shortestSame ?? taken.length),
    };
    chain.push(visit);
    own.push(position);
    if (recording !== null) recording.chain = Math.max(recording.chain, chain.length);
    if (recording !== null) recording.longest = Math.max(recording.longest, visit.path.length);
    // (a pumped task's own names are taken, its sources not followed)
    const follows = !pumps(visit);
    if (!follows && recording !== null) recording.pumped += 1;
    const schedule = (next: PropertyNamesTask, untouched: number): void => {
      if (follows) pending.push({ task: next, from: visit, kept: Math.max(0, untouched) });
    };
    if ("value" in task) {
      const { path } = task;
      const at = task.value;
      const source = contract.copiedKey(at) ?? contract.resultKey(at);
      // r4.46 (2): through a dict's `values` the projections are followed (a dict's values are its elements)
      // (a choice's selected value is read as its record's `value` or `text`, as the literal's records say: V30 §19)
      // (a cursor's path holds no dict's list where it holds no built-in member: the arena's, G3 stage 1)
      if (
        source !== null &&
        !(isKeyId(source)
          ? contract.pathMembers[keyIdPath(source)] !== 0 &&
            someStep(stepsOfId(contract, source), (step) => dictList(step) !== undefined)
          : keyPath(source).some((step) => dictList(step) !== undefined))
      ) {
        const record = recorded(path);
        schedule({ key: keptKeyBelowIn(contract, source, record.path) }, record.kept);
        continue;
      }
      if (program.hasOf.has(at)) {
        const record = recorded(path);
        schedule({ literal: at, path: keptArray(work, record.path) }, record.kept);
        continue;
      }
      // the carrier table's operands, after the value side's decisions (`carriers.ts`: F12, F27, r4.46 (2), F17b,
      // C10, F10, F7, a list's `+`, V30 §19's choice; nothing through an operation that keeps its own value, F19a)
      // (a carrier reads its path's first two steps at most, and keeps the rest)
      if (follows)
        for (const [operand, rest] of carried(program, at, path, dispatch))
          schedule({ value: operand, path: keptArray(work, rest) }, path.length - 2);
      continue;
    }
    if ("literal" in task) {
      // (the literal's index node at each prefix of the path, until one it holds none at)
      const nodes: IndexNode[] = [contract.literalIndex(task.literal).root];
      for (const step of task.path) {
        const below = nodes.at(-1)!.children.get(step);
        if (below === undefined) break;
        nodes.push(below);
      }
      for (const object of nodes.length > task.path.length
        ? (nodes.at(-1)!.objects?.list ?? [])
        : []) {
        objects?.(task.literal, object.names);
        for (const name of object.names) names.add(propertyName(name));
      }
      // the reads and calls standing at the path or above it, followed at the rest of the path (`standsAlong`)
      if (follows)
        for (const kind of ["reads", "others"] as const)
          for (const { depth, entries } of contract.standsAlong(task.literal, task.path, kind))
            for (const entry of entries)
              schedule(
                { value: entry.value, path: keptSlice(work, task.path, depth) },
                task.path.length - depth,
              );
      continue;
    }
    const key = task.key;
    const place = visit.at;
    const path = visit.path;
    for (const below of isKeyId(key) ? [] : definitions.keysBelow(key)) {
      const step = keyPath(below)[path.length];
      if (step !== undefined && step !== "element") names.add(propertyName(step));
    }
    if (!follows) continue;
    // (the prefixes whose stores can schedule a task are the stored keys along the path, `definitions.stored`: any
    // other prefix's frame holds no definition and its stores are empty. One step of the trie each, charged, the stored
    // key's own text, and the rest of the path below it kept and charged; no prefix key or path half is rebuilt)
    for (const { key: prefix, depth } of definitions.stored.along(place, path, true)) {
      work.charge("checks");
      if (recording !== null) recording.prefixes += 1;
      const rest = keptSlice(work, path, depth);
      const stores = contract.prefixStores(prefix);
      // the sources' own stores below their roots
      for (const sub of contract.subSources(stores))
        schedule({ key: keptKeyBelowIn(contract, sub, rest) }, rest.length);
      for (const entry of stores.list) {
        const at = keptSteps(work, entry.at ?? [], rest);
        if (entry.key !== undefined)
          schedule({ key: keptKeyBelowIn(contract, entry.key, at) }, rest.length);
        else if (entry.value !== undefined) schedule({ value: entry.value, path: at }, rest.length);
        // an added value stands at the collection's element, an `addAll`'s at its own (as `entryAt` reads it), never
        // at the collection itself
        else if (entry.elem !== undefined && rest[0] === "element")
          schedule(
            {
              value: entry.elem,
              path: keptSteps(work, entry.at ?? [], keptSlice(work, path, depth + 1)),
            },
            rest.length - 1,
          );
      }
    }
  }
  if (recording !== null) recording.checks += (work.counts().get("checks") ?? 0) - checksBefore;
  return names;
}
