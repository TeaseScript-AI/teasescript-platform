import type { PlaceId } from "../../graph.js";
import { joinParts, joinSteps } from "../budget.js";
import type { Contract } from "../contract.js";
import {
  keyOf,
  keyPath,
  keyPlace,
  SELECTED_TEXT,
  SELECTED_VALUE,
  type Key,
} from "../definitions.js";
import {
  canonicalKey,
  isKeyId,
  isPathSteps,
  isSteps,
  keyAt,
  keyBelowIn,
  keyBelowRef,
  keyDepthIn,
  keyParentIn,
  keyPrefixIn,
  keyStepsIn,
  keyWalk,
  restFrom,
  restPart,
  restSteps,
  restTo,
  someStepOf,
  stepIndex,
  stepsArray,
  stepsFrom,
  stepsJoin,
  stepsRest,
  type KeyWalk,
  type Rest,
  type Steps,
} from "./key-ids.js";
import { withoutEmpty, withWriter } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { marked } from "../guards.js";
import {
  EMPTY,
  makeItem,
  marksOf,
  mergeItems,
  reasonContext,
  REASON,
  STOPPED,
  type ContextWord,
  type Item,
} from "../items.js";
import type { Decision, Work } from "../solver.js";
import type { ReadRoute } from "../values.js";
import {
  HELD_REFERENCE,
  heldReference,
  holdsBelow,
  hostAt,
  REFERENCE,
  unknownItem,
} from "./kinds.js";
import { entryGroups, groupsAt, prefixLevels } from "./levels.js";
import { annotated, marksAt } from "./marks.js";
import type { PrefixEntry } from "./model.js";
import { positionable, positioned, positionOf } from "./positions.js";
import { summaryCount, summaryItems } from "./prefix-index.js";
import { termAt, typeAtPath, typeKinds, writtenOf } from "./terms.js";
import { members } from "./value-kinds.js";

// The contract of a key (§3.2): its demand, its stores' and prefixes' contracts, its receivers, a read's contract.

/** `severalElements`'s answer as its demand's items: one item for several, none for fewer. */
const SEVERAL: readonly Item[] = Object.freeze([HELD_REFERENCE]);

/**
 * F19a (r4.44): a receiver's kinds (the input) and the choice, on its completed kinds, whether it holds a reference
 * kind, whose members are opaque: `HELD_REFERENCE` beside its kinds where it does. Inside a component it is made once
 * on the completed open solve, in which every receiver is read as a record (a prefix that holds only reference kinds
 * holds nothing a step below), and held for the second; so a receiver whose reference comes only round its own cycle
 * is a reference's.
 */
const RECEIVER: Decision = {
  choose: (input) => (input.some((item) => REFERENCE.has(item.tag)) ? "reference" : "other"),
  answer: (choice, input) => (choice === "reference" ? [...input, HELD_REFERENCE] : input),
};

/** What a step below an unknown holds: an unknown for the same reasons, from the same ingress (F15, C9). */
function belowUnknown(item: Item): Item {
  return makeItem("unknown", item.writer, {
    cert: item.cert,
    reasons: item.reasons,
    context: item.context,
    ...(item.ingress === undefined ? {} : { ingress: item.ingress }),
    ...(item.loose === true ? { loose: true } : {}),
    ...marksOf([item]),
  });
}

/** S3 §1's route of a literal's value at a path: the contract's past an element step over a copy (F12). */
export function literalRoute(
  contract: Contract,
  literal: PlaceId,
  rest: readonly string[],
  node: FlowNode | null,
): ReadRoute {
  return contract.overCopy.has(joinParts(literal, rest, node?.id ?? "-")) ? "contract" : "exact";
}

/** The contract of a key (§3.2): a demand, once per key and pass. */
export function* contractOf(contract: Contract, asked: Key): Work<readonly Item[]> {
  // (a key in its family's identity, a wrapper's its cursor: one demand per key, whoever made it)
  const key = canonicalKey(contract, asked);
  if (contract.keyStopped(key)) return STOPPED;
  const site = contract.pass.program.places[keyPlace(key)]?.site ?? null;
  return yield {
    key: joinParts("c", key),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    make: () => contractOfMade(contract, key),
  };
}

