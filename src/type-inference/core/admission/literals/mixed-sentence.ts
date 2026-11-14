import type { PlaceId } from "../../../graph.js";
import type { Admission } from "../../admission.js";
import { joinSteps, keepText, keptSlice, keptText, pathText } from "../../budget.js";
import { operandsOf, type Strip } from "../../carriers.js";
import { typeTags } from "../../contract.js";
import { keyStepsIn, stepsArray } from "../../contract/key-ids.js";
import { keyPlace } from "../../definitions.js";
import { withoutEmpty } from "../../exact-path.js";
import type { FlowNode } from "../../flow-graph.js";
import { drive } from "../../inherited/inherited.js";
import type { MixedSteps } from "../../result.js";
import { earliestDecider } from "../scan.js";
import { holdsSource } from "../structure.js";
import { literalChildren } from "./stores.js";

/** One side's walk down a mixed error's path for a collection fact (`layersAt`'s), at the asked depths. */
export type CollectionWalk = (
  fact: "dict" | "set",
  path: readonly string[],
  depths: readonly number[],
) => boolean[];

/**
 * #1762, #1825: a mixed error's path as one side's sentence reads it: each `element` step below a dict its `entry` and
 * below a set its `member`, where that side's value there is one (`walk`, one walk down the path per collection);
 * admission's own path, which rejects and checks, unchanged. `member` is a sentence's word alone: no path, check or
 * key holds it.
 */
function shownSteps(path: readonly string[], walk: CollectionWalk): readonly string[] {
  const asked: number[] = [];
  for (let at = 0; at < path.length; at += 1) if (path[at] === "element") asked.push(at);
  const dicts = walk("dict", path, asked);
  const sets = walk("set", path, asked);
  let next = 0;
  return path.map((step) => {
    if (step !== "element") return step;
    const at = next++;
    return dicts[at] === true ? "entry" : sets[at] === true ? "member" : step;
  });
}

/**
 * #1762, #1825: each side's steps as its sentence writes them (`MixedSteps`), the earliest element's and the other's,
 * each by its own values: a list, a set and a dict may meet at one path (#1814); none where both are the
 * path.
 */
export function shownOf(
  path: readonly string[],
  earliest: CollectionWalk,
  other: CollectionWalk,
): { readonly shown?: MixedSteps } {
  const type = shownSteps(path, earliest);
  const kinds = shownSteps(path, other);
  return type.every((step, at) => step === path[at]) && kinds.every((step, at) => step === path[at])
    ? {}
    : { shown: { type, kinds } };
}

/**
 * #1765: whether each layer of a mixed element between the element and its leaf may hold null, the earliest element's
 * (`type`) and the other's (`kinds`), for the sentence's written type; `undefined` where none may.
 */
export interface MixedOptional {
  readonly type: readonly boolean[];
  readonly kinds: readonly boolean[];
}

/** The written decider's answer for a value at a node and path outside every decision (`earliestDecider`'s). */
type JoinDecider =
  ReturnType<typeof earliestDecider> extends Generator<unknown, infer R> ? R : never;
// (per admission, while no stop forgot an answer: per node, value and path)
const JOIN_DECIDERS = new WeakMap<
  Admission,
  {
    readonly forgets: number;
    readonly byNode: Map<FlowNode, Map<PlaceId, Map<string, JoinDecider>>>;
  }
>();

/**
 * #1828: `earliestDecider` of `value` at `node` and `steps` outside every decision, asked once while no stop forgot an
 * answer. A mixed join's operand is asked it by `decidedAt` and again by its sentence's walk (`mayHoldNull`); the
 * second ask takes the first's answer (#1899).
 */
export function joinDecider(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  steps: readonly string[],
): JoinDecider {
  const forgets = admission.pass.solver.forgets;
  let known = JOIN_DECIDERS.get(admission);
  if (known === undefined || known.forgets !== forgets)
    JOIN_DECIDERS.set(admission, (known = { forgets, byNode: new Map() }));
  let byValue = known.byNode.get(node);
  if (byValue === undefined) known.byNode.set(node, (byValue = new Map()));
  let byPath = byValue.get(value);
  if (byPath === undefined) byValue.set(value, (byPath = new Map()));
  const at = pathText(steps);
  if (byPath.has(at)) return byPath.get(at)!;
  const answer = drive(admission, earliestDecider(admission, value, node, steps, null));
  // (its key kept, charged as a structure's)
  keepText(admission.work, at.length);
  byPath.set(at, answer);
  return answer;
}

