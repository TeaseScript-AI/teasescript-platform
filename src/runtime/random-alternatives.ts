import type { RandomDrawView, RandomOutcome } from "./random-control.js";

/** Outcomes to try at a draw besides its natural one, and whether they are all it can produce. */
export interface RandomDrawAlternatives {
  /** Distinct outcomes the draw can produce other than its natural result, at most the limit. */
  readonly alternatives: readonly RandomOutcome[];
  /** Whether the natural result and the alternatives are every outcome the draw can produce. */
  readonly complete: boolean;
}

/**
 * Outcomes to try at a paused draw besides its natural result, which resuming with `"natural"` tries without recording
 * an input (`docs/RUNTIME.md#controlled-randomness`). A finite support is enumerated in order until `limit`; a
 * continuous one, a large range, and a large shuffle give representative samples and are not `complete`, except a
 * PERT interval of so few representable numbers that all of them fit.
 */
export function randomDrawAlternatives(draw: RandomDrawView, limit = 16): RandomDrawAlternatives {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError("limit must be a whole number of at least 0.");
  const natural = JSON.stringify(draw.natural);
  const found: RandomOutcome[] = [];
  const seen = new Set<string>([natural]);
  /** Adds an outcome unless it is the natural one or known; false once the limit is reached. */
  const add = (outcome: RandomOutcome): boolean => {
    const key = JSON.stringify(outcome);
    if (seen.has(key)) return true;
    if (found.length >= limit) return false;
    seen.add(key);
    found.push(outcome);
    return true;
  };
  const number = (value: number) => add({ kind: "number", value });
  const index = (value: number) => add({ kind: "index", index: value });
  const support = draw.support;
  switch (support.kind) {
    case "unit":
      // The largest number below 1, as `random()` never returns 1.
      for (const value of [0, 0.5, 1 - 2 ** -53]) number(value);
      return { alternatives: found, complete: false };
    case "chance":
      if (support.percent <= 0 || support.percent >= 100)
        return { alternatives: [], complete: true };
      return {
        alternatives: found,
        complete: add({
          kind: "boolean",
          value: !(draw.natural.kind === "boolean" && draw.natural.value),
        }),
      };
    case "integer": {
      const count = support.max - support.min + 1;
      if (count <= limit + 1) {
        for (let value = support.min; value <= support.max; value += 1) number(value);
        return { alternatives: found, complete: true };
      }
      // Both ends and the middle, then evenly spaced values.
      const step = (support.max - support.min) / Math.max(1, limit - 1);
      for (const value of [support.min, support.max, Math.floor((support.min + support.max) / 2)])
        number(value);
      for (let position = 1; position < limit - 1 && found.length < limit; position += 1)
        number(support.min + Math.round(step * position));
      return { alternatives: found, complete: false };
    }
    case "candidates":
    case "weighted":
      for (let position = 0; position < support.candidates.length; position += 1) {
        if (support.kind === "weighted" && !(support.weights[position]! > 0)) continue;
        if (!index(position)) return { alternatives: found, complete: false };
      }
      return { alternatives: found, complete: true };
    case "normal":
      if (support.spread === 0) return { alternatives: [], complete: true };
      for (const offset of [0, -1, 1, -3, 3]) {
        const value = support.mean + offset * support.spread;
        if (Number.isFinite(value)) number(value);
      }
      return { alternatives: found, complete: false };
    case "beta": {
      const values = [0, 0.5, 1];
      // The most likely value of a unimodal Beta.
      if (support.alpha > 1 && support.beta > 1)
        values.push((support.alpha - 1) / (support.alpha + support.beta - 2));
      for (const value of values) number(value);
      return { alternatives: found, complete: false };
    }
    case "pert": {
      if (support.min === support.max) return { alternatives: [], complete: true };
      // An interval of a few representable numbers is enumerated as a whole.
      const low = orderedDouble(support.min);
      const count = orderedDouble(support.max) - low + 1n;
      if (count <= BigInt(limit) + 1n) {
        for (let step = 0n; step < count; step += 1n) number(fromOrderedDouble(low + step));
        return { alternatives: found, complete: true };
      }
      for (const value of [support.min, support.mostLikely, support.max]) number(value);
      return { alternatives: found, complete: false };
    }
    case "order": {
      const length = support.items.length;
      const identity = Array.from({ length }, (_, position) => position);
      add({ kind: "order", order: identity });
      add({ kind: "order", order: [...identity].reverse() });
      // Every order in lexicographic sequence, while the limit allows.
      const order = [...identity];
      for (;;) {
        if (!add({ kind: "order", order: [...order] }))
          return { alternatives: found, complete: false };
        if (!nextPermutation(order)) return { alternatives: found, complete: true };
      }
    }
  }
}

/** A finite number's position among all finite numbers in order, with `-0` and `0` at one position. */
function orderedDouble(value: number): bigint {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, Math.abs(value));
  const magnitude = bits.getBigUint64(0);
  return value < 0 ? -magnitude : magnitude;
}

/** The finite number at a position that `orderedDouble` gives. */
function fromOrderedDouble(position: bigint): number {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setBigUint64(0, position < 0n ? -position : position);
  const magnitude = bits.getFloat64(0);
  return position < 0n ? -magnitude : magnitude;
}

/** Advances `order` to the next permutation in lexicographic order; false after the last one. */
function nextPermutation(order: number[]): boolean {
  let pivot = order.length - 2;
  while (pivot >= 0 && order[pivot]! >= order[pivot + 1]!) pivot -= 1;
  if (pivot < 0) return false;
  let swap = order.length - 1;
  while (order[swap]! <= order[pivot]!) swap -= 1;
  [order[pivot], order[swap]] = [order[swap]!, order[pivot]!];
  for (let left = pivot + 1, right = order.length - 1; left < right; left += 1, right -= 1)
    [order[left], order[right]] = [order[right]!, order[left]!];
  return true;
}
