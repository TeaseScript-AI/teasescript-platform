import { RANDOM_FUNCTIONS } from "../../language-facts.js";
import type { RuntimeDebugRandomOperation } from "../debug/debug-trace.js";
import type { SerializableRuntimeValue } from "../values/serializable-values.js";

// The kinds of random draw, what a draw can produce, and the check of a host's chosen outcome: what a draw picker needs,
// without the engine's random control (`random-control.ts`), whose policies hold the plan.

/*
 * Controlled randomness (#512, owner decision 2026-10-07; docs/RUNTIME.md#controlled-randomness). A host may choose
 * the outcome of a semantic random draw, let it be natural, or pause the engine at it. Natural sampling always runs
 * first, so the generator advances exactly as without control; only a chosen outcome replaces the result.
 *
 * A pause undoes the unit the draw belongs to, one instruction or one timer round, and keeps a small continuation in
 * the snapshot. Resuming executes that unit again from its start: earlier draws of the unit take their recorded
 * outcomes without asking the host again, builtins it called return their recorded results, and the paused draw takes
 * the resolution. The engine is deterministic, so the unit reaches the paused draw in the same state.
 */

/** The kinds of semantic random draw: the operations a debug trace names. */
export type RandomDrawKind = RuntimeDebugRandomOperation;

/** The random functions' draws, which are named after them, and the draws of other operations. */
export const RANDOM_DRAW_KINDS: readonly RandomDrawKind[] = Object.freeze([
  ...RANDOM_FUNCTIONS,
  "collectionRandom",
  "interpolation",
  "shuffle",
  "tagQuery",
  "glob",
  "timerRepeat",
  "duration",
]);

/** What a draw can produce. A host chooses within it; the engine refuses anything else. */
export type RandomSupport =
  /** `random()`: a finite number from 0 up to, but not including, 1. */
  | { readonly kind: "unit" }
  /** `chance(percent)`: a boolean; at 0 only `false`, at 100 only `true`. */
  | { readonly kind: "chance"; readonly percent: number }
  /** A whole number from `min` through `max`: `randomInteger`, or a timer's seconds. */
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  /** One of the candidates, by index: an element, a tagged image or script, or a glob's file path. */
  | { readonly kind: "candidates"; readonly candidates: readonly SerializableRuntimeValue[] }
  /** One of the candidates with a positive weight, by index. */
  | {
      readonly kind: "weighted";
      readonly candidates: readonly SerializableRuntimeValue[];
      readonly weights: readonly number[];
    }
  /** Any finite number; with spread 0 only the mean. */
  | { readonly kind: "normal"; readonly mean: number; readonly spread: number }
  /** A finite number from 0 through 1. */
  | { readonly kind: "beta"; readonly alpha: number; readonly beta: number }
  /** A finite number from `min` through `max`. */
  | {
      readonly kind: "pert";
      readonly min: number;
      readonly mostLikely: number;
      readonly max: number;
    }
  /** A new order of the items, as their old indexes. */
  | { readonly kind: "order"; readonly items: readonly SerializableRuntimeValue[] };

export type RandomOutcome =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "order"; readonly order: readonly number[] };

/* ---------------------------------------------------------------------------------------------------------------- */
/* Outcomes                                                                                                         */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * `outcome` as a detached outcome when `support` admits it, otherwise why it does not. `keysOf` is the object whose own
 * keys the outcome's shape counts.
 */
export function checkedOutcome(
  support: RandomSupport,
  outcome: unknown,
  keysOf: unknown = outcome,
): RandomOutcome | string {
  const problem = outcomeProblem(support, outcome);
  if (problem !== null) return problem;
  return isOutcomeShape(outcome, keysOf)
    ? canonicalOutcome(outcome)
    : "An outcome holds only its kind and its value, index, or order.";
}

