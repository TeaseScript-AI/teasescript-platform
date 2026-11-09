import assert from "node:assert/strict";
import test from "node:test";

import { sortCost } from "../../src/type-inference/core/definitions.js";
import { WorkLedger } from "../../src/type-inference/core/budget.js";
import {
  concatenated,
  copied,
  each,
  indexed,
  joined,
  mapped,
  sliced,
  some,
  sorted,
  steps,
} from "../../src/type-inference/core/charged-iteration.js";

/*
 * The charged helpers' laws (#1747's charging round, `charged-iteration.ts`): each item, prefix, copied element and
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
  type Taken = readonly number[] | string | boolean;
  const cases: readonly (readonly [string, (work: WorkLedger) => Taken, Taken, number])[] = [
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

test("a charge that stops the analysis stops each helper's body, read, copy, join and sort before it runs", () => {
  // (a ledger with no room: its first charge throws; each item read, mapped or tested is an observed effect, and
  // `copied` is `mapped` with no effect of its own)
  const stopped = (): WorkLedger => new WorkLedger(0);
  let effects = 0;
  const observed = (): string[] => {
    const items: string[] = [];
    for (let at = 0; at < 2; at += 1)
      Object.defineProperty(items, at, {
        enumerable: true,
        get: () => {
          effects += 1;
          return "a";
        },
      });
    return items;
  };
  const positions = {
    length: 2,
    at: (): string => {
      effects += 1;
      return "a";
    },
  };
  const counted = (item: number): number => {
    effects += 1;
    return item;
  };
  const runs: readonly (readonly [string, () => void])[] = [
    [
      "each",
      () => {
        for (const item of each(stopped(), C, [1, 2, 3])) counted(item);
      },
    ],
    ["indexed", () => [...indexed(stopped(), C, positions)]],
    ["some", () => some(stopped(), C, [1, 2], (item) => counted(item) < 0)],
    ["mapped", () => mapped(stopped(), C, [1, 2], counted)],
    ["sliced", () => sliced(stopped(), C, observed(), 0)],
    ["joined", () => joined(stopped(), C, observed(), ".")],
  ];
  for (const [name, run] of runs) {
    effects = 0;
    assert.throws(run, name);
    assert.equal(effects, 0, name);
  }
  const items = [3, 1, 2];
  assert.throws(() => sorted(stopped(), C, items));
  assert.throws(() => copied(stopped(), C, [1, 2]));
  assert.deepEqual(items, [3, 1, 2]);
});
