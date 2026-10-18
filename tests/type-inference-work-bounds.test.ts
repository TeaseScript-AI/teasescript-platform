import assert from "node:assert/strict";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import { exportFacts } from "../src/type-inference/solver/export.js";
import { solve, type Solution } from "../src/type-inference/solver/solve.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * The growth series of the exit criterion (O4 stage 3a, work note §3.5, after review r5): the work of each phase grows
 * at most linearly with the input where a product or a repeated walk once grew exponentially. Each series solves the
 * same shape at three sizes and asserts the step from the middle to the largest is at most twice the step from the
 * smallest to the middle (plus a small constant for fixed work), so a doubling per element fails mechanically. The
 * counts are deterministic: no timing.
 */

const RELATIONS = operationRelations();

function solveOf(source: string): Solution {
  const made = request([{ path: "main.tease", source }], ["hostValue"], []);
  assert.notEqual(made, null, "the source parses and resolves");
  const solution = solve(collectGraph(made!), { relations: RELATIONS, verify: true });
  exportFacts(solution);
  return solution;
}

const linear = (name: string, small: number, middle: number, large: number, slack = 8): void => {
  assert.ok(
    large - middle <= 2 * (middle - small) + slack,
    `${name}: ${small}, ${middle}, ${large} grows faster than linearly`,
  );
};

test("a copy chain's interpretation orders each source once per copy (Dropje97's W3-B3)", () => {
  const chain = (copies: number): string =>
    `let v0: integer | string = 1\n${Array.from({ length: copies }, (_, i) => `let v${i + 1} = v${i}`).join("\n")}\nexit`;
  const [a, b, c] = [4, 8, 16].map((k) => solveOf(chain(k)).work.orders);
  linear("orders", a!, b!, c!);
  assert.ok(c! < 400, `${c} item orders for sixteen copies`);
});

test("min over distinct bindings and over one binding repeated are the same linear work (Sol r5-B3)", () => {
  const distinct = (k: number): string =>
    `${Array.from({ length: k }, (_, i) => `let a${i}: integer | number = 1`).join("\n")}\nlet r = min(${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")})\nexit`;
  const same = (k: number): string =>
    `let a: integer | number = 1\nlet r = min(${Array.from({ length: k }, () => "a").join(", ")})\nexit`;
  const d = [4, 8, 16].map((k) => solveOf(distinct(k)).work.asks);
  const s = [4, 8, 16].map((k) => solveOf(same(k)).work.asks);
  linear("asks, distinct", d[0]!, d[1]!, d[2]!);
  assert.deepEqual(d, s);
});

test("a choice's options and a field's option list are summed: the asks do not grow with the options (Astra r5-B3)", () => {
  const choice = (k: number): string =>
    `let a: integer | number = 1\nlet r = askChoice ${Array.from({ length: k }, () => "a").join(", ")}\nexit`;
  const field = (k: number): string =>
    `let a: integer | number = 1\nlet r = askForm("Q", fields: {q: {options: [${Array.from({ length: k }, () => "a").join(", ")}]}})\nexit`;
  const c = [2, 4, 8].map((k) => solveOf(choice(k)).work.asks);
  assert.equal(c[0], c[2], `asks for two and eight options: ${c.join(", ")}`);
  const f = [2, 4, 8].map((k) => solveOf(field(k)).work.asks);
  linear("asks, field options", f[0]!, f[1]!, f[2]!);
});

test("a chain of rebuilds with a feedback edge stays finite and grows linearly (Sol r5-B1)", () => {
  const feedback = (k: number): string =>
    `let x0: integer[] | string[] = [1]\n${Array.from({ length: k }, (_, i) => `let x${i + 1} = x${i} + []`).join("\n")}\nx0 = x${k} + []\nexit`;
  const runs = [4, 8, 16].map((k) => solveOf(feedback(k)));
  for (const run of runs)
    assert.ok(
      exportFacts(run).bindings.every((b) => b.type === "(list<integer>|list<string>)"),
      "every rebuild keeps the written union's members apart",
    );
  const [small, middle, large] = runs;
  linear("cells", small!.work.cells, middle!.work.cells, large!.work.cells);
  linear(
    "evaluations",
    small!.work.evaluations,
    middle!.work.evaluations,
    large!.work.evaluations,
    32,
  );
  linear("asks", small!.work.asks, middle!.work.asks, large!.work.asks, 32);
});