/**
 * #1765: whether a value may hold null at a layer, by its own form, one case per form, never by what a written copy's
 * items hold (#1789):
 * 1. at its own level (no step left), as it is read at its node (`occurrenceNull`); an `otherwise` by its tree, each leaf
 *    so read: its fallback's null where its operand may be null (`1 otherwise null` holds none: its fallback never runs;
 *    `null otherwise m` none where `m` holds `[1]`);
 * 2. a literal, by its children at the layer's next step, each by this same rule below;
 * 3. a carried value (the carrier table's: a projection's owner, an `otherwise`'s sides, a `get`'s receiver and default,
 *    a method's receiver, a dict's values, a `+` join's admitted operands), by each value it carries, at the path into
 *    it; an `otherwise`'s fallback only where its operand may be null;
 * 4. a written copy, by its term alone, whatever a rejected store put there, where it decides the layer from above (its
 *    parent layer's term is its too); a layer that is a copy's own level, as it is read there;
 * 5. another read or a call's result, by its place's admitted type where admission decides it;
 * 6. any other value (an undecided place's read, an operation's own result), by its own items.
 * Cases 2 and 3 compose: `layersOf` follows them, every layer of a path in one descent. This function answers the
 * others, a value at its own level or one neither a literal nor a carrier holds. A join has no case of its own: the
 * carrier table gives only its admitted operands (`joined`), so a rejected operand brings nothing (ADR 0021 1.1).
 */
function mayHoldNull(
  admission: Admission,
  at: PlaceId,
  from: FlowNode,
  steps: readonly string[],
): boolean {
  const { program, contract } = admission.pass;
  admission.work.charge("checks");
  if (steps.length === 0)
    // (an `otherwise`'s own null is its narrowed tree's; the operand's null is what the fallback replaces, #1819,
    // #1789)
    return program.opOf.get(at)?.kind === "fallback"
      ? operandNull(admission, at, from)
      : occurrenceNull(admission, at, from);
  const decided = holdsSource(admission, at) ? joinDecider(admission, at, from, steps) : null;
  // (a copy's term where the deciding copy stands above the layer, which lies below its own level: `b: string?[]` in
  // `[[1],b]`, `d`'s element in `held = d + [2]`; where the layer is the deciding copy's own level, `atom` in
  // `{v:atom}`, as it is read there, narrowed: #1819, #1901)
  if (decided !== null && decided.term !== null)
    return decided.own === true
      ? occurrenceNull(admission, at, from, steps)
      : typeTags(decided.term).includes("null");
  const key = contract.copiedKey(at) ?? contract.resultKey(at);
  if (key !== null) {
    const path = joinSteps(stepsArray(keyStepsIn(contract, key)), steps);
    const admitted = admission.admitted(keyPlace(key), path);
    // (no kind, or an unknown, decides nothing: `null` alone settles no type)
    if (admitted.length > 0 && !admitted.includes("unknown")) return admitted.includes("null");
  }
  return withoutEmpty(admission.run(contract.contractOfValueAt(at, steps))).some(
    (item) => item.tag === "null",
  );
}

/**
 * #1765: whether a value may be null as it is read at its node (at `steps` below it): its type allows null (its contract's items, which a
 * rejected store does not reach) and its items there, narrowed, hold null or an unknown no test guards (a typed host
 * value, #1819; under `!= null` its unknown is guarded). A written copy narrowed by its assignment or a
 * test holds none, as the current checker reads it.
 */
export function occurrenceNull(
  admission: Admission,
  at: PlaceId,
  from: FlowNode,
  steps: readonly string[] = [],
): boolean {
  return (
    withoutEmpty(admission.run(admission.pass.contract.contractOfValueAt(at, steps))).some(
      (item) => item.tag === "null",
    ) &&
    admission
      .items(at, from, steps)
      .some((item) => item.tag === "null" || (item.tag === "unknown" && item.guarded !== true))
  );
}

/**
 * #1765: whether an `otherwise`'s operand may be null at its node: its items there, narrowed as it is read (a written copy
 * narrowed by its assignment or a test never runs its fallback, as the current checker reads it); an operand that is
 * itself an `otherwise`, only where its operand and its fallback both may be. Each node's answer once per pass and node
 * (`NARROWED`), an `otherwise` after its operand and fallback, so a chain is walked once.
 */
