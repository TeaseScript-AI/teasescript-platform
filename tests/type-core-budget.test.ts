import assert from "node:assert/strict";
import test from "node:test";

import {
  allowanceFor,
  BudgetExhausted,
  checkNesting,
  ledgerFor,
  NESTING_LIMIT,
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

test("statements nest 256 deep", () => {
  assert.equal(NESTING_LIMIT, 256);
  checkNesting(256);
  assert.throws(
    () => checkNesting(257),
    (error: unknown) => error instanceof BudgetExhausted && error.limit === "nesting",
  );
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

test("an analysis stopped in its consumers publishes its stop, computing nothing more after it", () => {
  // forty functions, most of whose call sites the stopped consumers never counted (their single-site memo empty)
  const source = `${Array.from({ length: 40 }, (_, i) => `function f${i}(p) {\n  repeat p {}\n}\nf${i}(${i})`).join("\n")}\nexit`;
  const request = (): NonNullable<ReturnType<typeof coreRequest>> => {
    const made = coreRequest([{ path: "main.tease", source }]);
    assert.ok(made !== null);
    return made;
  };
  const total = analyseCore(request()).budget.total;
  const stopped = withTestAllowance(Math.floor(total * 0.95), () => analyseCore(request()));
  assert.deepEqual(
    { outcome: stopped.outcome, exhausted: stopped.budget.exhausted, deferred: stopped.deferred },
    { outcome: "budget-error", exhausted: "work", deferred: { parameters: [], results: [] } },
  );
});

test("an analysis stopped anywhere, its setup included, publishes its stop", () => {
  // files that each call every file (W13's call graph) beside a function: setup, solver and consumers all charge
  const part = 'call "parts/*.tease"\nend';
  const files = [
    {
      path: "main.tease",
      source: 'function f(p) {\n  repeat p {}\n}\nf(2)\ncall "parts/*.tease"\nexit',
    },
    ...Array.from({ length: 6 }, (_, i) => ({ path: `parts/f${i}.tease`, source: part })),
  ];
  const request = (): NonNullable<ReturnType<typeof coreRequest>> => {
    const made = coreRequest(files);
    assert.ok(made !== null);
    return made;
  };
  const total = analyseCore(request()).budget.total;
  const stops: string[] = [];
  let inSetup = 0;
  for (let step = 1; step < 32; step += 1) {
    const stopped = withTestAllowance(Math.floor((total * step) / 32), () =>
      analyseCore(request()),
    );
    stops.push(`${stopped.outcome} ${stopped.budget.exhausted} ${stopped.diagnostics.length}`);
    if (!stopped.budget.counts.has("frames")) inSetup += 1;
  }
  assert.deepEqual(
    stops,
    Array.from({ length: 31 }, () => "budget-error work 0"),
  );
  assert.ok(inSetup > 0, "some stop falls in the setup");
  assert.equal(withTestAllowance(total, () => analyseCore(request())).outcome, "valid");
});

/**
 * A known limit until S8 (the lead's ruling): a recursive record type, whose record alternative itself holds the
 * recursion, is followed at ever deeper paths, so this terminating program stops at the work allowance (30,000,001
 * units, 10 to 14 s, in both orders). S8's fallback turns the stop into warnings with runtime checks; the candidate
 * repair is a depth bound from the program's own structure, deeper paths answered `unknown`. Pinned here: the stop is
 * clean, in both orders.
 */
test("a recursive record type stops cleanly with budget-error, in either order (a known limit until S8)", () => {
  const source =
    "function f(n: integer) {\n  if n == 0 { return {custom: 1} }\n  if n == 1 { return {custom: f(0)} }\n  return f(n - 1).custom\n}\nrepeat f(3) {}\nexit";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const got = [false, true].map((reversed) => {
    const run = (): ReturnType<typeof analyseCore> =>
      withTestAllowance(100_000, () =>
        withSolverSeam({ reverseWorklist: reversed }, () => analyseCore(request)),
      );
    const answers = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    return `${answers.outcome} ${answers.budget.exhausted} ${answers.diagnostics.length}`;
  });
  assert.deepEqual(got, ["budget-error work 0", "budget-error work 0"]);
});
