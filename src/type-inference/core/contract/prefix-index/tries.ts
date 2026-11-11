// The persistent tries the layers are made of: step-keyed maps, support nodes and their union, positions.

import { joinParts } from "../../budget.js";
import type { Contract } from "../../contract.js";
import { type Key } from "../../definitions.js";
import { withoutEmpty } from "../../exact-path.js";
import {
  firstWriter,
  itemsSignature,
  mergeItems,
  REASON,
  type Item,
  type Writer,
} from "../../items.js";
import type { PrefixNode, PresenceStep, SupportNode } from "../model.js";
import { amend, Retained } from "../../retained/retained.js";

/** A layer's leaf in a set of layers, by its number (`SubLayer.self`), the sets ordered as the layers were made. */
export function setLeaf(contract: Contract, id: number): SupportNode {
  return {
    id: made(contract, 0),
    bit: Infinity,
    key: numberKey(id),
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
    layer: id,
  };
}

/**
 * A step's key in a step map: its number, given at its first listing in a layer and kept (`Contract.stepNumbers`), as two
 * code units (`numberKey`), so a map's depth follows the number of its steps, never their texts' bits.
 */
export function stepKey(contract: Contract, step: string): string {
  let id = contract.stepNumbers.get(step);
  if (id === undefined) {
    contract.stepNumbers.set(step, (id = contract.stepNumbers.size));
    contract.keep(1);
  }
  return numberKey(id);
}

/** A step's key if a layer lists it anywhere (`stepKey`), else `null`: no map has it. */
function listedKey(contract: Contract, step: string): string | null {
  const id = contract.stepNumbers.get(step);
  return id === undefined ? null : numberKey(id);
}

/** A step map's leaf: a step's key (`stepKey`) mapped to a set of layers, once per key and set. */
function mapLeaf(contract: Contract, key: string, value: SupportNode): SupportNode {
  let bySet = contract.mapLeaves.get(key);
  if (bySet === undefined)
    contract.mapLeaves.set(key, (bySet = Retained.map("Contract.mapLeaves[]")));
  const known = bySet.get(value.id);
  if (known !== undefined) return known;
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key,
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
    value,
  };
  bySet.set(value.id, leaf);
  return leaf;
}

/**
 * A step map of `steps`' keys (`stepKey`), in their bits' order, each mapped to `value`: built at once, one branch
 * where the keys part, never a path made again per step. On an explicit stack, as deep as the keys' bits part.
 */
export function mapOf(
  contract: Contract,
  steps: readonly string[],
  value: SupportNode,
): SupportNode | null {
  if (steps.length === 0) return null;
  const results: SupportNode[] = [];
  // (a run of steps to map, or two runs' maps to join at the bit they part at)
  const tasks: (readonly [number, number, number?])[] = [[0, steps.length - 1]];
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    const [from, to, split] = task;
    if (split !== undefined) {
      const right = results.pop()!;
      results.push(supportBranch(contract, split, results.pop()!, right));
      continue;
    }
    if (from === to) {
      results.push(mapLeaf(contract, steps[from]!, value));
      continue;
    }
    const at = firstDifference(contract, steps[from]!, steps[to]!);
    // (the run shares every bit above `at`, so its steps with a 0 there come first: the first with a 1 found by halves)
    let low = from + 1;
    let high = to;
    while (low < high) {
      contract.pass.program.work.charge("invSteps");
      const middle = (low + high) >> 1;
      if (bitOf(steps[middle]!, at) === 1) high = middle;
      else low = middle + 1;
    }
    tasks.push([from, to, at], [low, to], [from, low - 1]);
  }
  return results.pop()!;
}

/**
 * An overlay's step on its stack: a map and the map laid over it, or an overlay waiting for its children's, with the
 * bit it parts at and the child it keeps unchanged on either side.
 */
type OverlayTask =
  | {
      readonly base: SupportNode | null;
      readonly over: SupportNode | null;
      readonly bit?: undefined;
    }
  | {
      readonly base: SupportNode;
      readonly over: SupportNode;
      readonly bit: number;
      readonly left: SupportNode | null;
      readonly right: SupportNode | null;
    };

