// pins: a store check's work per mode | line /^\s*\[\d{4,}, \d+\],$/u
// The work a long copied key's store check charges after the analysis (#1605): its growth with the copy chain, and its
// charges in every mode.

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { WorkLedger, type WorkCounter } from "../../../src/type-inference/core/budget.js";
import { storeContracts } from "../../../src/type-inference/core/check-result/check-result.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { COPY_CHAIN_FAMILIES } from "../../helpers/type-core/families/copy-chains.js";
import {
  type Sized,
  sized,
  type Measured,
  steepCounters,
} from "../../helpers/type-core/type-core-work.js";

/**
 * The work the store checks charge after a family's analysis (`storeContracts`), every unit by counter (apart work
 * too, as #1605 measured it) with the analysis's syntax nodes, in a mode; and the analysis's charged total.
 */
function storeWork(
  { name, request }: Sized,
  reversed: boolean,
  unshared: boolean,
): Measured & { readonly analysis: number } {
  const counts = new Map<WorkCounter, number>();
  let total = 0;
  let analysis = 0;
  const { charge } = WorkLedger.prototype;
  const run = (): void => {
    const answers = analyseCore(request);
    assert.equal(answers.budget.exhausted, null, `${name}: within the allowance`);
    analysis = answers.budget.total;
    counts.set("syntaxNodes", answers.budget.counts.get("syntaxNodes") ?? 0);
    WorkLedger.prototype.charge = function (this: WorkLedger, counter, units = 1) {
      if (counter !== "syntaxNodes") counts.set(counter, (counts.get(counter) ?? 0) + units);
      total += units;
      charge.call(this, counter, units);
    };
    try {
      assert.deepEqual(
        [...storeContracts(answers, request).values()].map((result) => result.state),
        ["complete"],
        name,
      );
    } finally {
      WorkLedger.prototype.charge = charge;
    }
  };
  const ordered = (): void =>
    reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, run),
        )
      : run();
  if (unshared) withoutSharing(ordered);
  else ordered();
  return { total, counts, analysis };
}

/**
 * #1605: a value copied through a chain of wrappers, a store at its long key or the key's element checked: the check's
 * contract at each level of the stored value (its element, its element's element) stands one step below its parent's
 * position (`positions.ts`), never every wrapper's whole path again, so the work the store checks charge after the
 * analysis, in total and by each counter of at least 200 units, grows with the chain at k = 16 → 32 in every mode
 * (3.38 to 3.76 per doubling on `3d052bf43`). The series to k = 128 and the analysis beside a long key without copies
 * are the PR's evidence, outside CI.
 */
test("a long copied key's store check grows with its copy chain in every mode (#1605)", () => {
  const measure =
    (unshared: boolean) =>
    (at: Sized, reversed: boolean): Measured =>
      storeWork(at, reversed, unshared);
  assert.deepEqual(
    [
      ...steepCounters(COPY_CHAIN_FAMILIES, false, measure(false), [16, 32]),
      ...steepCounters(COPY_CHAIN_FAMILIES, true, measure(true), [16, 32]),
    ],
    [],
  );
});

/**
 * #1605: what a long copied key's store check charges at k = 16 in each mode (source order shared and not, then
 * reversed), with its analysis's charged total: a regression oracle of this construction only, so a level's work
 * charged nowhere shows. Since #1526 phase B the analysis captures the store's contract before its walk, so most of the
 * check's work is charged there: on `c0ab92ced`, before the capture, the analyses charged 7,843 / 7,003, 8,971 / 8,098
 * and 10,226 / 9,225 (10,228 reversed) and the checks after them 451 / 380, 274 / 236 and 518 / 429. The store at the
 * element (`b.q….f[0] = …`) is outside the candidate slice's syntax, so the analysis captures nothing there and its work
 * is main's (`slice-syntax.ts`). On `3d052bf43`
 * the store at the long key's check charged 3,266 and 2,197 units; the store at its element's analysis asked its
 * element levels through every wrapper (10,329 and 8,632), its check 1,101 and 889; the store at a property of its
 * element's 12,448 and 10,225, its check 2,353 and 1,880. Since #1221 the analyses charge the event searches by
 * comparison (8,257 / 7,346, 8,971 / 8,098 and 10,707 / 9,617 (10,709 reversed) before), and since #1251 they make no
 * narrowing index for these programs without a test (8,257 / 7,344, 8,963 / 8,088 and 10,690 / 9,598 before), and since
 * #1822 a read signature's prefixes come from its charged trie walk (`rdWalk`: 7,986 / 7,073, 8,689 / 7,814 and
 * 10,411 / 9,319 (10,413 reversed) before), and since #2764 they build the nesting index for the long key's first path
 * with two element steps (213, 218 and 238 `indexSteps` more in each analysis; the checks' work is unchanged).
 */
test("a long copied key's store check charges its positions' work, in every mode (#1605)", () => {
  const measured = COPY_CHAIN_FAMILIES.map((family) => {
    const at = sized(family, 16);
    return [false, true].flatMap((reversed) =>
      [false, true].map((unshared) => {
        const { total, analysis } = storeWork(at, reversed, unshared);
        return [analysis, total];
      }),
    );
  });
  assert.deepEqual(measured, [
    [
      [8208, 60],
      [7294, 60],
      [8208, 60],
      [7294, 60],
    ],
    [
      [8916, 274],
      [8040, 236],
      [8916, 274],
      [8040, 236],
    ],
    [
      [10658, 64],
      [9565, 64],
      [10660, 64],
      [9565, 64],
    ],
  ]);
});
