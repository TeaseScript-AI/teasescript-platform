import assert from "node:assert/strict";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import { exportFacts } from "../src/type-inference/solver/export.js";
import { solve, type Solution } from "../src/type-inference/solver/solve.js";
import { request } from "./helpers/type-inference-graph.js";
import { variedSource } from "./helpers/type-inference-varied.js";

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

/**
 * The stronger detector (Sol's review of the target suite, 2026-10-19): a series over geometric sizes is linear when
 * every doubling of the size at most doubles the count, with a bound on the constant: count(2n) <= 2 * count(n) +
 * slack. A quadratic series (n^2) fails at the second doubling, an exponential one (2^n) at the first; the negative
 * controls below prove the detector rejects both.
 */
const linearInSize = (
  name: string,
  sizes: readonly number[],
  counts: readonly number[],
  slack = 8,
): void => {
  for (let i = 1; i < sizes.length; i += 1) {
    const ratio = sizes[i]! / sizes[i - 1]!;
    assert.ok(
      counts[i]! <= ratio * counts[i - 1]! + slack,
      `${name}: ${counts.join(", ")} at sizes ${sizes.join(", ")} grows faster than linearly`,
    );
  }
};

test("the growth detector rejects a quadratic and an exponential series (negative controls)", () => {
  const sizes = [25, 50, 100, 200];
  linearInSize("linear", sizes, [50, 100, 200, 400]);
  assert.throws(() =>
    linearInSize(
      "quadratic",
      sizes,
      sizes.map((n) => n * n),
    ),
  );
  assert.throws(() =>
    linearInSize(
      "exponential",
      sizes,
      sizes.map((n) => 2 ** (n / 25)),
    ),
  );
  // an injected scan: a reader map built by copying each cell's reader list per reader (the delta check's DC-B2)
  // counts n(n+1)/2 entries for n readers of one cell; the primitive counters make such a scan a growth failure
  assert.throws(() =>
    linearInSize(
      "injected scan (entries copied per reader)",
      sizes,
      sizes.map((n) => (n * (n + 1)) / 2),
    ),
  );
});

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

/**
 * The feedback series of the owner's acceptance (2026-10-19, after PR 3a review r6): a binding appended at k sites,
 * from every initializer role, to 200 appends; the counted work of every phase grows at most linearly with the
 * appends, no budget cut happens, and the result is the one the rules give (a self-rebuild stored back merges into
 * the binding's structures: a variable's list absorbs what is appended). The literal series was quadratic in
 * evaluations and the permitted-initializer series cubic in asks before the merge; the plain `+ []` series
 * exponential in the interpretation's orders before the per-cell order (Astra r6-B6).
 */
const FEEDBACK: readonly {
  readonly name: string;
  readonly source: (k: number) => string;
  readonly xs: string;
}[] = [
  {
    name: "a literal appended",
    source: (k) =>
      `let xs = [1]\n${Array.from({ length: k }, (_, i) => `xs = xs + [${i + 2}]`).join("\n")}\nexit`,
    xs: "list<integer>",
  },
  {
    name: "an empty literal appended",
    source: (k) =>
      `let xs = [1]\n${Array.from({ length: k }, () => "xs = xs + []").join("\n")}\nexit`,
    xs: "list<integer>",
  },
  {
    name: "a written bound rebuilt",
    source: (k) =>
      `let xs: integer[] | string[] = [1]\n${Array.from({ length: k }, () => "xs = xs + []").join("\n")}\nexit`,
    xs: "(list<integer>|list<string>)",
  },
  {
    name: "a get default appended",
    source: (k) =>
      `let xs = [[1]].get(0, default: [2])\n${Array.from({ length: k }, () => "xs = xs + []").join("\n")}\nexit`,
    xs: "list<integer>",
  },
  {
    name: "an otherwise initializer appended",
    source: (k) =>
      `let xs = [1] otherwise [2]\n${Array.from({ length: k }, (_, i) => `xs = xs + [${i + 3}]`).join("\n")}\nexit`,
    xs: "list<integer>",
  },
];

for (const series of FEEDBACK)
  test(`feedback to 200 appends is linear in every phase: ${series.name}`, () => {
    const sizes = [25, 50, 100, 200];
    const runs = sizes.map((k) => solveOf(series.source(k)));
    for (const run of runs) {
      assert.equal(exportFacts(run).bindings.find((b) => b.name === "xs")?.type, series.xs);
      assert.deepEqual(
        run.statuses.filter((status) => status.includes("budget")),
        [],
        "no budget cut on an ordinary append",
      );
    }
    for (const phase of [
      "evaluations",
      "asks",
      "combinations",
      "cells",
      "items",
      "orders",
      "selections",
      "visits",
      "copies",
      "entries",
    ] as const)
      linearInSize(
        `${series.name}: ${phase}`,
        sizes,
        runs.map((run) => run.work[phase]),
        16,
      );
    // the heap's sift iterations are the selections times the heap's depth, never more (the closing check's CC-B2;
    // each iteration compares up to two children: the delta check's DC-S1)
    for (const run of runs)
      assert.ok(
        run.work.siftSteps <= run.work.selections * (2 + Math.log2(run.graph.constraints.length)),
        `${series.name}: sift steps ${run.work.siftSteps} within the heap's bound`,
      );
    // a genuine feedback merges into its binding's structures: into the members by their bases within the first
    // phase, into a witness once the first fixpoint decides it (rule (i)); never a phase per append
    for (const run of runs)
      assert.ok(run.work.phases <= 2, `${series.name}: phases ${run.work.phases}, at most two`);
    assert.equal(
      new Set(runs.map((run) => run.work.phases)).size,
      1,
      `${series.name}: the same phases at every size`,
    );
  });

