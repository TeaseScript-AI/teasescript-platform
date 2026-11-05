import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import {
  createSerializableList as list,
  createSerializableObject,
} from "../src/runtime/values/serializable-values.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance, withTestDemandAllowance } from "../src/type-inference/core/budget.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { HELD_MODES } from "./helpers/type-core-held-host.js";
import { runGlobals } from "./helpers/type-core-route.js";
import {
  DECLINES,
  MATRIX_MODES,
  matrixCells,
  matrixRuns,
  type MatrixRun,
  type StopKind,
} from "./helpers/type-core-lost-check-matrix.js";

// #1526 decision 2, condition 1 (TABLE r4.390): after any stop the candidate publishes no plan that lets through what
// the natural plan rejects. The generated matrix (`type-core-lost-check-matrix.ts`), and the rows of Codex r4's review.

test("over the matrix of destinations, value forms and stops, a stopped plan never lets through what the natural plan rejects (#1526 decision 2)", () => {
  const runs: MatrixRun[] = [];
  for (const cell of matrixCells())
    for (const mode of MATRIX_MODES) runs.push(...(matrixRuns(cell, mode) ?? []));
  for (const run of runs) {
    const where = `${run.cell} (${run.mode}) ${run.at}: ${run.stop}`;
    const { outcome } = run;
    // (a decline publishes nothing: the gate's, rule (R)'s, or a refusal of the slice the unstopped route makes too, as
    // a stopped default's collection; an unsettled stop has no registry, option (a), #1767 and #1252, counted in the
    // evidence, never gated here)
    if (outcome.kind === "published" && run.stop !== "unsettled program stop")
      assert.equal(outcome.escapes, false, where);
  }
  // (every kind of stop is reached, and declined and published runs are both there)
  const kinds = new Set(runs.map((run) => run.stop));
  for (const kind of [
    "decision stop, completed",
    "decision stop, completion capped",
    "settled program stop",
    "unsettled program stop",
  ] satisfies StopKind[])
    assert.ok(kinds.has(kind), kind);
  assert.ok(
    runs.some((run) => run.outcome.kind === "declined" && run.outcome.what === DECLINES[1]),
  );
  assert.ok(runs.some((run) => run.outcome.kind === "published" && run.outcome.kept === "reader"));
  assert.ok(
    runs.some((run) => run.outcome.kind === "published" && run.outcome.kept === "store check"),
  );
});

test("Codex r4's rows: a cap while the completion finds its obligations is gated, and a reader into a place typed elsewhere keeps nothing", () => {
  const mode = HELD_MODES[0]!;
  const at = <T>(demand: number, allowance: number, make: () => T): T =>
    mode.run(() => withTestDemandAllowance(demand, () => withTestAllowance(allowance, make)));
  const compiled = (source: string) => () =>
    compileSourceWithBackend(source, { globals: ["hostValue", "hostOther"] }, CORE_BACKEND);
  // (B1, a cap while the completion finds its obligations, at program allowances 1,220 to 1,240; B2, a load's reader `{}`
  // into `b`, a copy of `{n: [[1]]}`, which keeps nothing: at every settled or decision stop of demand 16, every fifth
  // allowance from 900 to 2,400, a published plan lets no `[["x"]]` through, and some stop is declined)
  const nested = list([list(["x"])]);
  for (const [source, globals, storage] of [
    [
      'let a={f:[[1]]}\nlet b=a\nb.f=hostValue\nsay "AFTER"\nexit\n',
      { hostValue: nested },
      undefined,
    ],
    [
      'let a={n:[[1]]}\nlet b=a\nb=load("k",default:{})\nsay toJson(b)\nsay "AFTER"\nexit\n',
      {},
      [{ key: "k", value: createSerializableObject([{ name: "n", value: nested }]) }],
    ],
  ] as const) {
    let declined = 0;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
    for (let allowance = 900; allowance <= 2400; allowance += 5) {
      const { budget } = at(16, allowance, () => analyseCore(request));
      if (budget.exhausted !== null && !budget.settled) continue;
      let plan;
      try {
        plan = at(16, allowance, compiled(source)).plan;
      } catch (error) {
        if (!(error instanceof CandidateOutsideSlice)) throw error;
        declined += 1;
        continue;
      }
      assert.ok(plan !== null, `${source} @${allowance}`);
      const run = runGlobals(plan, globals, storage);
      const passed =
        run.said.some((said) => said.text === "AFTER") &&
        (storage === undefined || run.said.some((said) => said.text.includes('"x"')));
      assert.equal(passed, false, `${source} @${allowance}`);
    }
    assert.ok(declined > 0, source);
  }
  // (#1460: a load into a `let` of its own, whose reader is the natural check, publishes at its settled publication stop,
  // program allowance 681 in source order with sharing, where the store's own contract is lost)
  const own = 'let seed = load("seed", default: [{n: 1}, {m: 2}])\nsay "X"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source: own }], ["hostValue", "hostOther"])!;
  const stopped = mode.run(() => withTestAllowance(681, () => analyseCore(request))).budget;
  assert.deepEqual(
    [stopped.exhausted, stopped.stoppedIn, stopped.settled],
    ["work", "publication", true],
  );
  assert.ok(mode.run(() => withTestAllowance(681, compiled(own))).plan !== null);
});
