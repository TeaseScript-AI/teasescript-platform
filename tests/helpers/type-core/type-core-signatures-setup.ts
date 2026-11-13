// The C13 signature tests' shared setup (tests/type-core/signatures/): a program's diagnostics, its record compared in
// both orders.

import assert from "node:assert/strict";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { checkedResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { compactAnalysis, coreRequest } from "../type-core-analysis.js";
import { inOrder } from "../type-core-oracles.js";
import { type CheckedDiagnostic } from "../../../src/type-inference/core/result.js";

/**
 * A program's diagnostics with their rules, its record compared in the core's order and with its consumers' and solver's
 * orders reversed: both, equal.
 */
export function analysed(source: string, allowance?: number): readonly CheckedDiagnostic[] {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const allowed = <T>(make: () => T): T =>
    allowance === undefined ? make() : withTestAllowance(allowance, make);
  const forward = allowed(() => compactAnalysis(request));
  const reversed = inOrder(true, () => allowed(() => compactAnalysis(request)));
  assert.deepEqual(reversed, forward, `${source}: both orders`);
  return allowed(() => checkedResult(analyseCore(request), request)).diagnostics;
}