function outcomeProblem(support: RandomSupport, outcome: unknown): string | null {
  if (typeof outcome !== "object" || outcome === null) return "An outcome must be an object.";
  // EVIDENCE: validation: each branch below checks the fields it reads.
  const candidate = outcome as Record<string, unknown>;
  const number = (): number | null =>
    candidate.kind === "number" && typeof candidate.value === "number" ? candidate.value : null;
  switch (support.kind) {
    case "unit": {
      const value = number();
      return value !== null && Number.isFinite(value) && value >= 0 && value < 1
        ? null
        : "random() takes a number from 0 up to, but not including, 1.";
    }
    case "chance": {
      if (candidate.kind !== "boolean" || typeof candidate.value !== "boolean")
        return "chance(...) takes a boolean outcome.";
      if (support.percent <= 0 && candidate.value) return "chance(0) is always false.";
      if (support.percent >= 100 && !candidate.value) return "chance(100) is always true.";
      return null;
    }
    case "integer": {
      const value = number();
      return value !== null &&
        Number.isSafeInteger(value) &&
        value >= support.min &&
        value <= support.max
        ? null
        : `This draw takes a whole number from ${support.min} through ${support.max}.`;
    }
    case "candidates":
    case "weighted": {
      const index = candidate.kind === "index" ? candidate.index : undefined;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= support.candidates.length
      )
        return `This draw takes the index of one of its ${support.candidates.length} candidates.`;
      if (support.kind === "weighted" && !(support.weights[index]! > 0))
        return "A candidate with weight 0 cannot be drawn.";
      return null;
    }
    case "normal": {
      const value = number();
      if (value === null || !Number.isFinite(value)) return "randomNormal takes a finite number.";
      return support.spread === 0 && value !== support.mean
        ? `randomNormal with spread 0 always gives its mean, ${support.mean}.`
        : null;
    }
    case "beta": {
      const value = number();
      return value !== null && Number.isFinite(value) && value >= 0 && value <= 1
        ? null
        : "randomBeta takes a number from 0 through 1.";
    }
    case "pert": {
      const value = number();
      return value !== null &&
        Number.isFinite(value) &&
        value >= support.min &&
        value <= support.max
        ? null
        : `randomPert takes a number from ${support.min} through ${support.max}.`;
    }
    case "order": {
      const order = candidate.kind === "order" ? candidate.order : undefined;
      const length = support.items.length;
      if (!Array.isArray(order) || order.length !== length)
        return `A shuffle takes an order of all ${length} items, as their old indexes.`;
      const seen = new Set<number>();
      for (const index of order) {
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= length)
          return `A shuffle takes an order of all ${length} items, as their old indexes.`;
        seen.add(index);
      }
      return seen.size === length ? null : "A shuffle's order names every item once.";
    }
  }
}

/**
 * The fields of an outcome a host chose for a draw of `support`, each read once, so that the outcome the engine checks is
 * the one it uses, whatever the host's object does on later reads: its `kind` and, when the draw takes that kind, the
 * one field it holds, which are all the check reads. The items of an `order` are read by index, only when its length, read once, is the
 * shuffle's; any other `order` is refused on its length. The object's own keys are counted only once these pass.
 */
export function readOnce(outcome: Record<string, unknown>, support: RandomSupport): ReadOutcome {
  const kind = outcome.kind;
  // As the check does, the field is read only when the kind is the one the draw takes.
  if (kind !== takenKind(support)) return { kind };
  if (kind === "number" || kind === "boolean") return { kind, value: outcome.value };
  if (kind === "index") return { kind, index: outcome.index };
  if (kind !== "order") return { kind };
  const order = outcome.order;
  if (!Array.isArray(order)) return { kind, order };
  const length = order.length;
  return {
    kind,
    order:
      support.kind === "order" && length === support.items.length
        ? Array.from({ length }, (_, index) => order[index])
        : null,
  };
}

/** The kind of outcome a draw of `support` takes. */
function takenKind(support: RandomSupport): RandomOutcome["kind"] {
  switch (support.kind) {
    case "chance":
      return "boolean";
    case "candidates":
    case "weighted":
      return "index";
    case "order":
      return "order";
    case "unit":
    case "integer":
    case "normal":
    case "beta":
    case "pert":
      return "number";
  }
}

/** The fields of a chosen outcome that its check reads, each read once. */
export interface ReadOutcome {
  readonly kind: unknown;
  readonly value?: unknown;
  readonly index?: unknown;
  readonly order?: unknown;
}

/** A detached copy of an outcome the engine checked, holding only its own fields. */
export function canonicalOutcome(outcome: RandomOutcome): RandomOutcome {
  switch (outcome.kind) {
    case "number":
      return Object.freeze({ kind: "number", value: outcome.value });
    case "boolean":
      return Object.freeze({ kind: "boolean", value: outcome.value });
    case "index":
      return Object.freeze({ kind: "index", index: outcome.index });
    case "order":
      return Object.freeze({ kind: "order", order: Object.freeze([...outcome.order]) });
  }
}

export function isOutcomeShape(value: unknown, keysOf: unknown = value): value is RandomOutcome {
  if (!isRecord(value) || !isRecord(keysOf)) return false;
  switch (value.kind) {
    case "number":
      return hasExactKeys(keysOf, ["kind", "value"]) && finite(value.value);
    case "boolean":
      return hasExactKeys(keysOf, ["kind", "value"]) && typeof value.value === "boolean";
    case "index":
      return (
        hasExactKeys(keysOf, ["kind", "index"]) && safeInteger(value.index) && value.index >= 0
      );
    case "order":
      return (
        hasExactKeys(keysOf, ["kind", "order"]) &&
        Array.isArray(value.order) &&
        value.order.every((index: unknown) => safeInteger(index) && index >= 0)
      );
    default:
      return false;
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Snapshot validation                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
