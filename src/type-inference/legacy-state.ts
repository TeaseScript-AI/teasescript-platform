import type { AssignmentStatement, Expression } from "../ast.js";
import type { SourceSpan } from "../source.js";
import {
  isCollection,
  members,
  resolved,
  type OpenType,
  type StaticType,
} from "../static-types.js";
import type { Declaration } from "../static-types/origins.js";

// The state that the legacy type inference carries from one check of the project to the next, and the helpers that
// decide what it carries (see `legacy-rounds.ts`). A check decides the types of places from the first value stored in
// them, in checking order; what a later check must start with, so that reads before that value see the type, is
// recorded here and replayed. None of it is a language rule: it implements the discovery of the current inference,
// and goes with it (owner decision O4, 2026-10-17).

/**
 * The variables, elements, and properties that one of their assignments gives a non-whole number, with the first such
 * assignment: by the declaration of the variable that holds them, then by their path in it (see {@link PlacePath}).
 */
export type Widened = Map<Declaration, Map<string, SourceSpan>>;

/**
 * The places still undecided when a read saw them, such as a property that so far took only null, with the type and
 * site of the store that later decided them: by the declaration of the variable that holds them, then by their path.
 */
export type Decided = Map<Declaration, Map<string, Decision>>;

/**
 * The places that are a copy of another variable's place taken while that place was undecided, with that variable's
 * name: by the declaration of the variable that holds them, then by their path.
 */
export type Copies = Map<Declaration, Map<string, string>>;

/**
 * The `otherwise` expressions, and the assignments to a variable of unknown type, whose value counted as null so far
 * where they were checked, but which a later value decided in a way that a next check cannot start with: their result
 * keeps that value's place (see {@link fallbackType}).
 */
export type KeptFallbacks = Set<Expression | AssignmentStatement>;

/**
 * The names of custom speaker properties that a store may reach through a speaker the compiler cannot tell apart, such
 * as a parameter or the speaker of a message, or through a value of unknown type. Such a store is not checked, so no
 * speaker keeps a type for a property of that name: its reads stay of unknown type, which a known place checks when the
 * script runs (ADR 0021 rule 1.7), and stores into it are not checked.
 */
export type UncheckedProperties = Set<string>;

/** The type that decided a slot, and the store that decided it. */
export interface Decision {
  readonly type: StaticType;
  readonly at: SourceSpan;
}

/**
 * For each given slot, the slot whose own first value decided it by the end of a check, or `null`. A slot shares the decision of the slot it was copied from, since it may hold what that slot held (ADR 0021
 * rule 1.2), and of a still undecided place stored in it, such as `a = b` while `b` took only null. Of all decisions it
 * shares this way, the first in checking order decides, also around a cycle of copies. Every slot is visited once, so a
 * whole chain of copies and stores needs no check per step.
 */
export function decidingSlots(slots: readonly OpenType[]): {
  readonly deciding: Map<OpenType, OpenType | null>;
  /** For a slot that shares no decision, where a value the compiler cannot know reached it, if one did. */
  readonly unknown: Map<OpenType, SourceSpan>;
} {
  const starts = [...new Set(slots)];
  // The slots each one shares decisions with, found from the given ones, and those a value of their own decided.
  const sharers = new Map<OpenType, OpenType[]>();
  const own: OpenType[] = [];
  const seen = new Set<OpenType>(starts);
  const work = [...starts];
  while (work.length > 0) {
    const slot = work.pop()!;
    const shared: OpenType[] = [];
    if (slot.copiedFrom !== undefined) shared.push(slot.copiedFrom);
    if (slot.resolved !== null) {
      const stored = storedPlace(slot);
      if (stored === undefined) own.push(slot);
      else shared.push(stored);
    }
    for (const next of shared) {
      const list = sharers.get(next) ?? [];
      list.push(slot);
      sharers.set(next, list);
      if (!seen.has(next)) {
        seen.add(next);
        work.push(next);
      }
    }
  }
  const deciding = new Map<OpenType, OpenType | null>();
  own.sort((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity));
  for (const decider of own) {
    const reached = [decider];
    while (reached.length > 0) {
      const slot = reached.pop()!;
      if (deciding.has(slot)) continue;
      deciding.set(slot, decider);
      for (const sharer of sharers.get(slot) ?? []) reached.push(sharer);
    }
  }
  for (const slot of starts) if (!deciding.has(slot)) deciding.set(slot, null);
  // A value the compiler cannot know reaches what shares the slot it was stored in, as a decision would.
  const unknown = new Map<OpenType, SourceSpan>();
  for (const holder of seen) {
    if (holder.heldUnknown === undefined) continue;
    const reached = [holder];
    while (reached.length > 0) {
      const slot = reached.pop()!;
      if (unknown.has(slot)) continue;
      unknown.set(slot, holder.heldUnknown);
      for (const sharer of sharers.get(slot) ?? []) reached.push(sharer);
    }
  }
  return { deciding, unknown };
}

