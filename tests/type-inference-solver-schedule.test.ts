import assert from "node:assert/strict";
import test from "node:test";

import {
  run,
  schedule,
  type RunInput,
  type ScheduleInput,
} from "../src/type-inference/solver/schedule.js";

/**
 * The solver's schedule (O4 stage 3a, work note §3.3): components in topological order, a worklist inside a component
 * driven by changed cells, iterative at depth.
 */

/** A graph from edges `node -> cells it writes` and `node -> cells it reads`. */
function graph(
  edges: readonly { readonly reads: readonly number[]; readonly writes: readonly number[] }[],
): ScheduleInput {
  return {
    nodes: edges.length,
    reads: (node) => edges[node]!.reads,
    writes: (node) => edges[node]!.writes,
  };
}

test("components come in the order of their dependencies, a cycle as one component", () => {
  // 0 writes a; 1 reads a, writes b; 2 reads b, writes c; 3 reads c and d, writes d; 4 reads d, writes e; 5 reads e,
  // writes b: 2 depends on 5 (a writer of b), 5 on 4, 4 on 3, 3 on 2 and on itself, so {2, 3, 4, 5} is one component;
  // 1 depends on 0 alone.
  const plan = schedule(
    graph([
      { reads: [], writes: [0] },
      { reads: [0], writes: [1] },
      { reads: [1], writes: [2] },
      { reads: [2, 3], writes: [3] },
      { reads: [3], writes: [4] },
      { reads: [4], writes: [1] },
    ]),
  );
  assert.deepEqual(plan.components, [[0], [1], [2, 3, 4, 5]]);
  assert.deepEqual(plan.componentOf, [0, 1, 2, 2, 2, 2]);
});

test("independent nodes are their own components; a reader comes after every writer of what it reads", () => {
  const plan = schedule(
    graph([
      { reads: [5], writes: [9] }, // reads a cell nobody writes: a leaf component
      { reads: [], writes: [1] },
      { reads: [], writes: [1] }, // two writers of one cell
      { reads: [1], writes: [2] },
    ]),
  );
  const position = new Map(
    plan.components.flatMap((component, index) => component.map((node) => [node, index])),
  );
  assert.ok(position.get(3)! > position.get(1)!, "the reader after the first writer");
  assert.ok(position.get(3)! > position.get(2)!, "the reader after the second writer");
  assert.equal(plan.components.length, 4);
});

test("a chain 50,000 long is scheduled without native recursion", () => {
  const length = 50_000;
  const edges: { reads: number[]; writes: number[] }[] = [];
  for (let node = 0; node < length; node += 1)
    edges.push({ reads: node === 0 ? [] : [node - 1], writes: [node] });
  const plan = schedule(graph(edges));
  assert.equal(plan.components.length, length);
  assert.deepEqual(plan.components[0], [0]);
  assert.deepEqual(plan.components[length - 1], [length - 1]);
});

test("the worklist re-evaluates a node only when a cell it reads changed, and only inside its component", () => {
  // Cells hold sets that only grow (the solver's evidence): node 1 adds to cell 0 the successor of every member of
  // cell 1, node 2 adds to cell 1 the double of every member of cell 0, both below a bound, so the cycle {1, 2} has one
  // fixpoint whatever the order; node 3 reads cell 1 once the cycle has settled.
  const bound = 40;
  const cells = new Map<number, Set<number>>([
    [0, new Set()],
    [1, new Set()],
    [2, new Set()],
  ]);
  const addAll = (cell: number, values: Iterable<number>): boolean => {
    const set = cells.get(cell)!;
    let changed = false;
    for (const value of values)
      if (value <= bound && !set.has(value)) {
        set.add(value);
        changed = true;
      }
    return changed;
  };
  const evaluated: number[] = [];
  const input: RunInput = {
    nodes: 4,
    reads: (node) => [[], [0, 1], [0], [1]][node]!,
    writes: (node) => [[0], [0], [1], [2]][node]!,
    evaluate: (node) => {
      evaluated.push(node);
      switch (node) {
        case 0:
          return addAll(0, [1]) ? [0] : [];
        case 1:
          return addAll(
            0,
            [...cells.get(1)!].map((value) => value + 1),
          )
            ? [0]
            : [];
        case 2:
          return addAll(
            1,
            [...cells.get(0)!].map((value) => value * 2),
          )
            ? [1]
            : [];
        default:
          return addAll(2, cells.get(1)!) ? [2] : [];
      }
    },
  };
  const report = run(input);
  assert.equal(report.components, 3, "node 0 alone, the cycle {1, 2}, node 3 alone");
  // The fixpoint: 1 in cell 0; doubling and adding one alternate up to the bound.
  const expected = new Set<number>();
  let value = 1;
  while (value <= bound) {
    expected.add(value * 2 <= bound ? value * 2 : -1);
    value = value * 2 + 1;
  }
  expected.delete(-1);
  assert.deepEqual(
    [...cells.get(2)!].sort((a, b) => a - b),
    [...expected].sort((a, b) => a - b),
  );
  assert.deepEqual(cells.get(2), cells.get(1), "the reader saw the component's final state");
  assert.equal(
    evaluated.filter((node) => node === 3).length,
    1,
    "the reader ran once, after the cycle settled",
  );
  assert.ok(report.longestComponent >= 4, "the cycle iterated");
  for (const cell of cells.values()) cell.clear();
  evaluated.length = 0;
  const again = run(input);
  assert.equal(again.evaluations, report.evaluations, "deterministic");
});
