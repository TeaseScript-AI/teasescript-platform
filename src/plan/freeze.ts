import type { InstructionPlan } from "./model.js";

/** Freezes an already captured or engine-owned instruction plan without recursion. */
export function freezeInstructionPlan(plan: InstructionPlan): InstructionPlan {
  const work: Array<readonly [object, boolean]> = [[plan, false]];
  while (work.length > 0) {
    const [current, readyToFreeze] = work.pop()!;
    if (Object.isFrozen(current)) continue;
    if (readyToFreeze) {
      Object.freeze(current);
      continue;
    }
    work.push([current, true]);
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const nested = current[index];
        if (typeof nested === "object" && nested !== null && !Object.isFrozen(nested)) {
          work.push([nested, false]);
        }
      }
      continue;
    }
    for (const nested of Object.values(current as Record<string, unknown>)) {
      if (typeof nested === "object" && nested !== null && !Object.isFrozen(nested)) {
        work.push([nested, false]);
      }
    }
  }
  return plan;
}
