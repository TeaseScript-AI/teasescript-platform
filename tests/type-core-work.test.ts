import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { W34_VARIANTS, WORK_FAMILIES, type WorkFamily } from "./helpers/type-core-families.js";

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

/** A family's analysis at size k, in the source order or with the consumers' and the solver's orders reversed. */
function analysed(family: WorkFamily, k: number, reversed = false): Answers {
  const request = coreRequest(family.program(k));
  assert.ok(request !== null, `${family.name} at ${k}: its files parse and resolve`);
  const answers = reversed
    ? withConsumerOrder(
        (list) => [...list].reverse(),
        () => withSolverSeam({ reverseWorklist: true }, () => analyseCore(request)),
      )
    : analyseCore(request);
  assert.notEqual(answers.outcome, "budget-error", `${family.name} at ${k}: within the allowance`);
  return answers;
}

/** The charged work of a family's program at size k, and its syntax nodes. */
function work(family: WorkFamily, k: number): { total: number; nodes: number } {
  const answers = analysed(family, k);
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

/**
 * W34 (TABLE §13.3, r4.33–r4.38): every variant in the source order and with the consumers' and the solver's orders
 * reversed, its total and each counter of at least 200 units per doubling of the source. A counter is the raw count of
 * one structure's steps, so a copy walked per field or a mark set made per copy shows in its own counter where the
 * total would hide it; the full series to k = 1,024 is the step's evidence, outside CI.
 */
test("every W34 variant's work and each of its counters grow with the program in either order", () => {
  const steep: string[] = [];
  for (const family of W34_VARIANTS)
    for (const reversed of [false, true]) {
      const small = analysed(family, 64, reversed).budget;
      const large = analysed(family, 128, reversed).budget;
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      const name = `${family.name}${reversed ? " reversed" : ""}`;
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      if (doubling(small.total, large.total) > DOUBLING)
        steep.push(`${name}: ${doubling(small.total, large.total).toFixed(3)}`);
      for (const [counter, after] of large.counts)
        if (
          counter !== "syntaxNodes" &&
          after >= 200 &&
          doubling(small.counts.get(counter) ?? 0, after) > DOUBLING
        )
          steep.push(
            `${name} ${counter}: ${doubling(small.counts.get(counter) ?? 0, after).toFixed(3)}`,
          );
    }
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
