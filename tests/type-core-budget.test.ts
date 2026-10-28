import assert from "node:assert/strict";
import test from "node:test";

import {
  allowanceFor,
  BudgetExhausted,
  ledgerFor,
  WORK_FLOOR,
  WORK_PER_NODE,
  WorkLedger,
  withTestAllowance,
} from "../src/type-inference/core/budget.js";
import {
  alternatives,
  IngressGraph,
  itemsSignature,
  mergeItems,
} from "../src/type-inference/core/items.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { operationItems } from "../src/type-inference/core/operator-table.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { ItemSource } from "./helpers/type-core-items.js";

// The work budget (TABLE §8; the reference model's `budget-check.mjs`, checks 1 and 2): the counters sum to the charged
// total, and an analysis stops at exactly the unit that crosses its allowance. This proves the accounting, not that
// every loop is charged: that is review's and the work tests' to show.

/** A fixed amount of item work charged to `work`: merges, alternatives, signatures and operations from one seed. */
function workload(work: WorkLedger): void {
  const scope = { work, ingress: new IngressGraph() };
  const source = new ItemSource(4242, scope);
  for (let round = 0; round < 200; round += 1) {
    const a = source.items(1 + source.below(4));
    const b = source.items(1 + source.below(4));
    itemsSignature(alternatives([...a, ...b], scope), scope);
    operationItems(
      source.pick(["+", "-", "*", "/", "<"] as const),
      [mergeItems(a, scope), mergeItems(b, scope)],
      scope,
      { file: 0, start: round, end: round + 1 },
    );
  }
}

const counted = (work: WorkLedger): number =>
  [...work.counts().values()].reduce((sum, units) => sum + units, 0);

test("the counters sum to the charged total", () => {
  const work = new WorkLedger(Number.MAX_SAFE_INTEGER);
  workload(work);
  assert.equal(counted(work), work.total);
  assert.deepEqual([...work.counts().keys()].sort(), ["mergeItems", "operatorSteps", "sigItems"]);
});

test("an analysis stops at the unit that crosses its allowance, and runs to the end within it", () => {
  const unbounded = new WorkLedger(Number.MAX_SAFE_INTEGER);
  workload(unbounded);
  const total = unbounded.total;
  const under = new WorkLedger(total - 1);
  assert.throws(
    () => workload(under),
    (error: unknown) => error instanceof BudgetExhausted && error.limit === "work",
  );
  assert.equal(under.total, total);
  assert.equal(counted(under), total);
  const at = new WorkLedger(total);
  workload(at);
  assert.equal(at.total, total);
});

test("the allowance is 30,000,000 or 256 per syntax node, whichever is larger", () => {
  const crossing = Math.ceil(WORK_FLOOR / WORK_PER_NODE);
  assert.equal(allowanceFor(0), 30_000_000);
  assert.equal(allowanceFor(crossing - 1), 30_000_000);
  assert.equal(allowanceFor(crossing), 256 * crossing);
  assert.equal(ledgerFor(crossing + 1000).allowance, 256 * (crossing + 1000));
});

test("a test allowance holds for every ledger made inside it, and only there", () => {
  assert.equal(
    withTestAllowance(10, () => ledgerFor(1_000_000).allowance),
    10,
  );
  assert.equal(ledgerFor(1_000_000).allowance, 256_000_000);
  assert.throws(
    () => withTestAllowance(10, () => withTestAllowance(20, () => 0)),
    /already active/u,
  );
  assert.throws(() =>
    withTestAllowance(10, () => {
      throw new Error("inside");
    }),
  );
  assert.equal(ledgerFor(0).allowance, WORK_FLOOR);
  // the seam reaches the limit with a small workload
  assert.throws(
    () => withTestAllowance(50, () => workload(ledgerFor(0))),
    (error: unknown) => error instanceof BudgetExhausted,
  );
});

/** A project's request, its files parsing and resolving. */
function requestOf(files: readonly { readonly path: string; readonly source: string }[]) {
  const request = coreRequest(files);
  assert.ok(request !== null, "the files parse and resolve");
  return request;
}

const main = (source: string) => [{ path: "main.tease", source }];

/** An analysis in the source order, or with the consumers' and the solver's orders reversed (`reversed`). */
function analysed(request: ReturnType<typeof requestOf>, reversed = false, allowance?: number) {
  const run = () =>
    allowance === undefined
      ? analyseCore(request)
      : withTestAllowance(allowance, () => analyseCore(request));
  return reversed
    ? withSolverSeam({ reverseWorklist: true }, () =>
        withConsumerOrder((list) => [...list].reverse(), run),
      )
    : run();
}

