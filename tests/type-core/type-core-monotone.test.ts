// #2486's solver oracle (`withMonotoneOracle`): it names a run that loses a kind, a reason or an unknown's word, and
// stays quiet on runs that only add.
import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../src/type-inference/core/answers.js";
import { makeItem, REASON, type Item } from "../../src/type-inference/core/items.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { judgeRun, withMonotoneOracle } from "../helpers/type-core/type-core-monotone.js";

const unknown = (reasons: number, context: Item["context"] = null): Item =>
  makeItem("unknown", null, { reasons, context, cert: "pos" });
const integer = makeItem("integer");

test("the oracle names a lost kind, a lost reason and an unknown's word moved later", () => {
  const moves = new Map<string, number>();
  const kinds = (violations: ReturnType<typeof judgeRun>): string[] =>
    violations.map((violation) => `${violation.kind} ${violation.tag}`);
  assert.deepEqual(kinds(judgeRun("m", [integer, unknown(4)], [integer], moves)), [
    "kind lost unknown",
  ]);
  assert.deepEqual(
    kinds(judgeRun("m", [unknown(REASON.deferred | REASON.external)], [unknown(4)], moves)),
    ["reason lost unknown"],
  );
  assert.deepEqual(
    kinds(judgeRun("m", [unknown(5, "deferred-parameter")], [unknown(5, "unknown")], moves)),
    ["unknown's word later unknown"],
  );
  // (an `integer` replaced by `number` widens and is kept; one lost with no `number` beside it is not)
  assert.deepEqual(judgeRun("m", [integer], [makeItem("number"), makeItem("string")], moves), []);
  assert.deepEqual(kinds(judgeRun("m", [integer], [makeItem("string")], moves)), [
    "kind lost integer",
  ]);
  // (what only grows: a kind, a reason, a word earlier in the order or following a new reason)
  assert.deepEqual(
    judgeRun(
      "m",
      [unknown(1, "unknown")],
      [integer, unknown(5, "deferred-parameter"), makeItem("empty")],
      moves,
    ),
    [],
  );
  assert.deepEqual(
    judgeRun("m", [unknown(4, "deferred-parameter")], [unknown(5, "unknown")], moves),
    [],
  );
  assert.deepEqual(Object.fromEntries(moves), {
    "integer widened to number": 1,
    "unknown word with its reasons": 2,
  });
});

test("the oracle counts the moves of the fields it does not judge", () => {
  const moves = new Map<string, number>();
  judgeRun(
    "m",
    [makeItem("integer", null, { context: "call" })],
    [makeItem("integer", null, { cert: "pos", context: "loop", guarded: true })],
    moves,
  );
  assert.deepEqual(Object.fromEntries(moves), {
    "known word later": 1,
    "cert def→pos": 1,
    "guarded gained": 1,
  });
});

test("the oracle hears a component's runs, in both worklist orders", () => {
  // (a helper with two call sites, whose result a variable updates through one operation: a component of the variable's
  // contract and the operation, which settles)
  const source = [
    "global function passOn(value) {",
    "  return value",
    "}",
    "let a = passOn(1)",
    'let n = passOn(fromJson(askText("v?"), default: 0))',
    "n = n + 1",
    'say "${n}"',
    "exit",
    "",
  ].join("\n");
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request);
  for (const reversed of [false, true]) {
    const { record } = withMonotoneOracle((): void => void analyseCore(request), reversed);
    assert.ok(record.compared > 0, `runs compared (${reversed ? "reversed" : "canonical"})`);
    assert.equal(record.violations, 0, JSON.stringify(record.first));
  }
});

/** A variable set from a pass-through helper with two call sites and updated from itself (#2486's reproduction). */
const passThrough = (argument: string, update: string): string =>
  [
    "global function passOn(value) {",
    "  return value",
    "}",
    "let a = passOn(1)",
    `let n = passOn(${argument})`,
    update,
    'say "${n}"',
    "exit",
    "",
  ].join("\n");

/**
 * The converter's integer loader called with a variable as its default, in two functions that each add a parameter with
 * several call sites to their variable (#2486's reduction of a package's ring, where only an unknown's word moved).
 */
const loaderRing = (): string => {
  const update = (name: string, key: string): string =>
    [
      `function ${name}(count) {`,
      "  let p = 0",
      `  let saved: integer? = load "${key}", default: null`,
      "  if saved == null {",
      "    p = 0",
      "  } else {",
      `    p = loadWhole("${key}", p)`,
      "  }",
      "  if floor(count) >= 1 {",
      "    p += floor(count)",
      "  }",
      `  save p as "${key}"`,
      "}",
      `${name}(1)`,
      `${name}(randomInteger(1..3))`,
    ].join("\n");
  return [
    "global function passOn(value) {",
    "  return value",
    "}",
    "global function loadWhole(key, whenMissing = null) {",
    "  let value = load key, default: null",
    "  if value == null {",
    "    return whenMissing",
    "  }",
    "  return passOn(toInteger(value))",
    "}",
    update("punish", "k.punish"),
    update("reward", "k.reward"),
    "exit",
    "",
  ].join("\n");
};

const SETTLING: readonly (readonly [string, string])[] = [
  [
    "outside data",
    passThrough('fromJson(askText("v?"), default: 0)', "n = n + 1 + randomInteger(0..3)"),
  ],
  ["a constant", passThrough("0", "n = n + 1 + randomInteger(0..3)")],
  ["a typed load", passThrough('load "k", default: 0', "n = n + 1 + randomInteger(0..3)")],
  ["a compound update", passThrough("0", "n += randomInteger(0..4) + 1")],
  [
    "the update in a loop",
    passThrough("0", 'while askBoolean("again?") {\n  n = n + 1 + randomInteger(0..3)\n}'),
  ],
  ["the loader's ring", loaderRing()],
];

test("a component of a pass-through helper's variable settles, its runs only growing (#2486)", () => {
  for (const [name, source] of SETTLING) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request, name);
    for (const reversed of [false, true]) {
      let exhausted: ReturnType<typeof analyseCore>["budget"]["exhausted"] | "not run" = "not run";
      const { record } = withMonotoneOracle((): void => {
        exhausted = analyseCore(request).budget.exhausted;
      }, reversed);
      assert.equal(exhausted, null, `${name}: the analysis finishes inside its allowance`);
      assert.equal(record.violations, 0, `${name}: ${JSON.stringify(record.first)}`);
    }
  }
});