/**
 * The undecided slot of a type that so far held only null, such as the type of `v` after `let v = null` once nothing
 * narrows it any more, or `undefined` for any other type. A value that a later store gives may still decide the slot.
 */
export function nullOnlySlot(type: StaticType): OpenType | undefined {
  let slot: OpenType | undefined;
  let sawNull = false;
  for (const member of members(type)) {
    const value = resolved(member);
    if (value.kind === "null") sawNull = true;
    else if (
      value.kind === "open" &&
      slot === undefined &&
      value.resolved === null &&
      value.heldUnknown === undefined
    )
      slot = value;
    else return undefined;
  }
  return slot !== undefined && (sawNull || slot.sawNull) ? slot : undefined;
}

/**
 * Whether an undecided slot held only null to the end of a check: no value decided it or a slot it was copied from, and
 * none of them took a value the compiler cannot know. `known` keeps the answer for each slot walked, so a chain of copies
 * that many slots share is walked once.
 */
export function heldOnlyNull(slot: OpenType, known: Map<OpenType, boolean>): boolean {
  const walked = new Set<OpenType>();
  let only = true;
  for (
    let current: OpenType | undefined = slot;
    current !== undefined;
    current = current.copiedFrom
  ) {
    const seen = known.get(current);
    if (seen !== undefined) {
      only = seen;
      break;
    }
    if (walked.has(current) || current.resolved !== null || current.heldUnknown !== undefined) {
      only = false;
      break;
    }
    walked.add(current);
  }
  for (const current of walked) known.set(current, only);
  return only;
}

/** The slot itself and the still undecided places stored in it, as far as they lead (see {@link decidingSlots}). */
export function storedIn(slot: OpenType): Set<OpenType> {
  const chain = new Set<OpenType>();
  for (let current: OpenType | undefined = slot; current !== undefined && !chain.has(current);) {
    chain.add(current);
    current = storedPlace(current);
  }
  return chain;
}

/**
 * The still undecided place whose value a decided slot holds, such as `b` after `a = b` while `b` took only null, or
 * `undefined` when a value of its own decided it.
 */
function storedPlace(slot: OpenType): OpenType | undefined {
  if (slot.resolved === null) return undefined;
  const parts = slot.resolved.kind === "union" ? slot.resolved.members : [slot.resolved];
  const open = parts.find((part): part is OpenType => part.kind === "open");
  return open !== undefined && parts.every((part) => part.kind === "open" || part.kind === "null")
    ? open
    : undefined;
}

/**
 * Whether a slot's decision may be replayed although parts of it are still undecided (see `recordDecisions`): only when
 * nothing it reaches through copies and decided slots holds itself, which each later check would decide one level
 * deeper, or held a value the compiler cannot know, which a new slot would forget. A value the compiler cannot know
 * that the slot itself held does not count: the next check stores it again, into the decided type (#859). Each slot is
 * visited once.
 */
export function replayableDecisions(): (decider: OpenType) => boolean {
  /** For each visited slot, whether it reaches neither a cycle nor a value the compiler cannot know. */
  const verdicts = new Map<OpenType, boolean>();
  return (decider) => {
    const onPath = new Set<OpenType>();
    const frames: { slot: OpenType; next: OpenType[]; clean: boolean }[] = [];
    const enter = (slot: OpenType, own = false): void => {
      onPath.add(slot);
      frames.push({ slot, next: slotEdges(slot), clean: own || slot.heldUnknown === undefined });
    };
    // The verdict on the slot's own value is not kept for a slot that reaches this one.
    const own = decider.heldUnknown !== undefined;
    if (own || !verdicts.has(decider)) enter(decider, own);
    let verdict = verdicts.get(decider);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const next = frame.next.pop();
      if (next === undefined) {
        frames.pop();
        onPath.delete(frame.slot);
        if (frame.slot === decider && own) verdict = frame.clean;
        else verdicts.set(frame.slot, frame.clean);
        // What a slot reaches, the slots that reach it reach too.
        if (!frame.clean && frames.length > 0) frames[frames.length - 1]!.clean = false;
      } else if (onPath.has(next) || verdicts.get(next) === false) frame.clean = false;
      else if (!verdicts.has(next)) enter(next);
    }
    return verdict ?? verdicts.get(decider)!;
  };
}

/** The slots a slot's type depends on: the one it was copied from, and those directly in the type that decided it. */
function slotEdges(slot: OpenType): OpenType[] {
  const edges: OpenType[] = slot.copiedFrom === undefined ? [] : [slot.copiedFrom];
  const pending: StaticType[] = slot.resolved === null ? [] : [slot.resolved];
  while (pending.length > 0) {
    const part = pending.pop()!;
    if (part.kind === "open") edges.push(part);
    else if (part.kind === "union") for (const member of part.members) pending.push(member);
    else if (isCollection(part)) pending.push(part.element);
    else if (part.kind === "object" && part.properties !== null)
      for (const value of part.properties.values()) pending.push(value);
  }
  return edges;
}
