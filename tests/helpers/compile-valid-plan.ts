import assert from "node:assert/strict";

import { compileSource } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";

export function compileValidPlan(
  source: string,
  options: Parameters<typeof compileSource>[1] = {},
): InstructionPlan {
  const result = compileSource(source, options);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}
