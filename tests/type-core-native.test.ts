import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import type { CoreAnalysisRequest } from "../src/type-inference/core/program.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { SPREAD_CASES } from "./helpers/type-core-spreads.js";

/*
 * Native resilience (TABLE §8): the coarse core's answers on large flat programs stay on the heap and on the solver's
 * stack, never one call's arguments or one native frame per element, per store or per function.
 */

const program = (lines: readonly string[]): CoreAnalysisRequest => {
  const request = coreRequest([{ path: "main.tease", source: [...lines, "exit"].join("\n") }]);
  assert.ok(request !== null);
  return request;
};

/**
 * Round 10 B5: an element read of a result that a chain of 2,048 functions returns, each the next one's or a list, asks
 * whether several elements meet there through every function's result: on the solver's stack, never one native frame
 * per function.
 */
test("an element read through a chain of 2,048 returned results is answered within the native stack", () => {
  const functions = Array.from(
    { length: 2_048 },
    (_, index) =>
      `function get${index} {\n  if flagHost { return [1] }\n  return get${(index + 1) % 2_048}()\n}`,
  );
  const source = `let flagHost = askBoolean "flag"\n${functions.join("\n")}\nlet xs = [get0(), get0()]\nrepeat xs[0][0] {}\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const forward = analyseCore(request).outcome;
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => analyseCore(request).outcome,
    ),
  );
  assert.deepEqual([forward, reversed], ["valid", "valid"]);
});

/**
 * Sol's round 2 on #1049 (B3): a copy at the end of a chain of 4,096 copies, each place declared before its source is
 * copied into it, keeps the written type the chain starts from (r4.75 (1)): resolved one place at a time on the heap,
 * never one native frame per link.
 */
test("a copy at the end of a chain of 4,096 copies keeps the written type within the native stack", () => {
  const size = 4_096;
  const request = program([
    "let typed: null = null",
    ...Array.from({ length: size }, (_, index) => `let a${index} = null`),
    ...Array.from({ length: size - 1 }, (_, index) => `a${index} = a${index + 1}`),
    `a${size - 1} = typed`,
    "let out = a0",
    "out = hostValue",
  ]);
  const observe = () => {
    const answers = analyseCore(request);
    return {
      outcome: answers.outcome,
      against: answers.checks
        .filter((check) => check.boundary && check.target === "out")
        .map((check) => check.against),
    };
  };
  const forward = observe();
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), observe),
  );
  const expected = { outcome: "warning-runtime-check", against: [["null"]] };
  assert.deepEqual([forward, reversed], [expected, expected]);
});

/*
 * Source-sized lists append one by one, never spread as one call's arguments: S6's (review r3, external review r6 F1,
 * Astra r6 N1) and S6c's (Astra's static list on S6, TABLE r4.73 (2)). A call's arguments overflow near 125,000 at
 * Node's default stack and near 12,000 under a 100 KiB stack, so each case runs in a child of that stack
 * (`--stack-size=100`) at 30,000, where its spread restored fails: the same failure at a fraction of the work (the
 * owner's test-cost rule; at 130,000 on the default stack each case took 3 to 21 s). The fifth of S6c's, the copy
 * forest's mark spans (`ExactPath.#forest`'s `found`), has no source-sized case: a source with more than four anchors
 * takes the cross-source index before the append (`FEW_ANCHORS`), and the copies of at most four anchors, sorted by
 * dominator position, make at most 2 × 4 − 1 = 7 runs of one nearest anchor (dominator intervals are laminar: each
 * nested anchor splits its ancestor's run once), one span each; 130,000 tested copies of a root beside four tested side
 * sources append one span.
 */

/** A spread case's result: the analysis's outcome, its diagnostics, its checks and the case's own fact if it has one. */
type SpreadResult = readonly [string, ...number[]];

function spreadCase(name: string): SpreadResult {
  // (each program resolves, so a child's failure is its size's)
  const spread = SPREAD_CASES[name];
  assert.ok(
    spread !== undefined && coreRequest([{ path: "main.tease", source: spread.source(3) }]),
  );
  const url = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `
    import {analyseCore} from ${url("../src/type-inference/core/answers.js")};
    import {coreRequest} from ${url("./helpers/type-core-analysis.js")};
    import {SPREAD_CASES} from ${url("./helpers/type-core-spreads.js")};
    const spread = SPREAD_CASES[${JSON.stringify(name)}];
    const answers = analyseCore(coreRequest([{path: "main.tease", source: spread.source(30_000)}]));
    const extra = spread.extra === undefined ? [] : [spread.extra(answers)];
    console.log([answers.outcome, answers.diagnostics.length, answers.checks.length, ...extra].join(" "));
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=100", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(child.error, undefined, `${name}: ${child.error?.message}`);
  assert.equal(child.status, 0, `${name}: exit ${child.status}\n${child.stderr.slice(-2_000)}`);
  const [outcome = "", ...counts] = child.stdout.trim().split(" ");
  return [outcome, ...counts.map(Number)];
}

test("a literal of 30,000 elements beside a host value is admitted within the native stack", () => {
  // `Admission.literalChildren`: the literal's every element
  assert.deepEqual(spreadCase("literal"), ["warning-runtime-check", 1, 2]);
});

test("30,000 stores to one property are analysed within the native stack", () => {
  // `DefinitionLists`' definitions below a key
  assert.deepEqual(spreadCase("stores"), ["valid", 0, 0]);
});

test("30,000 copies of a root replaced once are analysed within the native stack", () => {
  // `ExactPath.#forest`'s copies of a source; each copy's host data owes its boundary
  assert.deepEqual(spreadCase("copies"), ["warning-runtime-check", 1, 3]);
});

test("a root stored whole 30,000 times answers at its property within the native stack", () => {
  // `DefinitionLists.ownEvents`: each store an event at the property
  assert.deepEqual(spreadCase("wholes"), ["valid", 0, 0, 30_001]);
});

test("tests of one field beside a test of another merge their operand regions within the native stack", () => {
  // `GuardIndex.#placeOperands`
  assert.deepEqual(spreadCase("guards"), ["warning-runtime-check", 1, 2]);
});

test("a component of mutually recursive results is abandoned within the native stack", () => {
  // `Solver.#abandon`
  assert.deepEqual(spreadCase("solver"), ["warning-runtime-check", 3, 3]);
});

test("a choice of written records is answered within the native stack", () => {
  // `Contract.indexItems` at a selection step
  assert.deepEqual(spreadCase("records"), ["valid", 0, 0]);
});

test("a choice record whose value holds computed elements is answered within the native stack", () => {
  // `Contract.#selectedAt`
  assert.deepEqual(spreadCase("property"), ["valid", 0, 0]);
});
