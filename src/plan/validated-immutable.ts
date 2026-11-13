import { createWorklist } from "../external-data-capture.js";
import type { InstructionPlan } from "./model.js";

const validatedImmutablePlans = new WeakSet<object>();

/** Records that complete validation accepted an immutable instruction-plan graph. */
export function markValidatedImmutableInstructionPlan(plan: InstructionPlan): InstructionPlan {
  if (isDeeplyFrozen(plan)) validatedImmutablePlans.add(plan);
  return plan;
}

/** Returns whether this exact immutable plan graph already passed complete validation. */
export function isValidatedImmutableInstructionPlan(plan: InstructionPlan): boolean {
  return validatedImmutablePlans.has(plan);
}

/**
 * Whether every object reachable from `root` is frozen and holds only data properties. It reads no `Array.prototype` or
 * `Object.prototype` method, iterator, setter or property, so a replaced one cannot make it skip part of the graph.
 */
function isDeeplyFrozen(root: InstructionPlan): boolean {
  const visited = new Set<object>();
  const pending = createWorklist<object>();
  let size = 0;
  pending[size++] = root;
  while (size > 0) {
    const value = pending[--size]!;
    if (visited.has(value)) continue;
    visited.add(value);
    if (!Object.isFrozen(value)) return false;
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, keys[index]!);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
      const nested = descriptor.value;
      if (typeof nested === "object" && nested !== null) pending[size++] = nested;
    }
  }
  return true;
}