/** A stopped analysis as these tests compare it: its outcome, limit, shown diagnostics and the checks it moved. */
function stopOf(answers: ReturnType<typeof analyseCore>, source: string) {
  const text = (site: { readonly start: number; readonly end: number }) =>
    source.slice(site.start, site.end);
  return {
    outcome: answers.outcome,
    exhausted: answers.budget.exhausted,
    errors: answers.diagnostics
      .filter((diagnostic) => diagnostic.class === "compile-error")
      .map((diagnostic) => `${diagnostic.code} ${text(diagnostic.site)}`),
    stops: answers.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "budget" && diagnostic.class === "warning-runtime-check",
    ).length,
    unchecked: answers.diagnostics
      .filter((diagnostic) => diagnostic.class === "not-checked-budget")
      .map((diagnostic) =>
        diagnostic.kind === "budget" ? (diagnostic.place.name ?? "top level") : "",
      ),
    deferred: answers.budget.deferred.map(
      (diagnostic) =>
        `${diagnostic.obligation.kind} ${text(diagnostic.site)} ${diagnostic.provenance.context}`,
    ),
  };
}

test("after a stop the ledger counts only finishing work, and before it each unit to its spender", () => {
  const work = new WorkLedger(10);
  work.spender = 3;
  work.charge("checks", 4);
  work.spender = 0;
  work.charge("checks", 5);
  assert.throws(
    () => work.charge("checks", 2),
    (error: unknown) => error instanceof BudgetExhausted && error.limit === "work",
  );
  work.stop("work");
  work.charge("checks", 100);
  assert.deepEqual(
    {
      total: work.total,
      finishing: work.finishing,
      stopped: work.stopped,
      spent: [...work.spent()],
    },
    { total: 11, finishing: 100, stopped: "work", spent: [7, undefined, undefined, 4] },
  );
  // (a later limit does not replace the first)
  work.stop("read-depth");
  assert.equal(work.stopped, "work");
});

/**
 * TABLE r4.55, S3 §5: the pipeline handles depth 10,000; the consumers of statements nested past the core's 256 are
 * checked when the script runs, every other statement proved as ever (admission still decides every place from every
 * store), an `else if` one level more: a check inside them is moved, an error outside stands, and one warning names the
 * deepest nesting's place.
 */
test("statements nested past 256 levels are checked when the script runs, the rest proved (TABLE r4.55)", () => {
  const nested = (depth: number) =>
    `let k: integer = 1.5\n${"if hostValue == 1 {\n".repeat(depth)}say "\${hostValue}"\n${"}\n".repeat(depth)}exit`;
  const chained = (length: number) =>
    `let n = 1\n${Array.from({ length }, (_, i) => `${i === 0 ? "" : "else "}if n == ${i} { say "\${hostValue}" }`).join("\n")}\nexit`;
  const at256 = stopOf(analysed(requestOf(main(nested(256)))), nested(256));
  assert.deepEqual(
    { ...at256, deferred: at256.deferred.length },
    {
      outcome: "compile-error",
      exhausted: null,
      errors: ["TSV041 1.5"],
      stops: 0,
      unchecked: [],
      deferred: 0,
    },
  );
  for (const reversed of [false, true])
    assert.deepEqual(stopOf(analysed(requestOf(main(nested(257))), reversed), nested(257)), {
      outcome: "compile-error",
      exhausted: "nesting",
      errors: ["TSV041 1.5"],
      stops: 1,
      unchecked: ["top level"],
      // (the host read is its own data after the stop, as unstopped: S3 §5 revision 18, TABLE r4.109 (1))
      deferred: ["operand hostValue unknown"],
    });
  assert.equal(analysed(requestOf(main(chained(255)))).budget.exhausted, null);
  const chain = stopOf(analysed(requestOf(main(chained(257)))), chained(257));
  assert.deepEqual([chain.exhausted, chain.stops, chain.deferred.length > 0], ["nesting", 1, true]);
});

/**
 * D4 a′ (TABLE r4.54): a stop is no compile error. At every allowance below the analysis's work, wherever the stop
 * falls (the setup, admission, the walk), in both orders: the literal error stands (found before the stop, or by the
 * finishing path, which knows a literal's kind); the count that waits on the recursive contract is checked when the
 * script runs; one warning; and the finishing path's work stays within a small multiple of the program's size.
 */
