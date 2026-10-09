import assert from "node:assert/strict";

import { compileSource } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";

/** Compiles `source` into a plan, with no diagnostics but the warnings the test names, by code in compiler order. */
export function compileValidPlan(
  source: string,
  options: Parameters<typeof compileSource>[1] = {},
  warnings: readonly string[] = [],
): InstructionPlan {
  const result = compileSource(source, options);
  if (warnings.length === 0) assert.deepEqual(result.diagnostics, []);
  else
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code}`),
      warnings.map((code) => `warning ${code}`),
    );
  assert.notEqual(result.plan, null);
  return result.plan!;
}
