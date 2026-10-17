import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { RANDOM_FUNCTIONS, type RandomFunctionName } from "../src/language-facts.js";
import {
  numbersProblem,
  RANDOM_CONTRACTS,
  type NumberRandomFunction,
} from "../src/random-functions.js";
import { CheckpointError } from "../src/runtime/checkpoint.js";
import { checkedOutcome, type RandomOutcome } from "../src/runtime/random-control.js";
import { createFreshRuntimeSession, restoreRuntimeSession } from "../src/runtime/session.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** The runtime failure of `source`, which must compile. */
function failure(source: string): [string | undefined, string | undefined] {
  const failed = runValidSource(source).snapshot.failure;
  return [failed?.code, failed?.message];
}

/** The random functions of numbers, such as `chance`. */
type NumberFunctionName = {
  [Name in RandomFunctionName]: (typeof RANDOM_CONTRACTS)[Name] extends {
    readonly takes: "numbers";
  }
    ? Name
    : never;
}[RandomFunctionName];

const NUMBER_FUNCTIONS = RANDOM_FUNCTIONS.filter(
  (name): name is NumberFunctionName => RANDOM_CONTRACTS[name].takes === "numbers",
);

function contract(name: NumberFunctionName): NumberRandomFunction {
  return RANDOM_CONTRACTS[name];
}

/**
 * Calls of the random functions of numbers whose numbers fail one domain, the first in the contract's order: each
 * domain of every contract has one.
 */
const INVALID: readonly {
  readonly name: NumberFunctionName;
  readonly values: readonly number[];
}[] = [
  { name: "chance", values: [101] },
  { name: "chance", values: [-1] },
  { name: "randomNormal", values: [20, -1] },
  { name: "randomBeta", values: [0, 5] },
  { name: "randomBeta", values: [2, -1] },
  { name: "randomPert", values: [20, 10, 5] },
  { name: "randomPert", values: [10, 5, 20] },
  { name: "randomPert", values: [5, 20, 10] },
];

test("a domain of a random function's numbers fails alike when the compiler can see them, whatever the others are", () => {
  const covered = new Set<string>();
  for (const { name, values } of INVALID) {
    const random = contract(name);
    const failing = random.domains.findIndex(
      (domain) => domain.problem(domain.reads.map((position) => values[position]!)) !== undefined,
    );
    covered.add(`${name} ${failing}`);
    const { reads } = random.domains[failing]!;
    const message = numbersProblem(random, values)!;
    const call = `${name}(${values.join(", ")})`;
    // The runtime checks the numbers it is given, before it draws.
    const parameters = values.map((_, position) => `p${position}`).join(", ");
    assert.deepEqual(
      failure(
        `function draw(${parameters}) {\n    return ${name}(${parameters})\n}\nsay draw(${values.join(", ")})\nexit`,
      ),
      ["TSR039", message],
      call,
    );
    // The compiler gives the runtime's text when it sees all the numbers, and when it sees only those the domain reads.
    const at = reads.length === 1 ? String(values[reads[0]!]) : undefined;
    assert.deepEqual(diagnostics(`say ${call}\nexit`), [["TSV043", message, at ?? call]], call);
    const seen = `${name}(${values.map((value, position) => (reads.includes(position) ? value : "n")).join(", ")})`;
    assert.deepEqual(
      diagnostics(`function draw(n) {\n    return ${seen}\n}\nexit`),
      [["TSV043", message, at ?? seen]],
      seen,
    );
  }
  for (const name of NUMBER_FUNCTIONS)
    contract(name).domains.forEach((_, index) =>
      assert.ok(covered.has(`${name} ${index}`), `${name} domain ${index}`),
    );
  // Numbers the compiler cannot see, or that no domain refuses, compile.
  for (const source of [
    "function draw(n) {\n    return randomPert(n, 10, n)\n}\nexit",
    "function draw(n) {\n    return randomBeta(n, n)\n}\nexit",
    "say randomPert(4, 4, 4)\nsay randomNormal(20, 0)\nsay chance(0)\nsay chance(100)\nexit",
  ])
    assert.deepEqual(diagnostics(source), [], source);
});

