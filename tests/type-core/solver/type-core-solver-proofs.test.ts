// Proof demands: a finished proof read with its answer, solved to a fixed point, started again when a component grows
// or a decision is held, and kept only with its answer at a stop.

import assert from "node:assert/strict";
import test from "node:test";
import { BudgetExhausted } from "../../../src/type-inference/core/budget.js";
import {
  itemsSignature,
  makeItem,
  STOPPED,
  type Item,
} from "../../../src/type-inference/core/items.js";
import {
  Solver,
  withSolverSeam,
  type Demand,
  type Proof,
  type ProofDecision,
  type ProofDemand,
  type Work,
} from "../../../src/type-inference/core/solver.js";
import { itemScope } from "../../helpers/type-core-items.js";

/**
 * Proof payloads (docs/specifications/type-inference-accepted-record/sharing.md#r4-164; `ProofDemand`): a proof is the
 * solver's as a demand's items are. The tests' proofs hold what was chosen (`null` for an absence), the kinds seen and
 * a round counter; their signature is all three.
 */
interface Chosen extends Proof {
  readonly chosen: string | null;
  readonly tags: readonly string[];
  readonly n: number;
}

function chosen(choice: string | null, tags: readonly string[], n: number): Chosen {
  return {
    chosen: choice,
    tags,
    n,
    signature: (scope) => {
      scope.work.charge("sigItems");
      return `${choice ?? "-"}|${tags.join(",")}|${n}`;
    },
  };
}

/** A test's proof demand at `offset`, its run `make`. */
function proofDemand(
  key: string,
  offset: number,
  make: () => Work<{ readonly items: readonly Item[]; readonly proof: Chosen }>,
): ProofDemand<Chosen> {
  return { key, kind: "value", file: 0, offset, make, proves: true };
}

test("a finished proof is read with its answer by its first reader and by a later one, made once", () => {
  const scope = itemScope();
  const solver = new Solver(scope);
  let runs = 0;
  const producer = proofDemand("p", 0, function* () {
    runs += 1;
    scope.work.charge("invSteps", 100);
    return { items: [makeItem("integer")], proof: chosen("a", [], 0) };
  });
  const dependent: Demand = {
    key: "d",
    kind: "value",
    file: 0,
    offset: 1,
    *make() {
      const { items, proof } = yield* solver.proven(producer);
      return proof?.chosen === "a" ? [...items, makeItem("string")] : [];
    },
  };
  const read = solver.run(
    (function* (): Work<readonly Item[]> {
      return yield dependent;
    })(),
  );
  assert.deepEqual(
    read.map((item) => item.tag),
    ["integer", "string"],
  );
  const before = scope.work.total;
  const again = solver.run(solver.proven(producer));
  assert.equal(runs, 1);
  assert.equal(again.proof?.chosen, "a");
  assert.deepEqual(
    again.items.map((item) => item.tag),
    ["integer"],
  );
  // (the later read pays its lookup, not the producer's work, which stays its first reader's)
  assert.ok(scope.work.total - before < 100);
  assert.deepEqual(
    solver.demandWork().map(({ key, units }) => [key, units >= 100]),
    [
      ["p", true],
      ["d", true],
    ],
  );
});

/** A member's proof one round further, to `limit`: the kinds it read beside its own, the same items every round. */
function* counted(
  solver: Solver,
  self: () => ProofDemand<Chosen>,
  reads: readonly (() => Demand | ProofDemand<Chosen>)[],
  limit: number,
): Work<{ readonly items: readonly Item[]; readonly proof: Chosen }> {
  const own = (yield* solver.proven(self())).proof;
  const tags = new Set(own?.tags ?? []);
  let n = own === null ? 0 : Math.min(own.n + 1, limit);
  for (const read of reads) {
    const demand = read();
    if (demand.proves === undefined) for (const item of yield demand) tags.add(item.tag);
    else {
      const other = (yield* solver.proven(demand)).proof;
      for (const tag of other?.tags ?? []) tags.add(tag);
      n = Math.max(n, other?.n ?? 0);
    }
  }
  return { items: [makeItem("integer")], proof: chosen("a", [...tags].sort(), n) };
}

/** Every member's finished answer and proof signature, from each entry and in either order. */
function solvedFrom(
  entries: readonly string[],
  build: (solver: Solver) => ReadonlyMap<string, ProofDemand<Chosen>>,
): Set<string> {
  const got = new Set<string>();
  for (const entry of entries)
    for (const reverseWorklist of [false, true])
      withSolverSeam({ reverseWorklist }, () => {
        const scope = itemScope();
        const solver = new Solver(scope);
        const demands = build(solver);
        solver.run(solver.proven(demands.get(entry)!));
        const answers = [...demands.values()].map((demand) => {
          const { items, proof } = solver.run(solver.proven(demand));
          return `${demand.key}: ${items.map((item) => item.tag).join(",")} ${proof === null ? "none" : proof.signature(scope)}`;
        });
        got.add(answers.join("; "));
      });
  return got;
}