/**
 * `base` with `over`'s steps mapped as `over` maps them instead: down to where the two part and no further, every node
 * of either that the other has no key under shared. On an explicit stack, as deep as the steps' bits part.
 */
export function overlay(
  contract: Contract,
  base: SupportNode | null,
  over: SupportNode | null,
): SupportNode | null {
  const results: (SupportNode | null)[] = [];
  const tasks: OverlayTask[] = [{ base, over }];
  // (no memo: a layer's own map, laid over, is its own alone)
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.bit !== undefined) {
      const right = task.right ?? results.pop()!;
      const left = task.left ?? results.pop()!;
      results.push(supportBranch(contract, task.bit, left!, right!));
      continue;
    }
    const { base: under, over: top } = task;
    if (top === null || under === null || under === top) {
      results.push(top ?? under);
      continue;
    }
    const split = firstDifference(contract, under.key, top.key);
    if (split < Math.min(under.bit, top.bit))
      results.push(
        bitOf(under.key, split) === 0
          ? supportBranch(contract, split, under, top)
          : supportBranch(contract, split, top, under),
      );
    else if (under.bit === Infinity && top.bit === Infinity) results.push(top);
    else if (under.bit === top.bit)
      tasks.push(
        { base: under, over: top, bit: under.bit, left: null, right: null },
        { base: under.right, over: top.right },
        { base: under.left, over: top.left },
      );
    else if (under.bit < top.bit) {
      // (the map parting first holds the other whole on one side)
      const leftward = bitOf(top.key, under.bit) === 0;
      tasks.push(
        {
          base: under,
          over: top,
          bit: under.bit,
          left: leftward ? null : under.left,
          right: leftward ? under.right : null,
        },
        { base: leftward ? under.left : under.right, over: top },
      );
    } else {
      const leftward = bitOf(under.key, top.bit) === 0;
      tasks.push(
        {
          base: under,
          over: top,
          bit: top.bit,
          left: leftward ? null : top.left,
          right: leftward ? top.right : null,
        },
        { base: under, over: leftward ? top.left : top.right },
      );
    }
  }
  return results.pop() ?? null;
}

/** The set of layers a step map names for `step`, or `null`: down its key's bits (`stepKey`), each node charged. */
export function mapGet(
  contract: Contract,
  map: SupportNode | null,
  step: string,
): SupportNode | null {
  const key = listedKey(contract, step);
  if (key === null) return null;
  let at = map;
  for (; at !== null && at.bit !== Infinity; at = bitOf(key, at.bit) === 0 ? at.left : at.right)
    contract.pass.program.work.charge("invSteps");
  return at !== null && at.key === key ? (at.value ?? null) : null;
}

// #1466: a layer answers a path once, from its own sources and the answers of the layers below it, as a support of
// source keys shared by every layer above it: a persistent binary radix tree, by the bits of the keys' UTF-16 code units
// (`SupportNode`), whose equal sets are one node, so a stack of k copies joined two by two keeps O(k log k) nodes and
// links, never a list of sources per layer.

/** A key's bit `at`: per code unit a lead bit (1 within the key, 0 past its end) and its 16 bits, highest first. */
function bitOf(key: string, at: number): number {
  const unit = Math.floor(at / 17);
  if (unit >= key.length) return 0;
  const offset = at % 17;
  return offset === 0 ? 1 : (key.charCodeAt(unit) >> (16 - offset)) & 1;
}

/** The first bit two keys differ at (`bitOf`), `Infinity` where they are one; the code units compared charged. */
function firstDifference(contract: Contract, a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let unit = 0;
  while (unit < length && a.charCodeAt(unit) === b.charCodeAt(unit)) unit += 1;
  contract.pass.program.work.charge("invSteps", 1 + (unit >> 3));
  if (unit === length) return a.length === b.length ? Infinity : unit * 17;
  return unit * 17 + Math.clz32(a.charCodeAt(unit) ^ b.charCodeAt(unit)) - 15;
}

/** A node made: its id, counted with what it keeps (a branch its two children). */
function made(contract: Contract, edges: number): number {
  contract.keep(1 + edges);
  contract.facts.supportEdges += edges;
  amend(contract.facts);
  return contract.facts.supportNodes++;
}