function operandNull(admission: Admission, operand: PlaceId, from: FlowNode): boolean {
  const { program } = admission.pass;
  let byNode = NARROWED.get(admission.pass);
  if (byNode === undefined) NARROWED.set(admission.pass, (byNode = new Map()));
  let known = byNode.get(from);
  if (known === undefined) byNode.set(from, (known = new Map()));
  const open = [operand];
  while (open.length > 0) {
    const at = open.at(-1)!;
    if (known.has(at)) {
      open.pop();
      continue;
    }
    admission.work.charge("checks");
    const op = program.opOf.get(at);
    if (op?.kind !== "fallback") {
      known.set(at, occurrenceNull(admission, at, from));
      open.pop();
      continue;
    }
    const left = known.get(op.left);
    const right = known.get(op.right);
    if (left === false || right === false || (left === true && right === true)) {
      known.set(at, left === true && right === true);
      open.pop();
    } else open.push(left === undefined ? op.left : op.right);
  }
  return known.get(operand)!;
}

/** Per pass and node, whether an `otherwise`'s operand may be null there (`mayHoldNull`'s `operandNull`). */
const NARROWED = new WeakMap<object, Map<FlowNode, Map<PlaceId, boolean>>>();

/**
 * #1762, #1825: whether a value is a dict (or a set) there, by its contract's items, which compose its written and
 * carried terms: `a otherwise dict {}`, `a` a written dict holding a host value, is a dict, where its stored values
 * (`valueAt`) lose it (#1814).
 */
function collectionHeld(
  admission: Admission,
  at: PlaceId,
  steps: readonly string[],
  tag: "dict" | "set",
): boolean {
  return withoutEmpty(admission.run(admission.pass.contract.contractOfValueAt(at, steps))).some(
    (item) => item.tag === tag,
  );
}

/**
 * #1762, #1825: whether a value is a dict (or a set) at its own level: an `otherwise` its operand where the operand,
 * narrowed at its node, may hold a value, and its fallback where the operand may be null (a fallback never run names no
 * dict, nor an operand proved null, #1814); any other value by its items (`collectionHeld`) or its own
 * reads (a default). Each node's answer once per pass, collection and node (`COLLECTION_OWN`), a value after the sides
 * it takes, so a chain is walked once.
 */
function collectionOwn(
  admission: Admission,
  value: PlaceId,
  from: FlowNode,
  tag: "dict" | "set",
): boolean {
  const { program } = admission.pass;
  const memo = COLLECTION_OWN[tag];
  let byNode = memo.get(admission.pass);
  if (byNode === undefined) memo.set(admission.pass, (byNode = new Map()));
  let known = byNode.get(from);
  if (known === undefined) byNode.set(from, (known = new Map()));
  const open = [value];
  while (open.length > 0) {
    const at = open.at(-1)!;
    if (known.has(at)) {
      open.pop();
      continue;
    }
    admission.work.charge("checks");
    const op = program.opOf.get(at);
    // (any other value a dict by its items, or where an operand that is its own read is: a `get`'s, a `load`'s or a
    // parse's default, which hands the value on whole; its items lose a host-assigned written dict, #1814)
    const sides =
      op?.kind === "fallback"
        ? [
            ...(admission.items(op.left, from, []).some((item) => item.tag !== "null")
              ? [op.left]
              : []),
            ...(operandNull(admission, op.left, from) ? [op.right] : []),
          ]
        : collectionHeld(admission, at, [], tag)
          ? null
          : operandsOf(program, at)
              .filter((operand) => operand.own)
              .map((operand) => operand.operand);
    if (sides === null) {
      known.set(at, true);
      open.pop();
      continue;
    }
    const missing = sides.find((side) => !known.has(side));
    if (missing !== undefined) open.push(missing);
    else {
      known.set(
        at,
        sides.some((side) => known.get(side) === true),
      );
      open.pop();
    }
  }
  return known.get(value)!;
}

/** Per collection, pass and node, whether a value is one at its own level (`collectionOwn`). */
const COLLECTION_OWN = {
  dict: new WeakMap<object, Map<FlowNode, Map<PlaceId, boolean>>>(),
  set: new WeakMap<object, Map<FlowNode, Map<PlaceId, boolean>>>(),
};

/**
 * #1765: the depths of the collection layers strictly between a mixed error's elements (or its path's last property)
 * and its leaf, outermost first: the prefixes `optional` describes, by their lengths.
 */
