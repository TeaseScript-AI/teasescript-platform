import assert from "node:assert/strict";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import { BUDGET } from "../src/type-inference/solver/budget.js";
import { exportFacts } from "../src/type-inference/solver/export.js";
import { solve } from "../src/type-inference/solver/solve.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * The temporary work budget (`solver/budget.ts`; the owner, 2026-10-19): above a provisional limit the work is not
 * done, the result is held and the status reports the cut; below it nothing changes. These are the budget's own
 * tests, apart from the target suite's desired results (which never expect the limit). Removing the budget removes
 * this file with the module.
 */

const RELATIONS = operationRelations();

function solveOf(source: string) {
  const made = request([{ path: "main.tease", source }], ["hostValue"], []);
  assert.notEqual(made, null);
  const solution = solve(collectGraph(made!), { relations: RELATIONS, verify: true });
  return { solution, facts: exportFacts(solution) };
}

const chain = (n: number): string =>
  `${Array.from({ length: n }, (_, i) => `let a${i}: integer[] | number[] = [1]`).join("\n")}\nlet r = ${Array.from({ length: n }, (_, i) => `a${i}`).join(" + ")}\nexit`;

test("the limits are the provisional guards of the measurement report", () => {
  assert.deepEqual(BUDGET, { combinations: 1000, alternatives: 256 });
});

test("a chain of distinct written unions meets the budget: the result is held, the cut reported, the rest checked", () => {
  const { solution, facts } = solveOf(chain(12));
  const cuts = solution.statuses.filter((status) => status.includes(":budget("));
  assert.ok(cuts.length > 0, `a cut is reported: ${solution.statuses.join(",")}`);
  assert.ok(
    cuts.every((status) => /:budget\((combinations|alternatives)\)$/.test(status)),
    "the status names the quantity, never a count that depends on the schedule",
  );
  // the cut cell presents no alternative beside its mark, so what is computed from it is not known
  assert.equal(facts.bindings.find((b) => b.name === "r")?.type, "unknown", "not checked");
  assert.equal(
    facts.bindings.find((b) => b.name === "a0")?.type,
    "list<number>",
    "the rest is checked",
  );
  assert.ok(solution.cuts.length > 0, "the cuts are recorded for the diagnostic");
  for (const cut of solution.cuts) assert.ok(cut.count > BUDGET[cut.quantity]);
});

test("below the budget no cut is made and no status appears", () => {
  const { solution, facts } = solveOf(chain(6));
  assert.deepEqual(solution.statuses, []);
  assert.deepEqual(solution.cuts, []);
  assert.equal(facts.bindings.find((b) => b.name === "r")?.type, "list<number>");
});
