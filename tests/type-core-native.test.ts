import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import type { CoreAnalysisRequest } from "../src/type-inference/core/program.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";

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

/** A place's operand regions merged per file (`GuardIndex.#placeOperands`): one test of a field, 130,000 of another. */
test("130,000 tests of one field beside a test of another are analysed within the native stack", () => {
  for (const operands of [10_000, 130_000]) {
    const request = program([
      "let root = {a: 1, b: 1, n: [1, hostValue][1]}",
      `let ok = root.a is integer and ${rows(operands, "root.b is integer").join(" and ")} and true`,
      "let box = root",
      "repeat box.n {}",
    ]);
    const answers = analyseCore(request);
    assert.deepEqual(
      [answers.outcome, answers.diagnostics.length, answers.checks.length],
      ["warning-runtime-check", 1, 2],
      `${operands} operands`,
    );
  }
});

/**
 * A strongly connected component of the solver abandoned when a rerun finds an earlier dependency (`Solver.#abandon`):
 * 130,000 functions each returning the next one's result, the last the first's, beside one returning their length.
 */
test("a component of 130,000 mutually recursive results is abandoned within the native stack", () => {
  for (const size of [10_000, 130_000]) {
    const request = program([
      'let flagHost = askBoolean "flag"',
      "let out = outer().length",
      'function outer: string | integer { if flagHost { return "ok" }\nreturn get0().length }',
      ...Array.from(
        { length: size },
        (_, i) =>
          `function get${i}${i === 0 ? ": object | string | integer" : ""} {\n${
            i === 0 ? "  if flagHost { return {length: outer()} }\n" : ""
          }  return ${i + 1 < size ? `get${i + 1}()` : "get0().length"}\n}`,
      ),
    ]);
    const answers = analyseCore(request);
    assert.deepEqual(
      [answers.outcome, answers.diagnostics.length, answers.checks.length],
      ["warning-runtime-check", 3, 3],
      `${size} functions`,
    );
  }
});