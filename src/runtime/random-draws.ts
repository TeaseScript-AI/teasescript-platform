import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan } from "../source.js";
import type { RuntimeDebugRandomOperation, TraceStore } from "./debug-trace.js";
import { nextXorShift32, type XorShift32State } from "./random.js";
import type { SerializableRuntimeRange } from "./serializable-values.js";

/*
 * The natural samplers of the semantic random operations (V30 §13): each turns primitive `[0, 1)` draws into one
 * outcome, consuming exactly the draws the operation has always consumed. The evaluator, transfers, and timer rounds
 * share them, so a semantic draw is sampled one way wherever it happens.
 */

/** One primitive `[0, 1)` draw from the session's random source. */
export type PrimitiveDraw = () => number;

/** The index of one of `count` equally likely outcomes, with one draw. */
export function sampleIndex(draw: PrimitiveDraw, count: number): number {
  return Math.floor(draw() * count);
}

/** A whole number of a non-empty integer range of `length` numbers, with one draw. */
export function sampleRangeInteger(
  draw: PrimitiveDraw,
  range: Pick<SerializableRuntimeRange, "start">,
  length: number,
): number {
  return range.start + sampleIndex(draw, length);
}

/** Whether a `percent` chance hits, with one draw, also at 0 and 100. */
export function sampleChance(draw: PrimitiveDraw, percent: number): boolean {
  return draw() * 100 < percent;
}

/**
 * A uniform random order of `length` items as their old indexes (Fisher–Yates), drawing `length - 1` numbers, or none
 * for fewer than two items, so replay and checkpoint resume reproduce it.
 */
export function sampleOrder(draw: PrimitiveDraw, length: number): number[] {
  const order = Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    const other = sampleIndex(draw, index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return order;
}

/**
 * One semantic draw that always uses the serialized generator, also when the host injected a random source: a glob
 * destination or a repeating timer's next round. A debug trace records it as one record with the generator state
 * around it.
 */
export function drawFromSessionGenerator<T>(
  rng: XorShift32State,
  trace: TraceStore | null,
  operation: RuntimeDebugRandomOperation,
  span: SourceSpan | PlanSourceLocation | null,
  choices: number | null,
  range: SerializableRuntimeRange | null,
  sample: (draw: PrimitiveDraw) => T,
): T {
  const before = rng.state;
  let draws = 0;
  const outcome = sample(() => {
    draws += 1;
    return nextXorShift32(rng);
  });
  if (trace !== null && draws > 0)
    trace.random(operation, span, choices, range, before, rng.state, draws);
  return outcome;
}