test("a component whose proofs change under unchanged items is solved to their fixed point, alike from each entry", () => {
  // p reads itself and q, q reads p: their items are the same each round, their proofs count to 3
  const got = solvedFrom(["p", "q"], (solver) => {
    const demands = new Map<string, ProofDemand<Chosen>>();
    demands.set(
      "p",
      proofDemand("p", 0, () =>
        counted(solver, () => demands.get("p")!, [() => demands.get("q")!], 3),
      ),
    );
    demands.set(
      "q",
      proofDemand("q", 1, () =>
        counted(solver, () => demands.get("q")!, [() => demands.get("p")!], 0),
      ),
    );
    return demands;
  });
  assert.deepEqual([...got], ["p: integer a||3; q: integer a||3"]);
});

test("an enlarged component and a held decision start their proofs again from none", () => {
  // p reads itself, and once its own proof stands at 1 a new demand r that reads p: r joins p's component, which starts
  // again from bottom; alike from either entry and in either order
  const enlarged = solvedFrom(["p", "r"], (solver) => {
    const demands = new Map<string, ProofDemand<Chosen>>();
    demands.set(
      "p",
      proofDemand("p", 0, function* () {
        const own = (yield* solver.proven(demands.get("p")!)).proof;
        const reads = own !== null && own.n >= 1 ? [() => demands.get("r")!] : [];
        return yield* counted(solver, () => demands.get("p")!, reads, 2);
      }),
    );
    demands.set(
      "r",
      proofDemand("r", 1, () =>
        counted(solver, () => demands.get("r")!, [() => demands.get("p")!], 0),
      ),
    );
    return demands;
  });
  assert.deepEqual([...enlarged], ["p: integer a||2; r: integer a||2"]);
  // s decides: open, `string` beside its input; held, its input alone. p's proof takes s's kinds beside its own: had
  // the held solve started from the open solve's proof, it would keep `string`
  const held = solvedFrom(["p"], (solver) => {
    const demands = new Map<string, ProofDemand<Chosen>>();
    const s: Demand = {
      key: "s",
      kind: "value",
      file: 0,
      offset: 1,
      *make() {
        yield* solver.proven(demands.get("p")!);
        return [makeItem("integer")];
      },
      decision: {
        choose: (input) => (input.length > 0 ? "some" : "none"),
        answer: (choice, input) => (choice === null ? [...input, makeItem("string")] : input),
      },
    };
    demands.set(
      "p",
      proofDemand("p", 0, () => counted(solver, () => demands.get("p")!, [() => s], 0)),
    );
    return demands;
  });
  assert.deepEqual([...held], ["p: integer a|integer|0"]);
});

/** A proof decision that changes the proof alone: open, `open`; held, `held`; the items as the run gave them. */
const PROOF_CHOICE: ProofDecision<Chosen> = {
  choose: () => "held",
  answer: (choice, input) => ({
    items: input.items,
    proof: input.proof === null ? null : chosen(choice === null ? "open" : "held", [], 0),
  }),
};

test("a proof demand's own decision is held on its proof alone, in a component and outside one", () => {
  // q decides and reads p; p reads itself and q, taking q's choice into its kinds: the open and the held answers have
  // one set of items, so only their proofs tell the solve to start again with q's choice held (review r1's F1), and p
  // keeps none of the open solve's proof
  const got = solvedFrom(["p", "q"], (solver) => {
    const demands = new Map<string, ProofDemand<Chosen>>();
    demands.set(
      "p",
      proofDemand("p", 0, function* () {
        const own = (yield* solver.proven(demands.get("p")!)).proof;
        const other = (yield* solver.proven(demands.get("q")!)).proof;
        const tags = new Set(own?.tags ?? []);
        if (other?.chosen !== undefined && other.chosen !== null) tags.add(other.chosen);
        return { items: [makeItem("integer")], proof: chosen("a", [...tags].sort(), 0) };
      }),
    );
    demands.set("q", {
      ...proofDemand("q", 1, function* () {
        yield* solver.proven(demands.get("p")!);
        return { items: [makeItem("integer")], proof: chosen("run", [], 0) };
      }),
      decision: PROOF_CHOICE,
    });
    return demands;
  });
  assert.deepEqual([...got], ["p: integer a|held|0; q: integer held||0"]);
  // outside a component the choice is made at once; after a stop an unfinished one reads its open answer, no proof
  const scope = itemScope();
  const alone: ProofDemand<Chosen> = {
    ...proofDemand("r", 0, function* () {
      return { items: [makeItem("integer")], proof: chosen("run", [], 0) };
    }),
    decision: PROOF_CHOICE,
  };
  const solver = new Solver(scope);
  assert.equal(solver.run(solver.proven(alone)).proof?.chosen, "held");
  scope.work.stop("work");
  const fresh = new Solver(scope);
  const stopped = fresh.run(fresh.proven(alone));
  assert.deepEqual([stopped.items, stopped.proof], [STOPPED, null]);
});

