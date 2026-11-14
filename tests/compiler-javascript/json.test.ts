import assert from "node:assert/strict";
import test from "node:test";

import { writeJson } from "../../src/compiler/javascript/json.js";

// The generator writes plan data with `writeJson`, which must give native JSON's bytes without its recursion.

test("JSON data is written as JSON.stringify writes it", () => {
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
  const values: unknown[] = [
    null,
    true,
    false,
    0,
    -0,
    1.5,
    -2e-7,
    1e21,
    "",
    'quote " backslash \\ newline \n tab \t nul \u0000 line   lone \ud800 pair 😀',
    [],
    {},
    [1, [2, [3, []]], { a: [] }],
    { b: 1, a: { c: [null, "x"] }, "": 0, é: true, 10: "ten", 2: "two" },
    { kept: 1, dropped: undefined },
    nullPrototype,
  ];
  for (const value of values) assert.equal(writeJson(value), JSON.stringify(value));
});

// Native JSON's depth depends on the data's shape: plain objects pass far deeper than the plan data in generate.test.ts,
// so here it is the oracle.
test("a value nested 100,000 deep is written", () => {
  let deep: unknown = "leaf";
  for (let level = 0; level < 100_000; level += 1)
    deep = level % 2 === 0 ? [deep] : { kind: "group", expression: deep };
  assert.equal(writeJson(deep), JSON.stringify(deep));
});

test("what is not JSON data is refused", () => {
  class Point {
    x = 1;
  }
  for (const value of [
    undefined,
    Number.NaN,
    Infinity,
    () => 1,
    Symbol("s"),
    1n,
    new Point(),
    [undefined],
  ])
    assert.throws(() => writeJson(value), TypeError, String(value));
});
