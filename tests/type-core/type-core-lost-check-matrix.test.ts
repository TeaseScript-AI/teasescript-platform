import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../src/compiler.js";
import {
  createSerializableList as list,
  createSerializableObject,
} from "../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import {
  HELD_MODES,
  heldStops,
  stopDeclineProblem,
  unsettledStop,
} from "../helpers/type-core-held-host.js";
import { runGlobals } from "../helpers/type-core-route.js";
import {
  DECLINES,
  MATRIX_MODES,
  matrixCells,
  matrixRuns,
  type MatrixRun,
  type StopKind,
} from "../helpers/type-core/type-core-lost-check-matrix.js";

// #1526 decision 2, condition 1: after any stop the candidate publishes no plan that lets through what
// the natural plan rejects. The generated matrix (`type-core-lost-check-matrix.ts`), and the rows of Codex r4's review.

test("over the matrix of destinations, value forms and stops, a stopped plan never lets through what the natural plan rejects (#1526 decision 2)", () => {
  const runs: MatrixRun[] = [];
  for (const cell of matrixCells())
    for (const mode of MATRIX_MODES) runs.push(...(matrixRuns(cell, mode) ?? []));
  for (const run of runs) {
    const where = `${run.cell} (${run.mode}) ${run.at}: ${run.stop}`;
    const { outcome } = run;
    // (a decline publishes nothing, and stands only with a limit's reason at its stop's phase, #2080 part 2: the gate's
    // or rule (R)'s, the natural compile here publishing; a published plan, at every stop, lets nothing through)
    if (outcome.kind === "declined")
      assert.equal(
        stopDeclineProblem(outcome.what, run.stop === "unsettled program stop", null),
        null,
        where,
      );
    else assert.equal(outcome.escapes, false, where);
  }
  // (a typed call that is the whole value of an element of a stored literal keeps the obligation for that element: at
  // every completed decision stop a literal of a parse publishes, and the escape check above holds it to the natural
  // plan's `["x"]`, which both replace by the default; capped into a place typed elsewhere it has no result, #1832)
  const literal = runs.filter(
    (run) =>
      /^(fresh|copy|property) \/ literal of parse/u.test(run.cell) &&
      run.stop === "decision stop, completed",
  );
  assert.ok(literal.length > 0);
  for (const run of literal)
    assert.equal(run.outcome.kind, "published", `${run.cell} (${run.mode}) ${run.at}`);
  // (every kind of stop is reached, and declined and published runs are both there)
  const kinds = new Set(runs.map((run) => run.stop));
  for (const kind of [
    "decision stop, completed",
    "decision stop, completion capped",
    "settled program stop, extraction",
    "settled program stop, walk",
    "settled program stop, publication",
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
        // (only a limit's reason at the phase it belongs to, #2080 part 2)
        assert.equal(
          stopDeclineProblem(error.what, unsettledStop(budget), null),
          null,
          `${source} @${allowance}`,
        );
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
  // (Codex r5's B1: a load into a `let` of its own, whose type a later store decides, after a completion past its
  // allowance, has no result: declined, #1832, where the plan would print `{n: [["x"]]}`)
  const own =
    'let pad={f0:0}\npad={f1:1}\npad={f2:2}\npad={f3:3}\npad={f4:4}\nlet b=load("k",default:{})\nsay toJson(b)\nb={n:[[1]]}\nsay toJson(b)\nsay "AFTER"\nexit\n';
  assert.throws(
    () => mode.run(() => withTestDemandAllowance(16, compiled(own))),
    (error) =>
      error instanceof CandidateOutsideSlice &&
      error.what === "a store whose check was lost at the budget",
  );
});

test("Codex r5's rows: a stored literal carries its contract by its typed calls' readers and its own scalar leaves", () => {
  // (results exist: the readers and the literal's structure carry the whole contract, so the plan publishes and reads as
  // the natural one, `["x"]` replaced by the default)
  for (const mode of HELD_MODES)
    for (const [source, globals] of [
      [
        'let b=[fromJson(hostValue,default:[1],files:false),[1]]\nsay toJson(b)\nsay "AFTER"\nexit\n',
        { hostValue: '["x"]' },
      ],
      [
        'let b={n:fromJson(hostValue,default:[[1]],files:false),m:fromJson(hostOther,default:[[1]],files:false)}\nsay toJson(b)\nsay "AFTER"\nexit\n',
        { hostValue: '[["x"]]', hostOther: '[["x"]]' },
      ],
    ] as const) {
      const compiled = (demand?: number) =>
        mode.run(() => {
          const once = () =>
            compileSourceWithBackend(source, { globals: ["hostValue", "hostOther"] }, CORE_BACKEND);
          return demand === undefined ? once() : withTestDemandAllowance(demand, once);
        });
      const natural = compiled().plan!;
      const stopped = compiled(16).plan;
      assert.ok(stopped !== null, `${source} (${mode.name})`);
      assert.deepEqual(
        runGlobals(stopped, globals).said,
        runGlobals(natural, globals).said,
        mode.name,
      );
    }
});

test("Codex r6's rows: a static part the gate cannot prove publishes as the natural plan or declines (#1845)", () => {
  // (a complete receiving result, both typed readers carrying their contracts, and a regex leaf or a collection whose
  // contract is a union beside them: the literal's structure the gate does not follow, so it may decline, an accepted
  // over-decline, #1845, the legacy compiles; a published plan runs as the natural one)
  const parsed =
    "n:fromJson(hostValue,default:[[1]],files:false),m:fromJson(hostOther,default:[[1]],files:false)";
  const globals = { hostValue: '[["x"]]', hostOther: '[["x"]]' };
  for (const middle of [`let b={${parsed},extra:/r/}`, `let b={${parsed},extra:[1]}\nb.extra=null`])
    for (const mode of HELD_MODES) {
      const source = `${middle}\nsay toJson(b.n)\nsay "AFTER"\nexit\n`;
      const compiled = (demand?: number) =>
        mode.run(() => {
          const once = () =>
            compileSourceWithBackend(source, { globals: ["hostValue", "hostOther"] }, CORE_BACKEND);
          return demand === undefined ? once() : withTestDemandAllowance(demand, once);
        });
      let plan;
      try {
        plan = compiled(16).plan;
      } catch (error) {
        assert.ok(
          error instanceof CandidateOutsideSlice &&
            error.what === "a store whose check was lost at the budget",
          `${middle} (${mode.name})`,
        );
        continue;
      }
      assert.ok(plan !== null, `${middle} (${mode.name})`);
      assert.deepEqual(
        runGlobals(plan, globals).said,
        runGlobals(compiled().plan!, globals).said,
        `${middle} (${mode.name})`,
      );
    }
});

test("Astra r1's B1: a settled stop in the capture's extraction is gated, in four modes (#1526 decision 2)", () => {
  // (the receiving seed is saved before the capture, so a stop inside it still has its obligations: at every settled
  // extraction stop the plan the stop leaves, `{n: list<any>}` where the natural plan checks both properties, declines,
  // and no published plan lets `[["BAD"]]` through)
  const source =
    'let a={n:[[1]],m:[[1]]}\nlet b=a\nb={n:hostValue}\nsay toJson(b)\nsay "AFTER"\nexit\n';
  const bad = { hostValue: list([list(["BAD"])]) };
  for (const mode of HELD_MODES) {
    const stops = heldStops({ name: "B1", source, slice: true, values: [] }, mode);
    const extraction = stops.filter((stop) => stop.phase === "extraction");
    assert.ok(extraction.length > 0, mode.name);
    let declined = 0;
    for (const { allowance, phase } of stops) {
      let plan;
      try {
        plan = mode.run(() =>
          withTestAllowance(allowance, () =>
            compileSourceWithBackend(source, { globals: ["hostValue", "hostOther"] }, CORE_BACKEND),
          ),
        ).plan;
      } catch (error) {
        // (a settled stop: only a limit's reason after admission settled, #2080 part 2)
        assert.ok(error instanceof CandidateOutsideSlice, `${mode.name} ${phase} @${allowance}`);
        assert.equal(
          stopDeclineProblem(error.what, false, null),
          null,
          `${mode.name} ${phase} @${allowance}`,
        );
        if (phase === "extraction") declined += 1;
        continue;
      }
      assert.ok(plan !== null);
      const run = runGlobals(plan, bad);
      assert.equal(
        run.said.some((said) => said.text === "AFTER"),
        false,
        `${mode.name} ${phase} @${allowance}`,
      );
    }
    assert.ok(declined > 0, mode.name);
  }
});
