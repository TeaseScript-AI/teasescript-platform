import type { InstructionPlan } from "../../src/plan/model.js";
import {
  createFreshRuntimeSnapshot,
  type FreshRuntimeOptions,
} from "../../src/runtime/state.js";

export type ImmediatePacingRuntimeOptions = Omit<
  FreshRuntimeOptions,
  "baseDelayMs" | "delayPerWordMs" | "delayPerCharacterMs"
>;

export function createImmediatePacingRuntimeSnapshot(
  plan: InstructionPlan,
  options: ImmediatePacingRuntimeOptions = {},
) {
  return createFreshRuntimeSnapshot(plan, {
    ...options,
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
}