/** A source's leaf in a support of sources alone, once per source. */
export function supportLeaf(contract: Contract, sub: Key): SupportNode {
  const known = contract.supportLeaves.get(sub);
  if (known !== undefined) return known;
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key: sub,
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
  };
  contract.supportLeaves.set(sub, leaf);
  return leaf;
}

/**
 * A source's leaf in a summary, once per source and content: its items in their order with everything a reader can
 * tell apart, its ingress stores by their nodes (C9), the text charged as its items' signature is and kept where new.
 */
export function summaryLeaf(contract: Contract, sub: Key, items: readonly Item[]): SupportNode {
  const content = items
    .map((item) =>
      joinParts(
        itemsSignature([item], contract.pass.program.scope),
        item.ingress === undefined ? -1 : item.ingress.id,
      ),
    )
    .join(",");
  let bySub = contract.summaryLeaves.get(sub);
  if (bySub === undefined)
    contract.summaryLeaves.set(sub, (bySub = Retained.map("Contract.summaryLeaves[]")));
  const known = bySub.get(content);
  if (known !== undefined) return known;
  contract.keepText(content.length);
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key: sub,
    left: null,
    right: null,
    items,
    count: withoutEmpty(items).length > 0 ? 1 : 0,
    presence: presenceSteps(items),
  };
  bySub.set(content, leaf);
  return leaf;
}

/** The branch of two nodes that part at `bit`, the lesser keys left, once per bit and children; a summary's merged. */
function supportBranch(
  contract: Contract,
  bit: number,
  left: SupportNode,
  right: SupportNode,
): SupportNode {
  let byLeft = contract.supportBranches.get(bit);
  if (byLeft === undefined)
    contract.supportBranches.set(bit, (byLeft = Retained.map("Contract.supportBranches[]")));
  let byRight = byLeft.get(left.id);
  if (byRight === undefined)
    byLeft.set(left.id, (byRight = Retained.map("Contract.supportBranches[][]")));
  const known = byRight.get(right.id);
  if (known !== undefined) return known;
  contract.pass.program.work.charge("invSteps");
  const summary = left.items !== null && right.items !== null;
  const branch: SupportNode = {
    id: made(contract, 2),
    bit,
    key: left.key,
    left,
    right,
    items: summary
      ? mergeItems([...left.items!, ...right.items!], contract.pass.program.scope)
      : null,
    count: Math.min(2, left.count + right.count),
    presence: summary ? thenPresence(left.presence!, right.presence!) : null,
  };
  byRight.set(right.id, branch);
  return branch;
}

/**
 * One key in both nodes: a step map's step with the union of its two sets of layers; a summary's source with its two
 * contents merged in the order the nodes were made.
 */
function mergedLeaf(contract: Contract, a: SupportNode, b: SupportNode): SupportNode {
  if (a.value !== undefined)
    return mapLeaf(contract, a.key, union(contract, a.value, b.value ?? null)!);
  const [first, then] = a.id < b.id ? [a, b] : [b, a];
  return summaryLeaf(
    contract,
    first.key,
    mergeItems([...first.items!, ...then.items!], contract.pass.program.scope),
  );
}

/**
 * A union's step on its stack: two nodes to unite, or a union waiting for its children's, with the bit it parts at and
 * the child it keeps unchanged where only one is asked.
 */
type UnionTask =
  | { readonly a: SupportNode | null; readonly b: SupportNode | null; readonly bit?: undefined }
  | {
      readonly a: SupportNode;
      readonly b: SupportNode;
      readonly bit: number;
      readonly kept: SupportNode | null;
      readonly keptLeft: boolean;
    };

/**
 * The union of two supports, each pair of nodes once per pass, down to where they part and no further: equal subtrees
 * are one node, so a union stops at what both share. On an explicit stack, as deep as the keys' bits part.
 */