export function intermediateDepths(path: readonly string[]): number[] {
  const property = path.findLastIndex((step) => step !== "element" && step !== "entry");
  const depths: number[] = [];
  for (let end = property + 2; end < path.length; end += 1) depths.push(end);
  return depths;
}

/**
 * #1765: whether each of `depths` along `path` holds `fact` for a side, read by one descent down the path (`layersOf`):
 * through a literal's children and through a carried value's parts alike (#1789). The facts' own levels and leaves,
 * side by side:
 * - `null` (#1765): `mayHoldNull`'s rule;
 * - `dict` (#1762) and `set` (#1825): `collectionOwn` at a value's own level, its items below it (`collectionHeld`).
 */
export function layersAt(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  path: readonly string[],
  depths: readonly number[],
  fact: "null" | "dict" | "set" = "null",
): boolean[] {
  return depths.length === 0 ? [] : layersOf(admission, value, node, path, depths, fact);
}

/**
 * A path below a value (`layersOf`), read without copying it: steps a carrier prepends (`head`), then the rest of an
 * outer view (`tail`), from `start`. A step past the head moves to the tail, so reading a step is constant work.
 */
interface Rope {
  readonly head: readonly string[];
  readonly tail: PathView | null;
}
interface PathView {
  readonly rope: Rope;
  readonly start: number;
  readonly length: number;
}

function viewStep(view: PathView, index: number): string | undefined {
  let at: PathView = view;
  let step = at.start + index;
  while (step >= at.rope.head.length && at.rope.tail !== null) {
    step -= at.rope.head.length;
    at = at.rope.tail;
    step += at.start;
  }
  return at.rope.head[step];
}

// (the view one step further, its head left once passed)
function viewRest(view: PathView): PathView {
  let at: PathView = { rope: view.rope, start: view.start + 1, length: view.length - 1 };
  while (at.start >= at.rope.head.length && at.rope.tail !== null) {
    const tail: PathView = at.rope.tail;
    at = { rope: tail.rope, start: tail.start + at.start - at.rope.head.length, length: at.length };
  }
  return at;
}

// (its first `count` steps, read once from the front)
function viewSteps(admission: Admission, view: PathView, count: number): readonly string[] {
  const out: string[] = [];
  let at: PathView | null = view;
  let from = view.start;
  while (at !== null && out.length < count) {
    const { head } = at.rope;
    for (let step = from; step < head.length && out.length < count; step += 1)
      out.push(head[step]!);
    at = at.rope.tail;
    from = at?.start ?? 0;
  }
  return keptSlice(admission.work, out, 0);
}

/**
 * A value's path in `layersOf`, as a `Strip` the carrier table transforms as it does steps: its view, the shift that
 * places the asked depths on it (`depths[i] + shift`), the first depth not yet answered above it (`next`), and its key,
 * made from its parent's and the step taken, so no key spells its path; `null` below a literal's step, where no key is
 * asked again.
 */
interface MarkedStrip extends Strip<MarkedStrip> {
  readonly view: PathView;
  readonly shift: number;
  readonly next: number;
  readonly key: number | null;
}

/**
 * Whether a value may hold null at each of `depths` along `path`, by one descent per pass: a depth at its own level and
 * every depth of a value no literal or carrier composes by `mayHoldNull`; a literal's depths below it by its children, a
 * carried value's by its parts (the carrier table's; an `otherwise`'s fallback only where its operand may be null, its
 * operand where it may hold a value), as `mayHoldNull` composes one path. Each frame is constant work: the depths stay
 * the asker's (each frame their shift and the first one left), the path a view, each answer written once. A value the
 * asker's own carriers reach, before any literal's step, has a key (`LAYERS`, its parent's key and one step, interned);
 * asked under a key it was asked under before, it keeps its answer per pass, so a join's growing operands are each read
 * once. Any other value writes each answer straight to the nearest value that keeps one, so no answer is copied along
 * a chain asked once. A value asked again while its own answer is pending adds nothing.
 */