test("a stop never rejects a script: its findings stand and the rest is checked when it runs, in both orders", () => {
  const source =
    'let x = "s" - 1\nfunction chain(n: integer) {\n  if n == 0 { return {value: 1, next: null} }\n  return {value: n, next: chain(n - 1)}\n}\nfunction last(node) {\n  if node.next == null { return node.value }\n  return last(node.next)\n}\nrepeat last(chain(3)) {}\nexit';
  const request = requestOf(main(source));
  const nodes = analysed(request, false, 1_000_000).budget.counts.get("syntaxNodes")!;
  for (const reversed of [false, true])
    for (let allowance = 250; allowance <= 64_000; allowance *= 2) {
      const answers = analysed(request, reversed, allowance);
      const stop = stopOf(answers, source);
      const where = `${allowance}${reversed ? " reversed" : ""}`;
      assert.deepEqual(
        [stop.outcome, stop.exhausted, stop.errors, stop.stops],
        ["compile-error", "work", ['TSV043 "s"'], 1],
        where,
      );
      assert.ok(stop.deferred.includes("integer-check last(chain(3)) budget"), where);
      assert.ok(
        answers.budget.finishing <= 16 * nodes,
        `${where}: ${answers.budget.finishing} units`,
      );
    }
  // the same program without the literal error compiles with the warning
  const quiet = source.replace('let x = "s" - 1\n', "");
  assert.equal(
    stopOf(analysed(requestOf(main(quiet)), false, 4_000), quiet).outcome,
    "warning-runtime-check",
  );
});

test("a stop at any unit keeps a store's check, in admission, in the walk and in the publication (D4 a′)", () => {
  // external data stored into a written type: a warning's check before the stop, a moved check after it; the stop at
  // each unit of the analysis in turn (a stop in admission or the publication once took the warning back unmoved)
  const source = 'let v = hostValue\nlet n: integer = v\nsay "AFTER"\nexit';
  const request = requestOf(main(source));
  const total = analysed(request).budget.total;
  const lost: number[] = [];
  for (let allowance = 1; allowance < total; allowance += 1)
    if (
      !analysed(request, false, allowance).checks.some(
        (check) =>
          check.kind === "copy-type" && source.slice(check.site.start, check.site.end) === "v",
      )
    )
      lost.push(allowance);
  assert.deepEqual(lost, []);
});

test("the stop's warning names the heaviest place and marks each function it left unchecked once", () => {
  // forty functions, the stop in the walk over their counts: those it reached keep their proofs
  const source = `${Array.from({ length: 40 }, (_, i) => `function f${i}(p) {\n  repeat p {}\n}\nf${i}(${i})`).join("\n")}\nexit`;
  const request = requestOf(main(source));
  const total = analysed(request).budget.total;
  for (const fraction of [0.95, 0.5, 0.01]) {
    const answers = analysed(request, false, Math.floor(total * fraction));
    const stop = stopOf(answers, source);
    assert.equal(stop.stops, 1, String(fraction));
    // once per function, exactly those whose checks moved, and the top level where a stop before admission settled
    // marks the arguments into the inferred parameters (TABLE r4.110 (3))
    const functions = Array.from({ length: 40 }, (_, i) => {
      const text = `function f${i}(p) {\n  repeat p {}\n}`;
      const start = source.indexOf(text);
      return { name: `f${i}`, start, end: start + text.length };
    });
    const moved = new Set(
      answers.budget.deferred.map(
        (d) =>
          functions.find((f) => f.start <= d.site.start && d.site.end <= f.end)?.name ??
          "top level",
      ),
    );
    assert.deepEqual([...stop.unchecked].sort(), [...moved].sort(), String(fraction));
    const summary = answers.diagnostics.find(
      (diagnostic) => diagnostic.kind === "budget" && diagnostic.class === "warning-runtime-check",
    );
    assert.ok(summary?.kind === "budget" && summary.class === "warning-runtime-check");
    assert.equal(summary.deferred, stop.deferred.length);
    assert.ok(
      summary.place.name !== null && /^f\d+$/.test(summary.place.name),
      summary.place.name ?? "",
    );
  }
});

/**
 * S8's obligations (TABLE r4.55 (3)): the finishing path is bounded when the setup, admission's passes, or a recursive
 * contract spend the allowance. Each stop compiles, with one warning and its checks, its finishing work small; where
 * every store's syntax decides what the program owes (`f(2)` decides `p`: TABLE r4.122), a stop defers nothing.
 */