function* contractOfMade(contract: Contract, key: Key): Work<readonly Item[]> {
  const { program } = contract.pass;
  const place = keyPlace(key);
  const found = program.places[place];
  if (found === undefined) return [unknownItem(REASON.external)];
  // (a host's keys are text: its steps an array, no copy)
  if (program.isHost(place)) return hostAt(stepsArray(keyStepsIn(contract, key)));
  if (program.speakerPlaces.has(place)) return [unknownItem(REASON.opaque)];
  // G3 3a: a key past a wrapper, one step below its parent's position (a cursor's from the arena, no text)
  const path = isKeyId(key) ? null : keyPath(key);
  if (positionable(contract, key, path)) return yield positioned(contract, key, path);
  // a key through a member a built-in value answers by itself (a copy of `d.values`, of `date.year`)
  const items = yield* contract.keyThrough(key, 0);
  // a parameter's and a result's kinds come through their calls (F20–F22): marked so, as the guard mark travels
  return found.kind.kind === "parameter" || found.kind.kind === "result"
    ? items.map((item) => (item.tag === "empty" ? item : { ...item, called: true }))
    : items;
}

/** `keyThrough` at the step `at`, the first of the key's path from its `from` on that a built-in value answers. */
export function* keyListsAt(contract: Contract, key: Key, at: number): Work<readonly Item[]> {
  // (one prefix, found once per length, and the key read again as it is: a member chain reads each key at each of its
  // steps, so neither its prefixes are climbed nor the key rebuilt per step)
  const prefix = keyPrefixIn(contract, key, at);
  const receiver = yield* contract.receiverKinds(prefix);
  if (heldReference(receiver)) return yield* keyContract(contract, key);
  const path = keyStepsIn(contract, key);
  return yield* members(contract, path, at, receiver, (along, start) =>
    contract.keyThrough(
      along === path ? key : keyBelowIn(contract, prefix, stepsFrom(along, at)),
      start,
    ),
  );
}

/** The contract of a key from its stores and its prefixes' (§3.2). */
export function* keyContract(contract: Contract, asked: Key): Work<readonly Item[]> {
  const { program } = contract.pass;
  // (a key in its identity: the levels and the prefixes its walk reads are held by it, G3 stage 1)
  const key = canonicalKey(contract, asked);
  const walk = keyWalk(contract, key);
  const { place, path } = walk;
  const found = program.place(place);
  if (program.cellOwner.has(place) || program.hasOf.has(place))
    return yield* contract.contractOfLiteral(place, stepsRest(path));
  // F19a: a reference's member is opaque, whatever is stored through it
  const receiver = yield* receiverWalk(contract, walk);
  if (receiver.reference) return [unknownItem(REASON.opaque)];
  const written = writtenOf(found.kind);
  // F2, F22: the written type is the contract; the stores keep M. §3.2 (r4.9): it fixes the kinds, never removes the
  // mark of what is stored. An unrestricted written domain (`list`'s element) says what may be held, not what is: its
  // unknown is opaque, so every consumer owes its check (#1501, r4.215)
  if (written !== null) {
    const at = termAt(written, path);
    if (at !== null) {
      const stored = yield* contractAlong(contract, place, path, 0, receiver.floor, walk.prefix);
      const marks = marksOf(stored);
      const tags = typeKinds(at).map((tag) =>
        makeItem(tag, null, {
          ...marks,
          ...(tag === "unknown" ? { reasons: REASON.opaque } : {}),
          ...(marks.guarded === true ? { cert: "pos" } : {}),
        }),
      );
      return path.at(-1) === "element" && stored.some((item) => item.tag === "empty")
        ? [...tags, EMPTY]
        : tags;
    }
  }
  const along = yield* contractAlong(contract, place, path, 0, receiver.floor, walk.prefix);
  // below a prefix without a structure, what its unknowns and references hold there
  return mergeItems([...along, ...receiver.below], program.scope);
}