test("randomWeighted's weights fail alike when the compiler can see them", () => {
  // The dict or list, its weight:, and where the compiler reports the weights.
  const invalid = [
    ['dict{ "a": -1, "b": 1 }', "", "-1"],
    ["(dict{ a: 1, b: 1 - 3 })", "", "1 - 3"],
    ['dict{ "a": 0, "b": 0 }', "", 'dict{ "a": 0, "b": 0 }'],
    ['[{ name: "a", w: 2 }, { name: "b", w: -0.5 }]', ', weight: "w"', "-0.5"],
    ['[{ name: "a", w: 0 }]', ', weight: "w"', '[{ name: "a", w: 0 }]'],
  ] as const;
  for (const [choices, weight, at] of invalid) {
    const [code, message] = failure(
      `function hide(value) {\n    return value\n}\nlet chosen = randomWeighted(hide(${choices})${weight})\nexit`,
    );
    assert.equal(code, "TSR039", choices);
    assert.deepEqual(
      diagnostics(`let chosen = randomWeighted(${choices}${weight})\nexit`),
      [["TSV043", message, at]],
      choices,
    );
  }
  // A later key known only when the script runs may replace an entry, so only the last entry's weight counts then.
  for (const [entries, chosen] of [
    ['[k]: -1, "a": 2', "a"],
    ['"a": -1, [k]: 2', "a"],
  ] as const)
    assert.deepEqual(
      sayTexts(runValidSource(`let k = "a"\nsay randomWeighted(dict{ ${entries} })\nexit`)),
      [chosen],
      entries,
    );
  assert.deepEqual(diagnostics('let k = "b"\nsay randomWeighted(dict{ "a": 1, [k]: -2 })\nexit'), [
    ["TSV043", "randomWeighted(...) needs weights of at least 0, not -2.", "-2"],
  ]);
});

test("a random draw's support is its contract's, which the debug picker checks outcomes against", () => {
  const number = (value: number): RandomOutcome => ({ kind: "number", value });
  const boolean = (value: boolean): RandomOutcome => ({ kind: "boolean", value });
  // A call, and outcomes its draw takes and refuses (`docs/RUNTIME.md#controlled-randomness`).
  for (const [name, values, accepted, refused] of [
    ["random", [], [number(0), number(0.999)], [number(1), number(-0.1)]],
    ["chance", [30], [boolean(true), boolean(false)], [number(1)]],
    ["chance", [0], [boolean(false)], [boolean(true)]],
    ["randomNormal", [20, 5], [number(-1e9), number(20)], [number(Infinity)]],
    ["randomNormal", [20, 0], [number(20)], [number(21)]],
    ["randomBeta", [2, 5], [number(0), number(1)], [number(1.5)]],
    ["randomPert", [5, 10, 20], [number(5), number(20)], [number(4.9), number(21)]],
  ] as const) {
    const random = contract(name);
    const session = createFreshRuntimeSession(
      compileValidPlan(`let value = ${name}(${values.join(", ")})\nexit`),
      { seed: 5 },
      { randomControl: {} },
    );
    session.run();
    const draw = session.view().randomDraw!;
    assert.equal(draw.kind, name);
    assert.deepEqual(draw.support, random.support(values));
    for (const outcome of [draw.natural, ...accepted])
      assert.equal(typeof checkedOutcome(draw.support, outcome), "object", name);
    for (const outcome of refused)
      assert.equal(typeof checkedOutcome(draw.support, outcome), "string", name);
    // A restored pending draw whose numbers the contract refuses is malformed.
    for (const { values: invalid } of INVALID.filter((one) => one.name === name)) {
      const checkpoint = JSON.parse(JSON.stringify(session.exportCheckpoint()));
      checkpoint.snapshot.randomControl.pending.draw.support = random.support(invalid);
      assert.throws(
        () => restoreRuntimeSession(checkpoint),
        (error: unknown) =>
          error instanceof CheckpointError &&
          error.message.includes("Pending random draw support is malformed."),
        `${name}(${invalid.join(", ")})`,
      );
    }
  }
  const session = createFreshRuntimeSession(
    compileValidPlan('let key = randomWeighted(dict{ "a": 1, "b": 0, "c": 2 })\nexit'),
    { seed: 5 },
    { randomControl: {} },
  );
  session.run();
  const draw = session.view().randomDraw!;
  assert.deepEqual(draw.support, {
    kind: "weighted",
    candidates: ["a", "b", "c"],
    weights: [1, 0, 2],
  });
  assert.equal(typeof checkedOutcome(draw.support, { kind: "index", index: 1 }), "string");
  for (const weights of [
    [1, -1, 2],
    [0, 0, 0],
  ]) {
    const checkpoint = JSON.parse(JSON.stringify(session.exportCheckpoint()));
    checkpoint.snapshot.randomControl.pending.draw.support.weights = weights;
    assert.throws(
      () => restoreRuntimeSession(checkpoint),
      (error: unknown) =>
        error instanceof CheckpointError &&
        error.message.includes("Pending random draw support is malformed."),
      weights.join(", "),
    );
  }
});