test("the finishing path is bounded after a stop in the setup, in admission's passes and in a recursive contract", () => {
  const cases: readonly (readonly [
    string,
    readonly { path: string; source: string }[],
    boolean,
  ])[] = [
    [
      "the setup (every file calls every file)",
      [
        {
          path: "main.tease",
          source: 'function f(p) {\n  repeat p {}\n}\nf(2)\ncall "parts/*.tease"\nexit',
        },
        ...Array.from({ length: 6 }, (_, i) => ({
          path: `parts/f${i}.tease`,
          source: 'call "parts/*.tease"\nend',
        })),
      ],
      false,
    ],
    [
      "admission's passes (a chain of rejections)",
      main(
        `let v0 = 0\nv0 = "x"\n${Array.from({ length: 12 }, (_, i) => `let v${i + 1} = v${i}\nv${i + 1} = "x"`).join("\n")}\nlet final: integer = v12\nexit`,
      ),
      true,
    ],
    [
      "a recursive record type",
      main(
        "function f(n: integer) {\n  if n == 0 { return {custom: 1} }\n  if n == 1 { return {custom: f(0)} }\n  return f(n - 1).custom\n}\nrepeat f(3) {}\nexit",
      ),
      true,
    ],
  ];
  for (const [name, files, defers] of cases) {
    const request = requestOf(files);
    // (the stops are sampled below 100,000 units: a run to that point gives the program's size and its own total)
    const full = analysed(request, false, 100_000);
    const nodes = full.budget.counts.get("syntaxNodes")!;
    const total = Math.min(full.budget.total, 100_000);
    for (const reversed of [false, true])
      for (const fraction of [0.9, 0.5, 0.1, 0.02]) {
        const answers = analysed(request, reversed, Math.max(1, Math.floor(total * fraction)));
        const where = `${name} ${fraction}${reversed ? " reversed" : ""}`;
        assert.equal(answers.budget.exhausted, "work", where);
        assert.notEqual(answers.outcome, "valid", where);
        assert.equal(
          answers.diagnostics.filter(
            (d) => d.kind === "budget" && d.class === "warning-runtime-check",
          ).length,
          1,
          where,
        );
        assert.equal(answers.budget.deferred.length > 0, defers, where);
        assert.ok(
          answers.budget.finishing <= 16 * nodes,
          `${where}: ${answers.budget.finishing} units`,
        );
      }
  }
});

/**
 * TABLE r4.100 (2), r4.126 (Astra r4's shape): after a stop at the first unit a list literal nested k deep finishes in
 * work linear in k. The fresh pass's copy sources made each path below the literal again at every depth, k² steps
 * (8,022 finishing units for 140 nodes); each path is now a step from its owner's, made into an array only where a copy
 * lands. Linear, not `16 × nodes`: the program's own index, built after a stop at the first unit, costs about 21 units
 * per node of this shape.
 */
test("a stop at the first unit finishes a deeply nested list literal in linear work", () => {
  const finishing = (k: number) => {
    const source = `let xs = ${"[".repeat(k)}1${"]".repeat(k)}\nsay "DONE"\nexit`;
    const { budget } = analysed(requestOf(main(source)), false, 1);
    assert.equal(budget.exhausted, "work");
    return { units: budget.finishing, nodes: budget.counts.get("syntaxNodes")! };
  };
  const [small, large] = [finishing(64), finishing(128)];
  const doubling = (2 * (large.units / small.units)) / (large.nodes / small.nodes);
  assert.ok(
    doubling <= 2.15,
    `${small.units} -> ${large.units} units: ${doubling.toFixed(3)} per doubling`,
  );
});

/**
 * PLAN §6b's recursive record types (Astra's rounds 2–3): a linked list built by `chain(n)` and walked by `last(node)`
 * through `node.next` reaches any allowance; the stop answers every value it did not decide `unknown` with `budget`,
 * never asking its contract again, so the fallback is finite (S3 §5) and the count is checked when it runs.
 */
test("a linked record list stops at the allowance with its count checked when it runs, in either order", () => {
  const source =
    "function chain(n: integer) {\n  if n == 0 { return {value: 1, next: null} }\n  return {value: n, next: chain(n - 1)}\n}\nfunction last(node) {\n  if node.next == null { return node.value }\n  return last(node.next)\n}\nrepeat last(chain(3)) {}\nexit";
  const request = requestOf(main(source));
  for (const reversed of [false, true]) {
    const stop = stopOf(analysed(request, reversed, 100_000), source);
    assert.deepEqual(
      [stop.outcome, stop.exhausted, stop.errors, stop.stops, stop.unchecked.sort()],
      ["warning-runtime-check", "work", [], 1, ["chain", "last", "top level"]],
    );
    assert.ok(stop.deferred.includes("integer-check last(chain(3)) budget"));
  }
});