/** The contract's answer to a read (§3.2): every kind as an item, definite only by P3; the read's word. */
/**
 * TABLE §3.4, F12 (r4.48 (5)): whether an element read at the key's first element step is answered by the contract
 * there, that is where several element-contributing sources, or a literal with several elements, meet at that step;
 * a single exact contribution is no such meeting. Over the collection's own stores and every prefix's, as its
 * contract reads them; a copy's own elements by the same question; once per element step.
 */
export function* severalElements(contract: Contract, asked: Key): Work<boolean> {
  // (a key in its identity: a wrapper family's text read as its cursor, G3 stage 1)
  const key = canonicalKey(contract, asked);
  const walk = keyWalk(contract, key);
  const { place, path } = walk;
  const step = stepIndex(path, "element");
  if (step < 0) return false;
  const at = walk.prefix(step + 1);
  const site = contract.pass.program.places[place]?.site ?? null;
  // a demand per element step, so a chain of collections read from collections (a function's result returning
  // another's) is followed on the solver's explicit stack, and a copy cycle is solved as its component
  const several = yield {
    key: joinParts("s", at),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    make: () => severalWork(contract, at),
  };
  return several.length > 0;
}

function* severalWork(contract: Contract, at: Key): Work<readonly Item[]> {
  const walk = keyWalk(contract, at);
  // (the path ends with its element step: a record's below each prefix its view; an array's sliced)
  const whole = stepsRest(walk.path);
  let count = 0;
  for (let length = walk.path.length - 1; length >= 0 && count < 2; length -= 1) {
    contract.pass.program.work.charge("invSteps");
    const stored = contract.prefixStores(walk.prefix(length));
    const below = restFrom(whole, length);
    for (const entry of stored.list) {
      if (count >= 2) break;
      count += yield* elementsOf(contract, entry, below);
    }
    // (the prefix's layers' distinct sources with elements, counted to two by their summary, #1466; each by itself
    // where it declines)
    const several = count >= 2 ? 0 : yield* summaryCount(contract, stored, below);
    if (several !== null) count += several;
    else
      for (const sub of contract.relevantSubs(stored, below)) {
        if (count >= 2) break;
        contract.pass.program.work.charge("invSteps");
        if (withoutEmpty(yield* contract.subAt(sub.key, below)).length > 0) count += 1;
      }
  }
  return count >= 2 ? SEVERAL : [];
}

/** The elements one source entry gives at `below` (which ends with an element step), counted to two. */
function* elementsOf(contract: Contract, entry: PrefixEntry, below: Rest): Work<number> {
  const { program, definitions } = contract.pass;
  program.work.charge("invSteps");
  if (withoutEmpty(yield* contract.entryAt(entry, below)).length === 0) return 0;
  if (entry.key !== undefined)
    return (yield* contract.severalElements(keyBelowRef(contract, entry.key, below))) ? 2 : 1;
  if (entry.value === undefined || entry.elem !== undefined || !program.hasOf.has(entry.value))
    return 1;
  // a literal: its elements at the step, through its own fields and elements; a value it holds counts once
  // (the entry's own steps, then `below`'s, read by position: no copy of a record's steps)
  const own = entry.at ?? [];
  const length = own.length + below.length;
  let values: readonly PlaceId[] = [entry.value];
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    const step = index < own.length ? own[index]! : below.at(index - own.length)!;
    const next: PlaceId[] = [];
    for (const value of values) {
      program.work.charge("invSteps");
      const types = program.hasOf.get(value);
      if (types === undefined) {
        count += 1;
        continue;
      }
      for (const has of types) {
        const at = typeAtPath(has.type, [step]);
        if (at === null || !("place" in at)) continue;
        const cells = definitions.cellDefs.get(at.place) ?? [];
        if (index === length - 1) count += cells.length;
        else for (const d of cells) next.push(d.value!);
      }
    }
    if (count >= 2) return 2;
    values = next;
  }
  return Math.min(count, 2);
}