function layersOf(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  path: readonly string[],
  depths: readonly number[],
  fact: "null" | "dict" | "set",
): boolean[] {
  const { program } = admission.pass;
  // (each fact its own answers per pass, #1762, #1825)
  const memos = fact === "null" ? LAYERS : fact === "dict" ? DICT_LAYERS : SET_LAYERS;
  let memo = memos.get(admission.pass);
  if (memo === undefined)
    memos.set(
      admission.pass,
      (memo = { keys: new Map(), answers: new Map(), seen: new Map(), count: { value: 0 } }),
    );
  const { keys, answers, seen, count } = memo;
  const intern = (parent: number | null, step: string): number | null => {
    if (parent === null) return null;
    admission.work.charge("checks");
    let mine = keys.get(parent);
    if (mine === undefined) keys.set(parent, (mine = new Map()));
    let key = mine.get(step);
    if (key === undefined) mine.set(step, (key = count.value += 1));
    return key;
  };
  const strip = (view: PathView, shift: number, next: number, key: number | null): MarkedStrip => {
    const made: MarkedStrip = {
      view,
      shift,
      next,
      key,
      length: view.length,
      at: (index) => viewStep(view, index),
      rest: () => {
        let left = next;
        while (left < depths.length && depths[left]! + shift - 1 < 0) left += 1;
        return strip(viewRest(view), shift - 1, left, intern(key, "rest"));
      },
      // (nothing prepended is the same path, and the same key: a join's operand is asked as its join is)
      under: (below) =>
        below.length === 0
          ? made
          : strip(
              { rope: { head: below, tail: view }, start: 0, length: view.length + below.length },
              shift + below.length,
              next,
              key === null ? null : intern(key, `under ${keptText(admission.work, below)}`),
            ),
    };
    return made;
  };
  // (where answers go: a set taken whole from the first answer that brings one, shared with it, and copied only where a
  // second must join it, so an answer kept along a chain is moved, not copied)
  class Sink {
    set: ReadonlySet<number> = EMPTY;
    private own = false;
    add(slot: number): void {
      if (this.set.has(slot)) return;
      // EVIDENCE: invariant: `own` is true only after this sink made `set` itself, a `Set` it may change.
      const mine = this.own ? (this.set as Set<number>) : new Set(this.set);
      mine.add(slot);
      this.set = mine;
      this.own = true;
    }
    take(answer: ReadonlySet<number>): void {
      if (answer.size === 0 || answer === this.set) return;
      if (this.set.size === 0) {
        this.set = answer;
        this.own = false;
        return;
      }
      for (const slot of answer) this.add(slot);
    }
  }
  // (a frame: its value, its path, the answers it keeps (`holds`: its own where it is kept, else those of the value that
  // keeps them), where they go, its parts, the next part)
  type Part = readonly [PlaceId, FlowNode, MarkedStrip];
  interface Frame {
    readonly at: PlaceId;
    readonly kept: boolean;
    readonly holds: Sink;
    readonly into: Sink;
    readonly strip: MarkedStrip;
    readonly parts: readonly Part[];
    next: number;
  }
  const pending = new Map<PlaceId, Set<number>>();
  const open = (
    at: PlaceId,
    from: FlowNode,
    here: MarkedStrip,
    into: Sink,
    kept: boolean,
  ): Frame => {
    admission.work.charge("checks");
    const literal = program.hasOf.has(at);
    const holds = kept ? new Sink() : into;
    let { next } = here;
    // (the depth at its own level, if one is)
    if (next < depths.length && depths[next]! + here.shift === 0) {
      if (
        fact === "null"
          ? mayHoldNull(admission, at, from, [])
          : collectionOwn(admission, at, from, fact)
      )
        holds.add(next);
      next += 1;
    }
    let parts: Part[] = [];
    if (next < depths.length) {
      const below = strip(here.view, here.shift, next, here.key);
      if (literal) {
        // (a literal's children: no key below its step)
        const rest = strip(viewRest(here.view), here.shift - 1, next, null);
        parts = literalChildren(admission, at, viewStep(here.view, 0)!).map(
          (child) => [child.value!, child.node ?? from, rest] as const,
        );
      } else {
        // (an `otherwise`'s operand where it may hold a value, its fallback where it may be null: a side never taken
        // brings nothing, #1814)
        const carried = admission.carriersBy(at, below);
        const operand = carried.find(([, , role]) => role === "otherwise/operand")?.[0];
        const falls = operand === undefined || operandNull(admission, operand, from);
        const taken =
          operand === undefined ||
          admission.items(operand, from, []).some((item) => item.tag !== "null");
        parts = carried
          .filter(
            ([, , role]) =>
              (role !== "otherwise/fallback" || falls) && (role !== "otherwise/operand" || taken),
          )
          .map(([part, path]) => [part, from, path] as const);
        // (a value no carrier composes: each depth by `mayHoldNull`, or its items for a dict, its path one read of the
        // longest)
        if (carried.length === 0) {
          const longest = viewSteps(admission, here.view, depths.at(-1)! + here.shift);
          for (let slot = next; slot < depths.length; slot += 1) {
            const steps = keptSlice(admission.work, longest, 0, depths[slot]! + here.shift);
            if (
              fact === "null"
                ? mayHoldNull(admission, at, from, steps)
                : collectionHeld(admission, at, steps, fact)
            )
              holds.add(slot);
          }
        }
      }
    }
    if (kept) {
      let mine = pending.get(at);
      if (mine === undefined) pending.set(at, (mine = new Set()));
      mine.add(here.key!);
    }
    return { at, kept, holds, into, strip: here, parts, next: 0 };
  };
  const out = new Sink();
  const root = strip(
    { rope: { head: path, tail: null }, start: 0, length: path.length },
    0,
    0,
    intern(-1, `${keptText(admission.work, path)}#${depths.join(",")}`),
  );
  const stack: Frame[] = [];
  // (a value asked under a key it was asked under before keeps its answer, read from then on; asked the first time, it
  // writes each answer straight to its asker's, so a chain asked once copies no answer)
  const ask = (at: PlaceId, from: FlowNode, here: MarkedStrip, into: Sink): void => {
    let kept = false;
    if (here.key !== null && !program.hasOf.has(at)) {
      const answer = answers.get(at)?.get(here.key);
      if (answer !== undefined) {
        into.take(answer);
        return;
      }
      if (pending.get(at)?.has(here.key) === true) return;
      let mine = seen.get(at);
      if (mine === undefined) seen.set(at, (mine = new Set()));
      kept = mine.has(here.key);
      mine.add(here.key);
    }
    stack.push(open(at, from, here, into, kept));
  };
  ask(value, node, root, out);
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.next < frame.parts.length) {
      const [at, from, here] = frame.parts[frame.next]!;
      frame.next += 1;
      ask(at, from, here, frame.holds);
      continue;
    }
    stack.pop();
    if (!frame.kept) continue;
    let mine = answers.get(frame.at);
    if (mine === undefined) answers.set(frame.at, (mine = new Map()));
    mine.set(frame.strip.key!, frame.holds.set);
    pending.get(frame.at)!.delete(frame.strip.key!);
    frame.into.take(frame.holds.set);
  }
  return depths.map((_, slot) => out.set.has(slot));
}