export function union(
  contract: Contract,
  first: SupportNode | null,
  second: SupportNode | null,
): SupportNode | null {
  const results: (SupportNode | null)[] = [];
  const tasks: UnionTask[] = [{ a: first, b: second }];
  const remember = (a: SupportNode, b: SupportNode, node: SupportNode): void => {
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    let byHigh = contract.supportUnions.get(low.id);
    if (byHigh === undefined)
      contract.supportUnions.set(low.id, (byHigh = Retained.map("Contract.supportUnions[]")));
    byHigh.set(high.id, node);
    contract.keep(1);
    contract.facts.supportEdges += 1;
    amend(contract.facts);
    results.push(node);
  };
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.bit !== undefined) {
      const right = task.kept !== null && !task.keptLeft ? task.kept : results.pop()!;
      const left = task.kept !== null && task.keptLeft ? task.kept : results.pop()!;
      remember(task.a, task.b, supportBranch(contract, task.bit, left, right));
      continue;
    }
    const { a, b } = task;
    if (a === null || b === null || a === b) {
      results.push(a ?? b);
      continue;
    }
    const known = contract.supportUnions.get(Math.min(a.id, b.id))?.get(Math.max(a.id, b.id));
    if (known !== undefined) {
      results.push(known);
      continue;
    }
    // (every key of a node shares its first key's bits above the node's own bit)
    const split = firstDifference(contract, a.key, b.key);
    if (split < Math.min(a.bit, b.bit)) {
      const [left, right] = bitOf(a.key, split) === 0 ? [a, b] : [b, a];
      remember(a, b, supportBranch(contract, split, left, right));
    } else if (a.bit === Infinity && b.bit === Infinity) remember(a, b, mergedLeaf(contract, a, b));
    else if (a.bit === b.bit)
      tasks.push(
        { a, b, bit: a.bit, kept: null, keptLeft: false },
        { a: a.right, b: b.right },
        { a: a.left, b: b.left },
      );
    else {
      // (the node parting first holds the other whole on one side)
      const [upper, lower] = a.bit < b.bit ? [a, b] : [b, a];
      const leftward = bitOf(lower.key, upper.bit) === 0;
      tasks.push(
        { a, b, bit: upper.bit, kept: leftward ? upper.right : upper.left, keptLeft: !leftward },
        { a: leftward ? upper.left : upper.right, b: lower },
      );
    }
  }
  return results.pop() ?? null;
}

/**
 * C5c's reading of one source (`propertyPresence`): from each incoming state (lacks 1, has 2), the state after its
 * items; once a source lacks the property and one has it, no further source is read. An empty source supplies no
 * object; a source without the property gives `missing`, an unknown value of a present property says nothing of it.
 */
export function presenceSteps(all: readonly Item[]): readonly PresenceStep[] {
  const items = withoutEmpty(all);
  let mask = 0;
  let unknown = false;
  let literal: Writer | null = null;
  for (const item of items)
    if (item.tag === "unknown" && (item.reasons & REASON.missing) !== 0) {
      mask |= 1;
      literal = firstWriter(literal, item.writer);
    }
  if (items.some((item) => !(item.tag === "unknown" && item.reasons === REASON.missing))) mask |= 2;
  if (items.some((item) => item.tag === "unknown" && item.reasons !== REASON.missing))
    unknown = true;
  return [0, 1, 2, 3].map((from) =>
    from === 3 || items.length === 0
      ? { mask: from, unknown: false, literal: null }
      : { mask: from | mask, unknown, literal },
  );
}

/** Reading two runs of sources in turn: from each incoming state, the first's step, then the second's from there. */
function thenPresence(
  first: readonly PresenceStep[],
  then: readonly PresenceStep[],
): readonly PresenceStep[] {
  return first.map((step) => {
    const next = then[step.mask]!;
    return {
      mask: next.mask,
      unknown: step.unknown || next.unknown,
      literal: firstWriter(step.literal, next.literal),
    };
  });
}

/** A number's key in a set (a layer's, a position's): two code units, so the keys' bits order the numbers. */
function numberKey(at: number): string {
  return String.fromCharCode(at >>> 16, at & 0xffff);
}

/** A position's leaf in a set of positions of a prefix's layers (`topAt`), once per position. */
export function positionLeaf(contract: Contract, at: number): SupportNode {
  const known = contract.positionLeaves.get(at);
  if (known !== undefined) return known;
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key: numberKey(at),
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
    layer: at,
  };
  contract.positionLeaves.set(at, leaf);
  return leaf;
}