/**
 * P3's condition on where a read stands (`contractRead`): in live code a parameter, a result, or a place whose live
 * declaration is reached and dominates the read; in dead code a declared place.
 */
export function declaredBefore(contract: Contract, place: PlaceId, node: FlowNode): boolean {
  const { program, definitions, lists } = contract.pass;
  const kind = program.place(place).kind.kind;
  const declaration = definitions.declOf.get(place);
  return program.live(node)
    ? kind === "parameter" ||
        kind === "result" ||
        (declaration !== undefined &&
          lists.live(declaration) &&
          program.reached(declaration.node) &&
          program.dom.dominates(declaration.node, node))
    : declaration !== undefined;
}

export function* contractRead(
  contract: Contract,
  asked: Key,
  node: FlowNode,
  context: ContextWord,
  later = false,
): Work<readonly Item[]> {
  // (a key in its identity: a wrapper family's text read as its cursor, G3 stage 1)
  const key = canonicalKey(contract, asked);
  const { program } = contract.pass;
  const items = yield* contract.contractOf(key);
  const kinds = withoutEmpty(items);
  const walk = keyWalk(contract, key);
  const { place, path } = walk;
  // P3: one kind, not unknown, no guarded source, the root's declaration dominates the read. The dominance is a flow
  // fact, which dead code drops (X1): there a declared place's one known kind stays known, so an intrinsic violation
  // is the error it is in live code (AD-3), unless the kind came through a call (a parameter's, a result's, a copy of
  // one: `called`), whose marks a dead call's binding would give and does not (F21): that one stays possible
  let definite =
    kinds.length === 1 &&
    kinds[0]!.tag !== "unknown" &&
    kinds[0]!.guarded !== true &&
    declaredBefore(contract, place, node) &&
    (program.live(node) || kinds[0]!.called !== true);
  // every selection on the way holds an element
  for (let length = 1; length <= path.length && definite; length += 1)
    if (path.at(length - 1) === "element") {
      const elements = yield* contract.contractOf(walk.prefix(length));
      if (
        elements.length === 0 ||
        elements.some((item) => item.tag === "empty" || item.tag === "unknown")
      )
        definite = false;
    }
  // §3.4: an unknown's reason word comes before any X context: its own, and a deferred parameter's every item's
  const deferred = kinds.some(
    (item) => item.tag === "unknown" && (item.reasons & REASON.deferred) !== 0,
  );
  // §3.4: the word is the read's first failing condition; where `context` is a later condition's or the value's
  // arrival (`later`), an element read the contract answers fails X3 before it (r4.48 (5))
  const word: ContextWord = deferred
    ? "deferred-parameter"
    : later && stepIndex(path, "element") >= 0 && (yield* contract.severalElements(key))
      ? "member"
      : context;
  return items.map((item) =>
    item.tag === "empty"
      ? item
      : {
          ...item,
          cert: definite ? "def" : "pos",
          context: item.tag === "unknown" ? reasonContext(item.reasons) : word,
        },
  );
}

/** §3 step 1, F19a: a receiver on the key's path whose contract holds a reference kind (one object behind every alias). */
export function* refReceiver(contract: Contract, asked: Key): Work<boolean> {
  const key = canonicalKey(contract, asked);
  // G3 3b: a positioned key's parent's walk, one receiver more (`advance`); a cursor's parent the arena's
  const path = isKeyId(key) ? null : keyPath(key);
  const depth = path === null ? keyDepthIn(contract, key) : path.length;
  if (depth > 1 && positionable(contract, key, path)) {
    const parent =
      path === null ? keyParentIn(contract, key)! : keyOf(keyPlace(key), path.slice(0, -1));
    const from = yield* positionOf(contract, { key: parent, length: depth - 1 });
    if (from !== null) return !from.noRef || heldReference(yield* contract.receiverKinds(parent));
  }
  return (yield* receiverWalk(contract, keyWalk(contract, key))).reference;
}