/** No answer: the set a `Sink` starts with. */
const EMPTY: ReadonlySet<number> = new Set();

/**
 * Per pass, `layersOf`'s keys (each a parent's and one step, interned) and the answer of each value the asker's own
 * carriers reach under its key, shared by every literal's and join's error.
 */
const LAYERS = new WeakMap<
  object,
  {
    readonly keys: Map<number, Map<string, number>>;
    readonly answers: Map<PlaceId, Map<number, ReadonlySet<number>>>;
    readonly seen: Map<PlaceId, Set<number>>;
    readonly count: { value: number };
  }
>();
/**
 * Per pass, `layersOf`'s keys and answers for the dict fact (#1762), as `LAYERS` holds the null fact's. Apart from
 * `SET_LAYERS`: the answers last the pass, so a later sentence over the same values (a growing join's) reads what an
 * earlier one kept, and a shared memo would give a set ask a dict answer (#2017).
 */
const DICT_LAYERS = new WeakMap<
  object,
  {
    readonly keys: Map<number, Map<string, number>>;
    readonly answers: Map<PlaceId, Map<number, ReadonlySet<number>>>;
    readonly seen: Map<PlaceId, Set<number>>;
    readonly count: { value: number };
  }
>();
/** Per pass, the same for the set fact (#1825), apart from `DICT_LAYERS` for the reason given there. */
const SET_LAYERS = new WeakMap<
  object,
  {
    readonly keys: Map<number, Map<string, number>>;
    readonly answers: Map<PlaceId, Map<number, ReadonlySet<number>>>;
    readonly seen: Map<PlaceId, Set<number>>;
    readonly count: { value: number };
  }
>();

export function mixedOptional(type: boolean[], kinds: boolean[]): MixedOptional | undefined {
  return type.includes(true) || kinds.includes(true) ? { type, kinds } : undefined;
}