test("the varied script of the profiler sweep is linear in every counter (every construct mixed)", () => {
  const sizes = [25, 50, 100, 200];
  const runs = sizes.map((k) => solveOf(variedSource(k)));
  for (const [i, run] of runs.entries()) {
    const k = sizes[i]! - 1;
    const facts = exportFacts(run);
    const typeOf = (name: string): string | undefined =>
      facts.bindings.find((b) => b.name === name)?.type;
    assert.equal(typeOf(`l${k}`), "list<integer>");
    assert.equal(typeOf(`o${k}`), '{"a":integer,"b":string,"c":list<integer>}');
    assert.equal(typeOf(`w${k}`), "(list<integer>|list<string>)");
    assert.equal(typeOf(`g${k}`), "list<integer>");
    assert.equal(typeOf(`pr${k}`), "integer");
    assert.deepEqual(
      run.statuses.filter((status) => status.includes("budget")),
      [],
    );
    assert.ok(run.work.phases <= 2, `phases ${run.work.phases}`);
  }
  for (const phase of [
    "evaluations",
    "asks",
    "combinations",
    "foldStates",
    "cells",
    "items",
    "orders",
    "selections",
    "visits",
    "copies",
    "entries",
  ] as const)
    linearInSize(
      `varied: ${phase}`,
      sizes,
      runs.map((run) => run.work[phase]),
      16,
    );
});

test("objects of distinct literal shapes with their own stored names are linear in every counter (the second delta check's DC2-B1)", () => {
  // an object's slots are its own and the alternatives' shape is the group's own slots, never the program's vocabulary
  const varied = (k: number): string =>
    `${Array.from({ length: k }, (_, i) => `let a${i} = {q${i}: 0}\na${i}.p${i} = 1\nlet r${i} = a${i}.p${i}`).join("\n")}\nexit`;
  const sizes = [250, 500, 1000, 2000];
  const runs = sizes.map((k) => solveOf(varied(k)));
  for (const [i, run] of runs.entries()) {
    const facts = exportFacts(run);
    assert.equal(facts.bindings.find((b) => b.name === `r${sizes[i]! - 1}`)?.type, "integer");
    assert.equal(
      facts.bindings.find((b) => b.name === `a${sizes[i]! - 1}`)?.type,
      `{"p${sizes[i]! - 1}":integer,"q${sizes[i]! - 1}":integer}`,
    );
    assert.deepEqual(
      run.statuses.filter((status) => status.includes("budget")),
      [],
    );
  }
  for (const phase of [
    "evaluations",
    "asks",
    "cells",
    "items",
    "selections",
    "visits",
    "copies",
    "entries",
  ] as const)
    linearInSize(
      phase,
      sizes,
      runs.map((run) => run.work[phase]),
      16,
    );
});

test("a scan injected through a counted path fails the growth detector (the real negative control)", () => {
  // the injected scan visits every item of every cell after every evaluation: quadratic, and `visits` sees it
  const one = (k: number): string =>
    `let x = 1\n${Array.from({ length: k }, (_, i) => `x = ${i + 2}`).join("\n")}\nexit`;
  const sizes = [250, 500, 1000, 2000];
  const scanned = sizes.map((k) => {
    const made = request([{ path: "main.tease", source: one(k) }], ["hostValue"], []);
    return solve(collectGraph(made!), {
      relations: RELATIONS,
      injectedScan: (cells) => cells.ids().reduce((n, cell) => n + cells.items(cell).length, 0),
    });
  });
  assert.throws(() =>
    linearInSize(
      "visits with an injected scan",
      sizes,
      scanned.map((run) => run.work.visits),
    ),
  );
  const plain = sizes.map((k) => solveOf(one(k)));
  linearInSize(
    "visits without the scan",
    sizes,
    plain.map((run) => run.work.visits),
  );
});

test("stores to one binding are linear in the schedule to 4,000 stores (Sol's D2)", () => {
  const one = (k: number): string =>
    `let x = 1\n${Array.from({ length: k }, (_, i) => `x = ${i + 2}`).join("\n")}\nexit`;
  const sizes = [500, 1000, 2000, 4000];
  const runs = sizes.map((k) => solveOf(one(k)));
  for (const run of runs)
    assert.equal(exportFacts(run).bindings.find((b) => b.name === "x")?.type, "integer");
  for (const phase of [
    "evaluations",
    "items",
    "selections",
    "visits",
    "copies",
    "entries",
  ] as const)
    linearInSize(
      phase,
      sizes,
      runs.map((run) => run.work[phase]),
      16,
    );
  // the worklist's sift iterations stay within the heap's depth (the closing check's CC-B2)
  for (const run of runs)
    assert.ok(
      run.work.siftSteps <= run.work.selections * (2 + Math.log2(run.graph.constraints.length)),
      `sift steps ${run.work.siftSteps} within the heap's bound`,
    );
});

test("a self-rebuild with no structure to merge into becomes the binding's own at the fixpoint, in bounded phases (the closing check's CC-B1)", () => {
  // a null root gaining its first list, a rebuild of another constructor, and a genuine append: the phases are at
  // most one more than the self-rebuild sites
  const run = solveOf(
    'let xs = null\nxs = toJson(xs).split(",")\nlet ys = [1]\nys = ys.toSet()\nlet zs = [1]\nzs = zs + [2]\nexit',
  );
  const facts = exportFacts(run);
  assert.equal(facts.bindings.find((b) => b.name === "xs")?.type, "(list<string>|null)");
  assert.equal(facts.bindings.find((b) => b.name === "zs")?.type, "list<integer>");
  assert.ok(run.work.phases >= 2 && run.work.phases <= 4, `phases ${run.work.phases}`);
});