/**
 * One walk of a key's receivers (its prefixes, each a `RECEIVER` demand): whether one is decided a reference's
 * (F19a, r4.44), and else the longest prefix whose kinds hold nothing a step below can be read from (none yet, or
 * only scalars, `null`, reference kinds and unknowns: no record or collection, `holdsBelow`), -1 for none, and what
 * a path below it holds instead (`below`: each unknown's own, `belowUnknown`, and a reference's member, the
 * runtime's). A path below such a value holds nothing else, so the contract asks no shorter prefix's stores: the
 * stores through a prefix are followed only for its record and collection alternatives, so a recursive projection is
 * not followed below a receiver without one (Astra B2, B2-r2, and the open solve of r4.44, which reads every receiver
 * as a record); the read reruns when the prefix gains a kind with a structure (C5 reports a member read the kinds
 * lack).
 */
function* receiverWalk(
  contract: Contract,
  walk: KeyWalk,
): Work<{ readonly reference: boolean; readonly floor: number; readonly below: readonly Item[] }> {
  const { path } = walk;
  let floor = -1;
  let below: readonly Item[] = [];
  for (let length = 0; length < path.length; length += 1) {
    contract.pass.program.work.charge("invSteps");
    const items = yield* contract.receiverKinds(walk.prefix(length));
    if (heldReference(items)) return { reference: true, floor, below };
    if (!items.some(holdsBelow)) {
      floor = length;
      below = [
        ...items.filter((item) => item.tag === "unknown").map(belowUnknown),
        ...(items.some((item) => REFERENCE.has(item.tag)) ? [unknownItem(REASON.opaque)] : []),
      ];
    }
  }
  return { reference: false, floor, below };
}

/** A receiver's contract as a demand of its own, with F19a's decision whether it is a reference's (r4.44). */
export function* receiverKinds(contract: Contract, asked: Key): Work<readonly Item[]> {
  const key = canonicalKey(contract, asked);
  const site = contract.pass.program.places[keyPlace(key)]?.site ?? null;
  return yield {
    key: joinParts("rc", key),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    make: () => contract.contractOf(key),
    decision: RECEIVER,
  };
}

/**
 * A value's contract as a receiver (a method's, a length's owner), a demand of its own with F19a's decision (r4.44):
 * the one decision both sides take before an exact answer or a transfer's alternatives.
 */
export function* valueReceiver(contract: Contract, receiver: PlaceId): Work<readonly Item[]> {
  const site = contract.pass.program.places[receiver]?.site ?? null;
  return yield {
    key: joinParts("cv", receiver),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    make: () => contract.contractOfValue(receiver),
    decision: RECEIVER,
  };
}

/**
 * The definitions of a key and of its prefixes from the prefix of length `from` on (0: every one, the key's contract;
 * 1: a replaced source's own stores below its root, which `prefixStores` keeps apart from the root's whole stores),
 * none at or below `floor`, the longest prefix that holds nothing below it (`receiverWalk`).
 */
