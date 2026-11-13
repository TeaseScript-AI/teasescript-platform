// Forgetting (#1599, #1626): a forget reaches every reader a stop may forget, through an abandoned component and an
// active read, and none follows a run the budget stops.

import assert from "node:assert/strict";
import test from "node:test";
import { BudgetExhausted } from "../../../src/type-inference/core/budget.js";
import { makeItem, mergeItems, type Item } from "../../../src/type-inference/core/items.js";
import {
  Solver,
  withEveryRecord,
  type Demand,
  type Work,
} from "../../../src/type-inference/core/solver.js";
import { itemScope } from "../../helpers/type-core-items.js";

/**
 * #1599: a demand a stop may forget (`mayForget`: it asked a key a decision can still stop) keeps every reader, one as
 * itself, a few as a list, more as a set, so `forget` reaches each of them; a demand no stop can reach keeps none.
 */
test("a forget reaches every reader of a demand a stop may forget, and none of one it cannot (#1599)", () => {
  for (const readers of [1, 2, 8, 9, 12]) {
    for (const reachable of [true, false]) {
      const scope = itemScope();
      const solver = new Solver(scope);
      const leaf: Demand = {
        key: "leaf",
        kind: "contract",
        file: 0,
        offset: 0,
        *make() {
          if (reachable) solver.mayForget("leaf");
          return [makeItem("integer")];
        },
      };
      const read: Demand[] = Array.from({ length: readers }, (_, at) => ({
        key: `r${at}`,
        kind: "contract",
        file: 0,
        offset: at + 1,
        *make() {
          return yield leaf;
        },
      }));
      solver.run(
        (function* (): Work<readonly Item[]> {
          for (const demand of read) yield demand;
          return [];
        })(),
      );
      solver.forget(["leaf"]);
      const kept = read.filter((demand) => solver.answer(demand.key) !== undefined).length;
      assert.equal(kept, reachable ? 0 : readers, `${readers} readers, reachable ${reachable}`);
    }
  }
});

/**
 * #1601's Codex r1 (R1): a component abandoned into a larger one hands its closing demand's provisional answer to that
 * demand's reader, which a stop may then reach: `G` reads `A`, which reads `G` and `B`; `B` reads itself and `A` and may
 * be forgotten. Forgetting `B` forgets all three, as with every record kept (`withEveryRecord`), so reading `G` again
 * charges what reading it the first time did.
 */
test("a forget reaches the reader of a component abandoned into a larger one (#1599)", () => {
  const forgotten = (every: boolean) =>
    (every ? withEveryRecord : <T>(run: () => T): T => run())(() => {
      const scope = itemScope();
      const solver = new Solver(scope);
      const demand = (key: string, offset: number, make: () => Work<readonly Item[]>): Demand => ({
        key,
        kind: "contract",
        file: 0,
        offset,
        make,
      });
      const g: Demand = demand("G", 0, function* () {
        return mergeItems([makeItem("integer"), ...(yield a)], scope);
      });
      const a: Demand = demand("A", 1, function* () {
        const read = yield g;
        if (!read.some((item) => item.tag === "integer")) yield b;
        return [makeItem("string")];
      });
      const b: Demand = demand("B", 2, function* () {
        solver.mayForget("B");
        const own = yield b;
        if (own.length > 0) yield a;
        return [makeItem("integer")];
      });
      const query = function* (): Work<readonly Item[]> {
        return yield g;
      };
      solver.run(query());
      const first = scope.work.total;
      solver.forget(["B"]);
      const kept = [g, a, b]
        .filter((one) => solver.answer(one.key) !== undefined)
        .map((one) => one.key);
      solver.run(query());
      return { kept, first, again: scope.work.total - first };
    });
  const run = forgotten(false);
  assert.deepEqual(run.kept, []);
  assert.equal(run.again, run.first);
  assert.deepEqual(run, forgotten(true));
});

/**
 * #1626: a forget reaches the reader of a member read while it was active (`#read`'s active case), where no later read
 * keeps that reader. `A` reads `M`, `L` and `P`, which a stop may forget; `M` reads `A` before `A` may be forgotten, and
 * its answer is always empty; `L` reads `M` alone and, canonically before it, reruns in the component's solve before
 * `M`'s rerun makes `M` forgettable, which changes no answer. Forgetting `P` forgets all five, as with every record kept
 * (`withEveryRecord`), so reading `G` again charges what reading it the first time did. #1626 records why no admitted
 * source reaches this handoff.
 */
test("a forget reaches the reader of a member read while it was active (#1626)", () => {
  const forgotten = (every: boolean) =>
    (every ? withEveryRecord : <T>(run: () => T): T => run())(() => {
      const scope = itemScope();
      const solver = new Solver(scope);
      const demand = (key: string, offset: number, make: () => Work<readonly Item[]>): Demand => ({
        key,
        kind: "contract",
        file: 0,
        offset,
        make,
      });
      const p: Demand = demand("P", 0, function* () {
        solver.mayForget("P");
        return [makeItem("integer")];
      });
      const g: Demand = demand("G", 1, function* () {
        return yield a;
      });
      const a: Demand = demand("A", 2, function* () {
        return mergeItems([...(yield m), ...(yield l), ...(yield p)], scope);
      });
      const l: Demand = demand("L", 3, function* () {
        return mergeItems([...(yield m), makeItem("string")], scope);
      });
      const m: Demand = demand("M", 4, function* () {
        yield a;
        return [];
      });
      const query = function* (): Work<readonly Item[]> {
        return yield g;
      };
      solver.run(query());
      const first = scope.work.total;
      solver.forget(["P"]);
      const kept = [p, g, a, l, m]
        .filter((one) => solver.answer(one.key) !== undefined)
        .map((one) => one.key);
      solver.run(query());
      return { kept, first, again: scope.work.total - first };
    });
  const run = forgotten(false);
  assert.deepEqual(run.kept, []);
  assert.equal(run.again, run.first);
  assert.deepEqual(run, forgotten(true));
});

/**
 * #1601's Codex r4: the analysis's budget can stop a run at any charge, as between a component's members leaving
 * Tarjan's stack and its solving starting, where a read waits on a return no structure holds. Such a stop ends the
 * pass's decisions (`analyseCore` stops the analysis, `Consumers.finish` closes them), so the run's cleanup closes
 * forgetting instead (`Solver.run`): a `forget` after it throws, as one after the pass's last decision does. Codex's
 * witness: `G` reads `A`, which may be forgotten and reads itself; the eighth unit, `sccMembers`, crosses a seven-unit
 * allowance.
 */
test("a run the analysis's budget stops closes forgetting: no forget follows it (#1599)", () => {
  const scope = itemScope(7);
  const solver = new Solver(scope);
  const a: Demand = {
    key: "A",
    kind: "contract",
    file: 0,
    offset: 1,
    *make() {
      solver.mayForget("A");
      yield a;
      return [makeItem("integer")];
    },
  };
  const g: Demand = {
    key: "G",
    kind: "contract",
    file: 0,
    offset: 0,
    *make() {
      return yield a;
    },
  };
  assert.throws(
    () =>
      solver.run(
        (function* (): Work<readonly Item[]> {
          return yield g;
        })(),
      ),
    BudgetExhausted,
  );
  assert.equal(scope.work.counts().get("sccMembers"), 1);
  assert.throws(() => solver.forget(["A"]), /after the pass's last decision/);
});