/** A set of positions' positions, in order, each node visited and charged. */
export function positionsIn(contract: Contract, set: SupportNode): number[] {
  const out: number[] = [];
  const stack = [set];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    contract.pass.program.work.charge("invSteps");
    if (node.left === null) out.push(node.layer!);
    else stack.push(node.right!, node.left);
  }
  return out;
}

/** A map node seen under a set of positions, once per node and set. */
export function viewOf(contract: Contract, inner: SupportNode, positions: SupportNode): PrefixNode {
  let bySet = contract.prefixViews.get(inner.id);
  if (bySet === undefined)
    contract.prefixViews.set(inner.id, (bySet = Retained.map("Contract.prefixViews[]")));
  const known = bySet.get(positions.id);
  if (known !== undefined) return known;
  const view: PrefixNode = { id: made(contract, 2), kind: "view", inner, positions };
  bySet.set(positions.id, view);
  return view;
}

/**
 * An operand of a prefix union (`prefixUnion`): a prefix map's node, or a layer's map node seen under a set of positions
 * not yet made a view (`viewOf`), as the descent meets one inside a view; made a view only where the union keeps it.
 */
type PrefixOperand =
  | PrefixNode
  | { readonly kind: "seen"; readonly inner: SupportNode; readonly positions: SupportNode };

const prefixBit = (node: PrefixOperand): number =>
  node.kind === "view" || node.kind === "seen"
    ? node.inner.bit
    : node.kind === "branch"
      ? node.bit
      : Infinity;
const prefixKey = (node: PrefixOperand): string =>
  node.kind === "view" || node.kind === "seen" ? node.inner.key : node.key;

/** An operand as a prefix map's node: a seen map node made a view. */
function prefixNode(contract: Contract, node: PrefixOperand): PrefixNode {
  return node.kind === "seen" ? viewOf(contract, node.inner, node.positions) : node;
}

/** An operand's two children: a view's or a seen node's are its inner node's, seen under the same positions. */
function prefixChildren(node: PrefixOperand): readonly [PrefixOperand, PrefixOperand] {
  if (node.kind === "branch") return [node.left, node.right];
  if (node.kind === "leaf") throw new Error("A prefix map's leaf has no children.");
  return [
    { kind: "seen", inner: node.inner.left!, positions: node.positions },
    { kind: "seen", inner: node.inner.right!, positions: node.positions },
  ];
}

/** One step in two parts naming different sets: a leaf joining them, enumerated where the step is read (`prefixAt`). */
function prefixLeaf(contract: Contract, a: PrefixOperand, b: PrefixOperand): PrefixNode {
  return {
    id: made(contract, 2),
    kind: "leaf",
    key: prefixKey(a),
    first: prefixNode(contract, a),
    second: prefixNode(contract, b),
  };
}

/** A prefix map's branch at `bit`. */
function prefixBranch(
  contract: Contract,
  bit: number,
  left: PrefixOperand,
  right: PrefixOperand,
): PrefixNode {
  contract.pass.program.work.charge("invSteps");
  const [low, high] = [prefixNode(contract, left), prefixNode(contract, right)];
  return {
    id: made(contract, 2),
    kind: "branch",
    bit,
    key: prefixKey(low),
    left: low,
    right: high,
  };
}

/** A prefix union's step on its stack, as `UnionTask`'s. */
type PrefixTask =
  | { readonly a: PrefixOperand | null; readonly b: PrefixOperand | null; readonly bit?: undefined }
  | { readonly bit: number; readonly kept: PrefixOperand | null; readonly keptLeft: boolean };

/**
 * The union of two prefix maps, once per pair of maps: two views of one map node are one view under both sets of
 * positions, never descended, so the union descends only where its layers' maps part, through their nodes as seen
 * (`PrefixOperand`), and makes views only of the nodes it keeps. On an explicit stack.
 */
