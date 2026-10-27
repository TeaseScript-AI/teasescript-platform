import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import type { CoreAnalysisRequest } from "../src/type-inference/core/program.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { SPREAD_PROGRAMS } from "./helpers/type-core-spreads.js";

/*
 * Native resilience (TABLE §8): the coarse core's answers on large flat programs stay on the heap and on the solver's
 * stack, never one call's arguments or one native frame per element, per store or per function. Each program is as
 * large as the defect it guards needed (a call's arguments overflow near 125,000 at Node's default stack), beside an
 * ordinary-size control where it has one.
 */

const program = (lines: readonly string[]): CoreAnalysisRequest => {
  const request = coreRequest([{ path: "main.tease", source: [...lines, "exit"].join("\n") }]);
  assert.ok(request !== null);
  return request;
};

const rows = (count: number, line: string): string[] => Array.from({ length: count }, () => line);

/**
 * Admission's walks over a literal of 150,000 elements beside a host value list them on the heap (review r3: a spread
 * of the elements overflowed the native stack).
 */
test("a literal of 150,000 elements beside a host value is admitted within the native stack", () => {
  const source = `let xs: integer[] = [${Array.from({ length: 150_000 }, () => "1").join(",")}, hostValue]\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  assert.equal(analyseCore(request).outcome, "warning-runtime-check");
});

/**
 * External review r6 F1: a key's definitions below another, of 130,000 stores to one property, are listed on the heap;
 * 10,000 stores are the ordinary-size control.
 */
test("130,000 stores to one property are analysed within the native stack", () => {
  for (const stores of [10_000, 130_000]) {
    const request = program([
      "let root = {n: 0}",
      ...rows(stores, "root.n = 1"),
      "let box = root",
      "repeat box.n {}",
    ]);
    assert.equal(analyseCore(request).outcome, "valid", `${stores} stores`);
  }
});

/**
 * Astra r6 N1 (inherited from `main`): the exact-path forest gathers a source's copies on the heap, so 130,000 copies
 * of a root replaced once are analysed, each copy's host data owing its boundary; 10,000 copies are the control.
 */
test("130,000 copies of a root replaced once are analysed within the native stack", () => {
  for (const copies of [10_000, 130_000]) {
    const request = program([
      "let root = {n: [1, hostValue][1]}",
      "let box = root",
      "root = {n: [1, hostValue][1]}",
      ...rows(copies, "box = root"),
      "repeat box.n {}",
    ]);
    const answers = analyseCore(request);
    assert.deepEqual(
      [answers.outcome, answers.diagnostics.length, answers.checks.length],
      ["warning-runtime-check", 1, 3],
      `${copies} copies`,
    );
  }
});

/**
 * Astra r6 N1 (inherited from `main`): a key's own events gather its prefixes' event positions on the heap, so the
 * place of a root stored whole 130,000 times answers at its property with each store an event; 10,000 stores are the
 * control. Every store copies one shared record, a fresh record each being no part of the prefix events (Astra r8 D1:
 * half the syntax nodes and the heap).
 */
test("a root stored whole 130,000 times answers at its property within the native stack", () => {
  for (const stores of [10_000, 130_000]) {
    const request = program([
      "let root = {n: 0}",
      "let shared = {n: 1}",
      ...rows(stores, "root = shared"),
      "let box = root",
      "repeat box.n {}",
    ]);
    const answers = analyseCore(request);
    assert.equal(answers.outcome, "valid", `${stores} stores`);
    // (the root's place through the analysis's own graph: a second program index of the 130,000 stores beside the
    // answers doubled the heap past V8's 2 GB default, the test-cost audit's out-of-memory)
    const declaration = answers.graph.nodes.find(
      (node) => node.kind === "statement" && node.span?.start.offset === 0,
    );
    const root = declaration === undefined ? null : answers.at(declaration)?.place;
    assert.ok(root, `${stores} stores: the root's place`);
    assert.equal(
      answers.place(root.id, ["n"]).definitions.events.stores.length,
      stores + 1,
      `${stores} stores`,
    );
  }
});

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
 * The five inherited argument spreads (S6c; Astra's static list on S6, TABLE r4.73 (2)) append one by one now. Four have
 * a source that makes the list source-sized; each is a regression below, beside a small control, and the spread
 * restored fails its own. A call's arguments overflow near 125,000 at Node's default stack, and near 12,000 under a
 * 100 KiB stack, so each runs in a child of that stack (`--stack-size=100`) at 30,000: the same failure of a
 * source-sized spread at a fraction of the work (the owner's test-cost rule; at 130,000 on the default stack each case
 * took 8 to 21 s). The fifth, the copy forest's mark spans (`ExactPath.#forest`'s `found`), has none: a source with more
 * than four anchors takes the cross-source index before the append (`FEW_ANCHORS`), and the copies of at most four
 * anchors, sorted by dominator position, make at most 2 × 4 − 1 = 7 runs of one nearest anchor (dominator intervals are
 * laminar: each nested anchor splits its ancestor's run once), one span each; 130,000 tested copies of a root beside
 * four tested side sources append one span.
 */

/** A spread regression's program analysed at each size in a child with a 100 KiB stack: its outcome, diagnostics, checks. */
function spreadCase(name: string, sizes: readonly number[]): unknown[] {
  // (each program resolves, so a child's failure is its size's)
  const program = SPREAD_PROGRAMS[name];
  assert.ok(program !== undefined && coreRequest([{ path: "main.tease", source: program(3) }]));
  const url = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `
    import {analyseCore} from ${url("../src/type-inference/core/answers.js")};
    import {coreRequest} from ${url("./helpers/type-core-analysis.js")};
    import {SPREAD_PROGRAMS} from ${url("./helpers/type-core-spreads.js")};
    for (const size of ${JSON.stringify(sizes)}) {
      const answers = analyseCore(coreRequest([{path: "main.tease", source: SPREAD_PROGRAMS[${JSON.stringify(name)}](size)}]));
      console.log(JSON.stringify([answers.outcome, answers.diagnostics.length, answers.checks.length]));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=100", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(child.error, undefined, `${name}: ${child.error?.message}`);
  assert.equal(child.status, 0, `${name}: exit ${child.status}\n${child.stderr.slice(-2_000)}`);
  return child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

const SPREAD_SIZES = [5_000, 30_000];

test("tests of one field beside a test of another merge their operand regions within the native stack", () => {
  // `GuardIndex.#placeOperands`
  const expected = ["warning-runtime-check", 1, 2];
  assert.deepEqual(spreadCase("guards", SPREAD_SIZES), [expected, expected]);
});

test("a component of mutually recursive results is abandoned within the native stack", () => {
  // `Solver.#abandon`
  const expected = ["warning-runtime-check", 3, 3];
  assert.deepEqual(spreadCase("solver", SPREAD_SIZES), [expected, expected]);
});

test("a choice of written records is answered within the native stack", () => {
  // `Contract.indexItems` at a selection step
  const expected = ["valid", 0, 0];
  assert.deepEqual(spreadCase("records", SPREAD_SIZES), [expected, expected]);
});

test("a choice record whose value holds computed elements is answered within the native stack", () => {
  // `Contract.#selectedAt`
  const expected = ["valid", 0, 0];
  assert.deepEqual(spreadCase("property", SPREAD_SIZES), [expected, expected]);
});
