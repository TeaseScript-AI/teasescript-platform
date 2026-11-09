// A4's answers through copies' landings: whether copies land a path in a place, and the place a place inherits through.
import type { PlaceId } from "../../../graph.js";
import type { Admission } from "../../admission.js";
import { joinParts, keep, keepText, keptParts, keptText } from "../../budget.js";
import {
  isKeyId,
  isPathSteps,
  keptStepsJoin,
  type KeyId,
  keyIdPath,
  type Steps,
  stepsFrom,
  stepsOfId,
  stepsText,
} from "../../contract/key-ids.js";
import { type Key, keyPath } from "../../definitions.js";
import { positions } from "../../positions.js";
import type { Inheritance, InheritedCopy, Storing } from "../model.js";
import { copiesAlong, copiesOf, copyForest, inheritance, nearest } from "./inheritance.js";

/**
 * The place whose inherited type a place's is at a path (`inheritedAt`): a place whose only store on the
 * path is one whole copy of an unwritten inheriting place, outside every cycle of copies, inherits there what that
 * place does (its scan finds the copy, whose type is that place's, and nothing beside it); so a chain of such copies
 * answers as its nearest member with a store on the path, or its top. Each copy storing its own field asks that member
 * directly, never every copy above it (the reviewer's control of a copy's own contribution).
 */
/** `passThrough` of a cursor: a place no copy forest holds answers itself; else its steps made (`stepsOfId`). */
export function passThroughKey(admission: Admission, place: PlaceId, key: KeyId): PlaceId {
  if (!copyForest(admission).parent.has(place)) return place;
  return passThrough(admission, place, stepsOfId(admission.pass.contract, key));
}

export function passThrough(admission: Admission, place: PlaceId, path: Steps): PlaceId {
  const forest = copyForest(admission);
  if (!forest.parent.has(place)) return place;
  const own = forest.stores.get(place);
  const lists: (Storing | undefined)[] = [];
  for (let length = 1; length <= path.length; length += 1) {
    admission.pass.program.work.charge("indexSteps");
    // (a record's prefix text through its record, `prefixText`; an array's made and charged as before)
    const text = isPathSteps(path)
      ? path.prefixText(length)
      : keptText(admission.work, path.slice(0, length));
    if (own?.has(text) === true) return place;
    lists.push(forest.storing.get(text));
  }
  return nearest(admission, place, lists);
}

/**
 * Whether copies land a path in a place (`Inheritance`): its own landings, else its copies' sources' landings below
 * their strips, on an explicit stack, each place and path asked once.
 */
/**
 * `landed` of a key in its identity: a cursor's past wrappers from its path's id (`landedFrontier`), its steps made only
 * where no wrapper is passed (G3 stage 1).
 */
export function landedKey(admission: Admission, place: PlaceId, key: Key): boolean {
  const { contract } = admission.pass;
  if (!isKeyId(key)) return landed(admission, place, keyPath(key));
  if (contract.pathDepths[keyIdPath(key)]! > 1 && positions()) {
    const frontier = landedFrontier(admission, place, keyIdPath(key));
    if (frontier.place !== place)
      return landedOwn(admission, frontier.place, contract.pathSteps(frontier.rest));
  }
  return landedOwn(admission, place, stepsOfId(contract, key));
}

export function landed(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  // (G3 3a: a path past wrappers lands as its frontier's rest lands in the frontier's read's binding, `landedFrontier`)
  if (path.length > 1 && positions()) {
    const frontier = landedFrontier(admission, place, admission.pass.contract.pathIdOf(path));
    if (frontier.place !== place)
      return landedOwn(admission, frontier.place, admission.pass.contract.pathSteps(frontier.rest));
  }
  return landedOwn(admission, place, path);
}

/**
 * G3 3a: where a place's path lands past wrappers (`landingHop`): each wrapper whose path goes on below its step lands
 * there what its read's binding lands at the rest; the binding and the rest (a path id) where no wrapper follows. Once
 * per place and path, from its parent's.
 */
function landedFrontier(
  admission: Admission,
  place: PlaceId,
  path: number,
): { readonly place: PlaceId; readonly rest: number } {
  const { contract } = admission.pass;
  const ids: number[] = [path];
  for (let id = ids[0]!; !admission.landedFrontiers.has(joinParts(place, id)) && id > 0;) {
    id = contract.pathParent(id);
    ids.push(id);
  }
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const id = ids[index]!;
    const memoKey = joinParts(place, id);
    if (admission.landedFrontiers.has(memoKey)) continue;
    keepText(admission.work, memoKey.length);
    if (id === 0) {
      admission.landedFrontiers.set(memoKey, { place, rest: 0 });
      continue;
    }
    const above = admission.landedFrontiers.get(joinParts(place, contract.pathParent(id)))!;
    const step = contract.pathLast(id);
    // (a rest of one step goes on below it: its wrapper hands the path on, keeping the new step)
    const hop =
      contract.pathDepth(above.rest) === 1
        ? landingHop(admission, above.place, contract.pathLast(above.rest))
        : null;
    admission.landedFrontiers.set(
      memoKey,
      hop === null
        ? { place: above.place, rest: contract.pathStep(above.rest, step) }
        : { place: hop, rest: contract.pathStep(0, step) },
    );
  }
  return admission.landedFrontiers.get(joinParts(place, ids[0]!))!;
}