export function prefixUnion(
  contract: Contract,
  first: PrefixNode | null,
  second: PrefixNode | null,
): PrefixNode | null {
  if (first === null || second === null || first === second) return first ?? second;
  const known = contract.prefixUnions
    .get(Math.min(first.id, second.id))
    ?.get(Math.max(first.id, second.id));
  if (known !== undefined) return known;
  const results: PrefixOperand[] = [];
  const tasks: PrefixTask[] = [{ a: first, b: second }];
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.bit !== undefined) {
      const right = task.kept !== null && !task.keptLeft ? task.kept : results.pop()!;
      const left = task.kept !== null && task.keptLeft ? task.kept : results.pop()!;
      results.push(prefixBranch(contract, task.bit, left, right));
      continue;
    }
    const { a, b } = task;
    if (a === null || b === null || a === b) {
      results.push((a ?? b)!);
      continue;
    }
    const seenA = a.kind === "view" || a.kind === "seen";
    const seenB = b.kind === "view" || b.kind === "seen";
    if (seenA && seenB && a.inner === b.inner) {
      results.push({
        kind: "seen",
        inner: a.inner,
        positions: union(contract, a.positions, b.positions)!,
      });
      continue;
    }
    const [aBit, bBit] = [prefixBit(a), prefixBit(b)];
    const split = firstDifference(contract, prefixKey(a), prefixKey(b));
    if (split < Math.min(aBit, bBit)) {
      const [left, right] = bitOf(prefixKey(a), split) === 0 ? [a, b] : [b, a];
      results.push(prefixBranch(contract, split, left, right));
    } else if (aBit === Infinity && bBit === Infinity) results.push(prefixLeaf(contract, a, b));
    else if (aBit === bBit) {
      const [aLeft, aRight] = prefixChildren(a);
      const [bLeft, bRight] = prefixChildren(b);
      tasks.push(
        { bit: aBit, kept: null, keptLeft: false },
        { a: aRight, b: bRight },
        { a: aLeft, b: bLeft },
      );
    } else {
      // (the node parting first holds the other whole on one side)
      const [upper, lower] = aBit < bBit ? [a, b] : [b, a];
      const [upperLeft, upperRight] = prefixChildren(upper);
      const leftward = bitOf(prefixKey(lower), prefixBit(upper)) === 0;
      tasks.push(
        { bit: prefixBit(upper), kept: leftward ? upperRight : upperLeft, keptLeft: !leftward },
        { a: leftward ? upperLeft : upperRight, b: lower },
      );
    }
  }
  const united = prefixNode(contract, results.pop()!);
  const [low, high] = first.id < second.id ? [first, second] : [second, first];
  let byHigh = contract.prefixUnions.get(low.id);
  if (byHigh === undefined)
    contract.prefixUnions.set(low.id, (byHigh = Retained.map("Contract.prefixUnions[]")));
  byHigh.set(high.id, united);
  contract.keep(1);
  return united;
}

/**
 * A prefix map's sets under `step`, each with its positions: down its bits to a view of a layer's map, read there to the
 * step's set, or to the step's leaf joining parts (`prefixLeaf`), whose parts are read only when asked; each node
 * charged. Empty for none.
 */
export function prefixAt(
  contract: Contract,
  map: PrefixNode | null,
  step: string,
): (() => (readonly [SupportNode, SupportNode])[]) | null {
  const work = contract.pass.program.work;
  const key = listedKey(contract, step);
  if (key === null) return null;
  for (let at = map; at !== null;) {
    work.charge("invSteps");
    if (at.kind === "view") {
      const set = mapGet(contract, at.inner, step);
      const positions = at.positions;
      return set === null ? null : () => [[set, positions]];
    }
    if (at.kind === "leaf") {
      if (at.key !== key) return null;
      const leaf = at;
      return () => {
        const out: (readonly [SupportNode, SupportNode])[] = [];
        // (each position in one part: a layer's map names one set per step; a part is a view of a map's leaf)
        const stack: PrefixNode[] = [leaf];
        for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
          work.charge("invSteps");
          if (node.kind === "leaf") stack.push(node.second, node.first);
          else if (node.kind === "view") out.push([node.inner.value!, node.positions]);
        }
        return out;
      };
    }
    at = bitOf(key, at.bit) === 0 ? at.left : at.right;
  }
  return null;
}
