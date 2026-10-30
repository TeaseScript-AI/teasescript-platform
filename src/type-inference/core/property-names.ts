import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  isKeyId,
  keyIdPath,
  keptKeyBelowIn,
  keyWalk,
  someStep,
  stepsArray,
  stepsOfId,
  type CanonicalKey,
} from "./contract/key-ids.js";
import { keptArray, keptParts, keptSlice, keptSteps } from "./budget.js";
import { carried, type Dispatch } from "./carriers.js";
import { heldReference, type IndexNode } from "./contract.js";
import { keyPath, recordPath } from "./definitions.js";
import { REASON } from "./items.js";
import { dictList } from "./method-categories.js";
import { propertyName } from "./program.js";
import type { Work } from "./solver.js";

/** A task of a property name search (`propertyNames`): a value at a path, a key, or a literal at a path. */
export type PropertyNamesTask =
  | { readonly value: PlaceId; readonly path: readonly string[] }
  | { readonly key: CanonicalKey }
  | { readonly literal: PlaceId; readonly path: readonly string[] };

/**
 * The names of a value's known properties (S3 §1): those the keys below its sources store, and those the objects of
 * its literals and of the values its collections' adds insert have at its path. One worklist of sources, each once: a value read further at a path is followed
 * through its projections and the operations that pass a value on (the value side's transfers) to a copied key, a
 * call's result key or a literal; a key to its prefixes' stores and their sources' own stores; a literal to the
 * reads and calls standing at its path or above it. A key's copied sources are followed only where its answer may hold
 * an object, one the stop left undecided included (#1493). Each task it schedules and each prefix it visits is charged, and every key, path and identity it
 * keeps, through the kept helpers.
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
  const pending: PropertyNamesTask[] = [start];
  const seen = new Set<string>();
  const dispatch: Dispatch = {
    kinds: (of) => new Set(run(contract.contractOfValue(of)).map((item) => item.tag)),
    reference: (receiver) => heldReference(run(contract.valueReceiver(receiver))),
    joined: (operand) => pass.lists.joined(operand),
  };
  while (pending.length > 0) {
    const task = pending.pop()!;
    const id =
      "key" in task
        ? keptParts(work, "k", task.key)
        : "literal" in task
          ? keptParts(work, `l${task.literal}`, task.path)
          : keptParts(work, `v${task.value}`, task.path);
    // (each task it schedules, a seen one too, whose identity it made)
    work.charge("checks");
    if (seen.has(id)) continue;
    seen.add(id);
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
        pending.push({ key: keptKeyBelowIn(contract, source, recordPath(path)) });
        continue;
      }
      if (program.hasOf.has(at)) {
        pending.push({ literal: at, path: keptArray(work, recordPath(path)) });
        continue;
      }
      // the carrier table's operands, after the value side's decisions (`carriers.ts`: F12, F27, r4.46 (2), F17b,
      // C10, F10, F7, a list's `+`, V30 §19's choice; nothing through an operation that keeps its own value, F19a)
      for (const [operand, rest] of carried(program, at, path, dispatch))
        pending.push({ value: operand, path: keptArray(work, rest) });
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
      for (const kind of ["reads", "others"] as const)
        for (const { depth, entries } of contract.standsAlong(task.literal, task.path, kind))
          for (const entry of entries)
            pending.push({ value: entry.value, path: keptSlice(work, task.path, depth) });
      continue;
    }
    const key = task.key;
    // (a cursor's steps through the charged boundary, its prefixes its ancestors, no key below it a definition's: its
    // family's shape requires it, G3 stage 1)
    const walk = keyWalk(contract, key);
    const { path } = walk;
    for (const below of isKeyId(key) ? [] : definitions.keysBelow(key)) {
      const step = keyPath(below)[path.length];
      if (step !== undefined && step !== "element") names.add(propertyName(step));
    }
    // (#1493: a key whose answer proves it holds no object has no object a source copies into it to name properties of:
    // its own stores above name all it has. A feedback copy `w = r.z` stops here, where its path would otherwise grow by
    // a step each turn. A key a stop left undecided, a typed parse's nested path, proves nothing: its sources name its
    // properties as before, so a stop keeps the check the unstopped analysis makes, TABLE r4.100)
    if (
      !run(contract.contractOf(key)).some(
        (item) => item.tag === "object" || (item.reasons & REASON.budget) !== 0,
      )
    )
      continue;
    // (the tasks keep their paths: a cursor's steps copied out once)
    const steps = stepsArray(path);
    for (let length = 0; length <= path.length; length += 1) {
      work.charge("checks");
      const rest = steps.slice(length);
      const stores = contract.prefixStores(walk.prefix(length));
      // the sources' own stores below their roots
      for (const sub of contract.subSources(stores))
        pending.push({ key: keptKeyBelowIn(contract, sub, rest) });
      for (const entry of stores.list) {
        const at = keptSteps(work, entry.at ?? [], rest);
        if (entry.key !== undefined) pending.push({ key: keptKeyBelowIn(contract, entry.key, at) });
        else if (entry.value !== undefined) pending.push({ value: entry.value, path: at });
        // an added value stands at the collection's element, an `addAll`'s at its own (as `entryAt` reads it), never
        // at the collection itself
        else if (entry.elem !== undefined && rest[0] === "element")
          pending.push({ value: entry.elem, path: keptSteps(work, entry.at ?? [], rest.slice(1)) });
      }
    }
  }
  return names;
}
