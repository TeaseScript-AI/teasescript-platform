import assert from "node:assert/strict";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import { exportFacts } from "../src/type-inference/solver/export.js";
import { solve, type Solution } from "../src/type-inference/solver/solve.js";
import { CASES, SERIES, type Phase } from "./helpers/type-inference-dimensions.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * The target suite over the input dimensions (see `helpers/type-inference-dimensions.ts`). For every series: the
 * sources parse and solve with the fixpoint verified, the exported facts are the rules', and no budget cut happens
 * (hard assertions, always); the counted work of every phase grows at most linearly with the size (hard, unless the
 * series names the backlog row it waits on: then that one assertion is a `todo`, reported and never failing the
 * suite, to be turned into a plain assertion by the agent whose task is "make the target suite pass"). The
 * detector: over geometric sizes, a doubling of the size at most doubles the count plus a constant; the work-bounds
 * test proves it rejects a quadratic and an exponential series.
 */

const RELATIONS = operationRelations();
const PHASES: readonly Phase[] = [
  "evaluations",
  "asks",
  "combinations",
  "foldStates",
  "cells",
  "items",
  "orders",
  "selections",
];

function solveOf(files: readonly { readonly path: string; readonly source: string }[]): Solution {
  const made = request(files, ["hostValue"], []);
  assert.notEqual(made, null, "the source parses and resolves");
  const solution = solve(collectGraph(made!), { relations: RELATIONS, verify: true });
  exportFacts(solution);
  return solution;
}

function bindingType(solution: Solution, name: string): string | undefined {
  const facts = exportFacts(solution);
  const [file, local] = name.includes(":") ? name.split(":") : [undefined, name];
  const found = facts.bindings.filter(
    (b) => b.name === local && (file === undefined || solution.graph.files[b.site.file] === file),
  );
  return found[0]?.type;
}

const linearInSize = (
  name: string,
  sizes: readonly number[],
  counts: readonly number[],
  slack = 16,
): void => {
  for (let i = 1; i < sizes.length; i += 1)
    assert.ok(
      counts[i]! <= (sizes[i]! / sizes[i - 1]!) * counts[i - 1]! + slack,
      `${name}: ${counts.join(", ")} at sizes ${sizes.join(", ")} grows faster than linearly`,
    );
};

for (const series of SERIES) {
  const runs = new Map<number, Solution>();
  const runOf = (n: number): Solution => {
    let run = runs.get(n);
    if (run === undefined) {
      run = solveOf([{ path: "main.tease", source: series.source(n) }]);
      runs.set(n, run);
    }
    return run;
  };
  test(`${series.dimension}: ${series.name} (results)`, () => {
    for (const n of series.sizes) {
      const run = runOf(n);
      const expected = series.expect(n);
      for (const [name, type] of expected.bindings)
        assert.equal(bindingType(run, name), type, `${series.name} at ${n}: ${name}`);
      if (expected.statuses !== undefined)
        assert.deepEqual(run.statuses, expected.statuses, `${series.name} at ${n}: statuses`);
    }
  });
  const cutTodo = series.todo?.assertion === "cut";
  test(
    `${series.dimension}: ${series.name} (no budget cut)${cutTodo ? ` [todo: ${series.todo!.backlog}]` : ""}`,
    { todo: cutTodo },
    () => {
      for (const n of series.sizes)
        assert.deepEqual(
          runOf(n).statuses.filter((status) => status.includes("budget")),
          [],
          `${series.name} at ${n}: a budget cut on an ordinary input`,
        );
    },
  );
  const workTodo = series.todo?.assertion === "work";
  test(
    `${series.dimension}: ${series.name} (linear work)${workTodo ? ` [todo: ${series.todo!.backlog}]` : ""}`,
    { todo: workTodo },
    () => {
      for (const phase of series.linear ?? PHASES)
        linearInSize(
          `${series.name}: ${phase}`,
          series.sizes,
          series.sizes.map((n) => runOf(n).work[phase]),
        );
    },
  );
}

for (const c of CASES)
  test(`${c.dimension}: ${c.name}`, () => {
    const run = solveOf(c.files);
    for (const [name, type] of c.bindings) assert.equal(bindingType(run, name), type, name);
    if (c.statuses !== undefined) assert.deepEqual(run.statuses, c.statuses);
    else assert.deepEqual(run.statuses, [], "no status on a valid source");
  });