function* contractAlong(
  contract: Contract,
  place: PlaceId,
  path: Steps,
  from: number,
  floor = -1,
  prefixOf: (length: number) => Key = (length) =>
    isPathSteps(path)
      ? keyAt(contract, place, path.to(length))
      : keyOf(place, path.slice(0, length)),
): Work<Item[]> {
  const { program, definitions, lists } = contract.pass;
  const out: Item[] = [];
  // (a record's path read below each prefix as its view; an array sliced as before)
  const whole: Rest = stepsRest(path);
  for (let length = path.length; length >= from && length > floor; length -= 1) {
    const prefix = prefixOf(length);
    const rest = restFrom(whole, length);
    if (rest.length > 0) {
      // a prefix's whole stores, shared by every property below it; its literals by level (§4.6), each group of the
      // same structure below the path once (with a selection step, every entry by itself)
      const stores = contract.prefixStores(prefix);
      if (someStepOf(rest, (step) => step === SELECTED_VALUE || step === SELECTED_TEXT))
        for (const entry of stores.list)
          for (const item of yield* contract.entryAt(entry, rest)) out.push(item);
      else {
        const levels = prefixLevels(contract, prefix, stores);
        for (const group of entryGroups(contract, levels)) {
          const first = yield* contract.entryAt(group.entries[0]!, rest);
          // (an unknown's ingress stores are each entry's own, C9: there every entry answers by itself)
          if (
            group.entries.length > 1 &&
            !first.some((item) => item.tag === "unknown" || item.fan !== undefined)
          ) {
            for (const item of withWriter(first, group.w)) out.push(item);
            continue;
          }
          for (const item of first) out.push(item);
          for (const entry of group.entries.slice(1))
            for (const item of yield* contract.entryAt(entry, rest)) out.push(item);
        }
        if (levels.base.length > 0)
          for (const group of groupsAt(contract, prefix, levels.base, rest))
            out.push(
              ...annotated(
                contract,
                group,
                rest,
                withWriter(
                  yield* contract.contractOfValueAt(
                    group.literal,
                    isSteps(rest) ? joinSteps(group.at, rest) : rest.after(group.at),
                  ),
                  group.w,
                ),
              ),
            );
      }
      // a replaced source's own stores below the prefix, only where they lie: its layers' summary, their sources'
      // answers merged in order (#1466); where it declines, each source by itself, marked as its copies' entries are
      // (§3.2: a guarded read of a copy of it is a mark of its holder)
      const summary = yield* summaryItems(contract, stores, rest);
      if (summary !== null) for (const item of summary) out.push(item);
      else
        for (const sub of contract.relevantSubs(stores, rest)) {
          const items = yield* contract.subAt(sub.key, rest);
          out.push(
            ...(marksAt(contract, contract.keyIdentity(sub.key).holder, rest)
              ? marked(items)
              : items),
          );
        }
      continue;
    }
    for (const d of definitions.byKey.get(prefix) ?? []) {
      program.work.charge("invSteps");
      if (!lists.live(d)) continue;
      if (d.kind === "const") {
        out.push(...(d.items ?? []));
        continue;
      }
      // F5–F7: the collection's kind is unchanged
      if (d.kind !== "whole") continue;
      const parameter = program.place(place).kind;
      if (
        (d.how === "argument" || d.how === "parameter default") &&
        parameter.kind === "parameter" &&
        parameter.written === null &&
        !lists.singleSite(d.fn)
      )
        // F21: several sites
        out.push(unknownItem(REASON.deferred, definitions.writerOf(d)));
      out.push(
        ...withWriter(yield* contract.contractOfValueAt(d.value!, []), definitions.writerOf(d)),
      );
    }
  }
  return out;
}

/**
 * A projected source's stores below its path start after the path: a demand, once per source and path, whatever
 * number of its copies read there (r4.46 (3)).
 */
export function* subAt(contract: Contract, asked: Key, rest: Rest): Work<readonly Item[]> {
  // (a key in its identity: a wrapper family's text read as its cursor, G3 stage 1)
  const sub = canonicalKey(contract, asked);
  const site = contract.pass.program.places[keyPlace(sub)]?.site ?? null;
  return yield {
    key: joinParts("s", sub, restPart(rest)),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    make: () => subAtMade(contract, sub, rest),
  };
}

function* subAtMade(contract: Contract, sub: Key, rest: Rest): Work<readonly Item[]> {
  const { program } = contract.pass;
  program.work.charge("invSteps");
  if (!isKeyId(sub)) {
    const base = keyPath(sub);
    return mergeItems(
      yield* contractAlong(
        contract,
        keyPlace(sub),
        stepsJoin(base, restSteps(rest)),
        base.length + 1,
      ),
      program.scope,
    );
  }
  // (a cursor's keys below it its children, never a text: `keyBelowRef`; its path and the rest's joined, a record's
  // steps, `stepsJoin`)
  const walk = keyWalk(contract, sub);
  const base = walk.path;
  return mergeItems(
    yield* contractAlong(
      contract,
      walk.place,
      stepsJoin(base, restSteps(rest)),
      base.length + 1,
      -1,
      (length) => keyBelowRef(contract, sub, restTo(contract, rest, length - base.length)),
    ),
    program.scope,
  );
}