test("a stop at any unit keeps each proof only with its answer, finished, and runs nothing after it", () => {
  // f is finished first; p (a choice) and n (an absence) read each other; d reads both: at every stop each key reads
  // as it finished or as `STOPPED` with no proof, never a provisional proof, and a new solver (a new pass's) reads none
  const schedule = (solver: Solver, runs: Map<string, number>, returned: Map<string, Chosen>) => {
    const noted = (key: string, proof: () => Chosen): Chosen => {
      runs.set(key, (runs.get(key) ?? 0) + 1);
      const made = proof();
      returned.set(key, made);
      return made;
    };
    const demands = new Map<string, ProofDemand<Chosen>>();
    demands.set(
      "f",
      proofDemand("f", 0, function* () {
        return { items: [makeItem("integer")], proof: noted("f", () => chosen("f", [], 0)) };
      }),
    );
    demands.set(
      "p",
      proofDemand("p", 1, function* () {
        const other = (yield* solver.proven(demands.get("n")!)).proof;
        return {
          items: [makeItem("string")],
          proof: noted("p", () => chosen("p", [], Math.min((other?.n ?? 0) + 1, 3))),
        };
      }),
    );
    demands.set(
      "n",
      proofDemand("n", 2, function* () {
        const other = (yield* solver.proven(demands.get("p")!)).proof;
        return {
          items: [makeItem("string")],
          proof: noted("n", () => chosen(null, [], other?.n ?? 0)),
        };
      }),
    );
    demands.set(
      "d",
      proofDemand("d", 3, function* () {
        yield* solver.proven(demands.get("f")!);
        const p = (yield* solver.proven(demands.get("p")!)).proof;
        return {
          items: [makeItem("integer")],
          proof: noted("d", () => chosen("d", [], p?.n ?? 0)),
        };
      }),
    );
    return demands;
  };
  const read = (
    solver: Solver,
    demands: ReadonlyMap<string, ProofDemand<Chosen>>,
    scope: ReturnType<typeof itemScope>,
  ) =>
    [...demands.values()].map((demand) => {
      const { items, proof } = solver.run(solver.proven(demand));
      return `${demand.key}: ${itemsSignature(items, scope)} ${proof === null ? "none" : proof.signature(scope)}`;
    });
  const order = function* (
    solver: Solver,
    demands: ReadonlyMap<string, ProofDemand<Chosen>>,
  ): Work<void> {
    yield* solver.proven(demands.get("f")!);
    yield* solver.proven(demands.get("d")!);
  };
  // the unstopped run: every key's finished answer and proof, and the units it takes
  const full = itemScope();
  const unstopped = new Solver(full);
  const fullDemands = schedule(unstopped, new Map(), new Map());
  unstopped.run(order(unstopped, fullDemands));
  const units = full.work.total;
  const finished = read(unstopped, fullDemands, full);
  const stoppedLine = (key: string) => `${key}: ${itemsSignature(STOPPED, full)} none`;
  let provisional = 0;
  let atSlot = 0;
  for (let allowance = 0; allowance < units; allowance += 1) {
    const scope = itemScope(allowance);
    const solver = new Solver(scope);
    const runs = new Map<string, number>();
    const returned = new Map<string, Chosen>();
    const demands = schedule(solver, runs, returned);
    assert.throws(() => solver.run(order(solver, demands)), BudgetExhausted);
    scope.work.stop("work");
    const ran = JSON.stringify([...runs]);
    const got = read(solver, demands, scope);
    // (a stop with p and n each returned, neither kept; a stop at a proof's slot, the one charge of what the core keeps
    // here, its units beyond the slots of the proofs kept)
    const kept = got.filter((line) => !line.endsWith(" none")).length;
    if (returned.has("p") && returned.has("n") && got[1] === stoppedLine("p")) provisional += 1;
    if ((scope.work.counts().get("literalUnits") ?? 0) > kept) atSlot += 1;
    assert.equal(
      JSON.stringify([...runs]),
      ran,
      `allowance ${allowance}: nothing runs after the stop`,
    );
    got.forEach((line, at) =>
      assert.ok(
        line === finished[at] || line === stoppedLine([...demands.keys()][at]!),
        `allowance ${allowance}: ${line}`,
      ),
    );
    // (p and n, one component, are kept together or not at all)
    assert.equal(got[1] === finished[1], got[2] === finished[2], `allowance ${allowance}`);
    const fresh = new Solver(scope);
    assert.deepEqual(
      read(fresh, schedule(fresh, runs, returned), scope),
      [...demands.keys()].map(stoppedLine),
    );
    assert.equal(JSON.stringify([...runs]), ran);
  }
  assert.ok(provisional > 0, "some stop falls while p and n hold provisional proofs");
  assert.ok(atSlot > 0, "some stop falls at a proof's slot");
});
