import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { WORK_FAMILIES } from "./helpers/type-core-families.js";

/**
 * The work of the coarse core (checkpoint 9, TABLE §8 and §10.1's W rows) as a sampled regression oracle: every
 * family's charged work at k = 128 against k = 64, per doubling of the programs' syntax nodes, since a family's source
 * need not double exactly. Linear work doubles; a structure bounded by a product of two program dimensions about
 * quadruples. The TABLE's `n log n` structures (a key's definitions sorted, its lifting table, its own events) give up
 * to 2.33 at these sizes where nothing else is charged: W26's k stores of one place in one block measure 2.12 here and
 * 2.08 at k = 1,024, while the products the reference model's calibration found measured 2.56 and more. Two sizes
 * calibrate on known products; they prove no bound: the full series to k = 1,024 is the step's evidence, outside CI.
 */
const DOUBLING = 2.15;

/** The charged work of a family's program at size k, and its syntax nodes. */
function work(family: (typeof WORK_FAMILIES)[number], k: number): { total: number; nodes: number } {
  const request = coreRequest(family.program(k));
  assert.ok(request !== null, `${family.name} at ${k}: its files parse and resolve`);
  const answers = analyseCore(request);
  assert.notEqual(answers.outcome, "budget-error", `${family.name} at ${k}: within the allowance`);
  return { total: answers.budget.total, nodes: answers.budget.counts.get("syntaxNodes") ?? 0 };
}

test("every sampled family's work grows with its program, not with a product of its dimensions", () => {
  const steep = WORK_FAMILIES.flatMap((family) => {
    const small = work(family, 64);
    const large = work(family, 128);
    // the work ratio per doubling of the source: 2 for linear work
    const doubling = (2 * (large.total / small.total)) / (large.nodes / small.nodes);
    return doubling > DOUBLING ? [`${family.name}: ${doubling.toFixed(3)}`] : [];
  });
  assert.deepEqual(steep, []);
});

test("the analysis stops above 256 levels of nested blocks, an `else if` one level", () => {
  const nested = (depth: number): string =>
    `${"if true {\n".repeat(depth)}say "deep"\n${"}\n".repeat(depth)}exit`;
  const chained = (length: number): string =>
    `let n = 1\n${Array.from({ length }, (_, i) => `${i === 0 ? "" : "else "}if n == ${i} { say "${i}" }`).join("\n")}\nexit`;
  const outcome = (source: string): string => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    return analyseCore(request).outcome;
  };
  assert.equal(outcome(nested(256)), "valid");
  assert.equal(outcome(nested(257)), "budget-error");
  assert.equal(outcome(chained(255)), "valid");
  assert.equal(outcome(chained(257)), "budget-error");
});
