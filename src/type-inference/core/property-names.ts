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
 * A task the search has taken up (`propertyNames`), with the one that scheduled it and how many of that one's last
 * steps its own path keeps untouched: neither cut, changed nor read by the step between them (#1493's pump bound).
 */
interface Visit {
  readonly kind: "key" | "value" | "literal";
  readonly at: PlaceId;
  readonly path: readonly string[];
  readonly from: Visit | null;
  readonly kept: number;
  /** The shortest path on its chain, its own included: no task above one no longer than it can be pumped by it. */
  readonly shortest: number;
}

/**
 * Test-only (`withNameRecords`): what the searches did, all of them together: the tasks they took up (a seen one too),
 * the prefixes they visited, the earlier tasks their pump checks walked and the longest such walk, the head steps those
 * checks compared, the longest path a task held, and the units of `checks` the ledger counted meanwhile.
 */
export interface NameRecords {
  tasks: number;
  prefixes: number;
  ancestors: number;
  depth: number;
  heads: number;
  longest: number;
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
 * #1493, the pump bound: each task records the task that scheduled it (`from`) and how many of that one's last steps
 * its path keeps untouched (`kept`): a key's step at a stored prefix keeps the rest below it (an add's one step less), a
 * literal's at a depth the rest below that depth, a carrier's all but the two steps it reads, and a record path the
 * steps it leaves unchanged. A task pumps an earlier one on its chain where both are of one kind and place, its path is
 * longer, and it starts with that one's head: that one's path without the last steps no task between them touched (the
 * least `kept` on the way). Its own names are taken; its sources are not followed. Since every step reads and cuts a
 * bounded front of its path and pushes a bounded head, a chain of tasks that never ends holds such a pair, and from it
 * the same steps repeat forever, each turn longer (a feedback copy `w = r.z`: `w|`, `w|z`, `w|z.z`, ...); a search that
 * ends without the bound meets none, so its names are as before, whatever the answer at a key is, stopped or not. The
 * check walks the new task's chain, one charge per earlier task, until no earlier task with a shorter path is left above
 * (each task records the shortest path on its chain), and compares heads only with earlier tasks of its kind and place,
 * one charge per step of the head: at most the new tasks times the longest chain in visits, plus head steps each no
 * longer than the earlier task's path.
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
  const checksBefore = recording === null ? 0 : (work.counts().get("checks") ?? 0);
  const dispatch: Dispatch = {
    kinds: (of) => new Set(run(contract.contractOfValue(of)).map((item) => item.tag)),
    reference: (receiver) => heldReference(run(contract.valueReceiver(receiver))),
    joined: (operand) => pass.lists.joined(operand),
  };
  /** Whether a visit pumps one before it: the same place, a longer path, that one's head before its untouched tail. */
  const pumps = (visit: Visit): boolean => {
    let tail = visit.kept;
    let depth = 0;
    // (only an earlier task with a shorter path can be pumped: the walk ends where none is left above)
    for (
      let above = visit.from;
      above !== null && above.shortest < visit.path.length;
      above = above.from
    ) {
      work.charge("checks");
      if (recording !== null) {
        recording.ancestors += 1;
        recording.depth = Math.max(recording.depth, (depth += 1));
      }
      if (
        above.kind === visit.kind &&
        above.at === visit.at &&
        visit.path.length > above.path.length
      ) {
        const head = above.path.length - Math.min(tail, above.path.length);
        work.charge("checks", head);
        if (recording !== null) recording.heads += head;
        let same = true;
        for (let index = 0; index < head && same; index += 1)
          same = visit.path[index] === above.path[index];
        if (same) return true;
      }
      tail = Math.min(tail, above.kept);
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
    const visit: Visit = {
      kind: "key" in task ? "key" : "literal" in task ? "literal" : "value",
      at: "key" in task ? walk!.place : "literal" in task ? task.literal : task.value,
      path: taken,
      from,
      kept,
      shortest: Math.min(taken.length, from?.shortest ?? taken.length),
    };
    if (recording !== null) recording.longest = Math.max(recording.longest, visit.path.length);
    // (a pumped task's own names are taken, its sources not followed)
    const follows = !pumps(visit);
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
    const path = visit.path;
    for (const below of isKeyId(key) ? [] : definitions.keysBelow(key)) {
      const step = keyPath(below)[path.length];
      if (step !== undefined && step !== "element") names.add(propertyName(step));
    }
    if (!follows) continue;
    for (let length = 0; length <= path.length; length += 1) {
      work.charge("checks");
      if (recording !== null) recording.prefixes += 1;
      const rest = path.slice(length);
      const stores = contract.prefixStores(walk!.prefix(length));
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
            { value: entry.elem, path: keptSteps(work, entry.at ?? [], rest.slice(1)) },
            rest.length - 1,
          );
      }
    }
  }
  if (recording !== null) recording.checks += (work.counts().get("checks") ?? 0) - checksBefore;
  return names;
}