/**
 * G3 3a: a wrapper's step as `landed` reads it, or `null`: the place answers through no copy above it and stands in no
 * cycle of copies; of the copies landing in it, one alone lies along a path through `step`, a copy of the wrapper's read
 * at `step` exactly, at its root (`Contract.wrapperHop`); no copy of a written type, and no copy of its own, lands
 * strictly below `step`. So a path through `step` and below it lands in the place as its rest lands in the read's
 * binding (`landedOwn`'s frames). Once per place and step.
 */
function landingHop(admission: Admission, place: PlaceId, step: string): PlaceId | null {
  const memoKey = joinParts(place, step);
  const known = admission.landingHops.get(memoKey);
  if (known !== undefined) return known;
  keepText(admission.work, memoKey.length);
  const { program, contract } = admission.pass;
  const { seeds, owned, cycleOf, fed, wholes } = inheritance(admission);
  program.work.charge("indexSteps");
  const hop = contract.wrapperHop(place, step);
  const binding = hop === null ? undefined : program.occurrenceOf.get(hop.read);
  let found: PlaceId | null = null;
  if (
    binding !== undefined &&
    !cycleOf.has(place) &&
    !fed.has(place) &&
    !wholes.has(place) &&
    passThrough(admission, place, [step]) === place
  ) {
    const steps = landingSteps(admission, place, seeds, owned);
    const along = steps.copies.get(step) ?? [];
    if (
      !steps.whole &&
      along.length === 1 &&
      along[0]!.path.length === 1 &&
      along[0]!.strip.length === 0 &&
      along[0]!.from === binding &&
      !steps.deeper.has(step)
    )
      found = binding;
  }
  admission.landingHops.set(memoKey, found);
  return found;
}

/**
 * A place's landings by their paths' first steps (`landingHop`): whether a copy lands at its root, the copies by their
 * paths' first steps, and the first steps of the paths of two steps or more its written copies and its own copies land
 * at. Once per place.
 */
function landingSteps(
  admission: Admission,
  place: PlaceId,
  seeds: Inheritance["seeds"],
  owned: Inheritance["owned"],
): {
  readonly whole: boolean;
  readonly copies: ReadonlyMap<string, readonly InheritedCopy[]>;
  readonly deeper: ReadonlySet<string>;
} {
  const known = admission.pass.receivingDomain.landingSteps.get(place);
  if (known !== undefined) return known;
  const work = admission.pass.program.work;
  let whole = false;
  const copies = new Map<string, InheritedCopy[]>();
  for (const copy of copiesOf(admission, place)) {
    work.charge("indexSteps");
    if (copy.path.length === 0) whole = true;
    else {
      const list = copies.get(copy.path[0]!);
      if (list === undefined) copies.set(copy.path[0]!, [copy]);
      else list.push(copy);
    }
  }
  const deeper = new Set<string>();
  for (const text of [...(seeds.get(place)?.keys() ?? []), ...(owned.get(place) ?? [])]) {
    work.charge("indexSteps");
    if (text.includes(".")) deeper.add(text.slice(0, text.indexOf(".")));
  }
  keep(admission.work, 1 + copies.size + deeper.size);
  const found = { whole, copies, deeper };
  admission.pass.receivingDomain.landingSteps.set(place, found);
  return found;
}

/** `landed` itself, for a place and path. */
function landedOwn(admission: Admission, place: PlaceId, path: Steps): boolean {
  const { seeds, owned, cycleOf, cycles, fed, wholes } = inheritance(admission);
  const work = admission.pass.program.work;
  const memo = admission.landedPaths;
  const frames: {
    readonly key: string;
    readonly path: Steps;
    readonly copies: readonly InheritedCopy[];
    next: number;
  }[] = [];
  // a place and path's answer where its own landings give it, else its frame, its copies' sources asked one by one;
  // a place that answers through its parent answers as the copy it answers through (`passThrough`); a record's steps
  // spelled by their record
  const open = (place: PlaceId, steps: Steps): boolean | null => {
    const at = steps.length === 0 ? place : passThrough(admission, place, steps);
    const text = stepsText(steps);
    const key = keptParts(admission.work, at, text);
    const known = memo.get(key);
    if (known !== undefined) return known;
    work.charge("indexSteps");
    const whole = wholes.get(at);
    const found =
      cycleOf.has(at) && !fed.has(at) && whole === undefined
        ? cycles.get(at)!.has(text)
        : (whole?.seeds ?? seeds.get(at))?.has(text) === true ||
          (whole?.owned ?? owned.get(at))?.has(text) === true ||
          (fed.has(at) && steps.length === 0) ||
          null;
    if (found !== null) memo.set(key, found);
    // (its copies above the path, looked up by its prefixes, Astra's review r2 B2)
    else
      frames.push({ key, path: steps, copies: copiesAlong(admission, at, steps, false), next: 0 });
    return found;
  };
  const first = open(place, path);
  if (first !== null) return first;
  const key = frames[0]!.key;
  let answer: boolean | null = null;
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    if (answer === true) {
      memo.set(frame.key, true);
      frames.pop();
      continue;
    }
    if (frame.next >= frame.copies.length) {
      memo.set(frame.key, false);
      frames.pop();
      answer = false;
      continue;
    }
    const copy = frame.copies[frame.next++]!;
    answer = open(
      copy.from,
      keptStepsJoin(admission.work, copy.strip, stepsFrom(frame.path, copy.path.length)),
    );
  }
  return memo.get(key)!;
}
