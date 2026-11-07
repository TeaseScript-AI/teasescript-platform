import assert from "node:assert/strict";
import test from "node:test";

import { sortCost } from "../src/type-inference/core/definitions.js";
import { WorkLedger } from "../src/type-inference/core/budget.js";
import {
  concatenated,
  copied,
  each,
  indexed,
  joined,
  sliced,
  some,
  sorted,
  steps,
} from "../src/type-inference/core/narrowing-iteration.js";

/*
 * The charged helpers' laws (#1747's charging round, `narrowing-iteration.ts`): each item, prefix, copied element and
 * joined part taken is charged, a repeated one too, and a charge that stops the analysis stops the body, the copy or
 * the sort before it runs. `objects.ts` and the narrowing modules iterate only through them (the charged-iteration lint).
 */

const C = "objectSteps";

/** A ledger with room for every law, and its units charged so far. */
function ledger(): { readonly work: WorkLedger; units(): number } {
  const work = new WorkLedger(1_000_000);
  return { work, units: () => work.counts().get(C) ?? 0 };
}

test("each charged helper charges every item it takes, a repeated one too, and no more", () => {
  const cases: readonly (readonly [string, (work: WorkLedger) => unknown, unknown, number])[] = [
    ["each", (work) => [...each(work, C, [3, 1, 2])], [3, 1, 2], 3],
    ["each, repeated items", (work) => [...each(work, C, [3, 3, 3])], [3, 3, 3], 3],
    ["copied", (work) => copied(work, C, [3, 1, 2]), [3, 1, 2], 3],
    ["indexed", (work) => [...indexed(work, C, [3, 1, 2], 1)], [1, 2], 2],
    ["sliced", (work) => sliced(work, C, [3, 1, 2], 1), [1, 2], 2],
    ["concatenated", (work) => concatenated(work, C, [[3, 1], [2]]), [3, 1, 2], 5],
    ["joined", (work) => joined(work, C, ["a", "b", "c"], "."), "a.b.c", 3],
    ["some, to its first hit", (work) => some(work, C, [3, 1, 2], (item) => item === 1), true, 2],
    ["sorted", (work) => sorted(work, C, [3, 1, 2]), [1, 2, 3], sortCost(3)],
  ];
  for (const [name, run, expected, units] of cases) {
    const { work, units: charged } = ledger();
    assert.deepEqual(run(work), expected, name);
    assert.equal(charged(), units, name);
  }
  // (an early end charges only what was taken; a step walk each step it takes)
  const short = ledger();
  for (const item of each(short.work, C, [3, 1, 2])) if (item === 3) break;
  assert.equal(short.units(), 1);
  const walk = ledger();
  let taken = 0;
  for (const _ of steps(walk.work, C, () => taken < 3)) taken += 1;
  assert.equal(walk.units(), 3);
});

test("a charge that stops the analysis stops each helper's body, copy and sort before it runs", () => {
  // (a ledger with no room: its first charge throws)
  const stopped = (): WorkLedger => new WorkLedger(0);
  let body = 0;
  assert.throws(() => {
    for (const _ of each(stopped(), C, [1, 2, 3])) body += 1;
  });
  assert.throws(() => {
    for (const _ of indexed(stopped(), C, [1, 2, 3])) body += 1;
  });
  assert.equal(body, 0);
  const tested: number[] = [];
  assert.throws(() =>
    some(stopped(), C, [1, 2], (item) => {
      tested.push(item);
      return false;
    }),
  );
  assert.deepEqual(tested, []);
  const items = [3, 1, 2];
  assert.throws(() => sorted(stopped(), C, items));
  assert.deepEqual(items, [3, 1, 2]);
  for (const copy of [
    () => sliced(stopped(), C, [1, 2], 0),
    () => copied(stopped(), C, [1, 2]),
    () => joined(stopped(), C, ["a", "b"], "."),
  ])
    assert.throws(copy);
});
