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

function isDeeplyFrozen(root: InstructionPlan): boolean {
  const visited = new Set<object>();
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (visited.has(value)) continue;
    visited.add(value);
    if (!Object.isFrozen(value)) return false;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      const nested = descriptor.value;
      if (typeof nested === "object" && nested !== null) pending.push(nested);
    }
  }
  return true;
}
