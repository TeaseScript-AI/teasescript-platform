import assert from "node:assert/strict";
import test from "node:test";

import { run, type RuntimeOperationResult } from "../src/runtime/engine.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { compileValidPlan as compile } from "./helpers/compile-valid-plan.js";
import { sayTexts } from "./helpers/runtime-events.js";

test("interpolation selects one list element at every evaluation", () => {
  const template = runSource(
    ['let values = ["left", 2]', 'say "Value: ${values}"', 'say "${values} and ${values}"'].join(
      "\n",
    ),
    [0, 0.75, 0],
  );
  assert.equal(template.result.snapshot.failure, null);
  assert.equal(template.randomCalls, 3);
  assert.deepEqual(sayTexts(template.result), ["Value: left", "2 and left"]);
});

test("say shows every list element in order with scalar text conversion", () => {
  const execution = runSource(
    [
      'say ["pet", "puppy", "toy"]',
      "say [2.50, -0, 1e21]",
      "say [true, null, 90 seconds]",
      "let empty = []",
      "say empty",
      'let names = ["Ada"]',
      "say names",
    ].join("\n"),
    [],
  );
  assert.equal(execution.result.snapshot.failure, null);
  assert.equal(execution.randomCalls, 0);
  assert.deepEqual(sayTexts(execution.result), [
    "pet, puppy, toy",
    "2.5, 0, 1e+21",
    "true, null, 1 min 30 s",
    "",
    "Ada",
  ]);
});

test("say rejects a list that contains lists, sets, objects, or other non-text values", () => {
  for (const source of [
    'say [["nested"]]',
    "say [set[1]]",
    "say [{ value: 1 }]",
    "say [1..2]",
    "speaker vera {}\nsay [vera]",
  ]) {
    const execution = runSource(source, []);
    assert.equal(execution.randomCalls, 0, source);
    assert.equal(execution.result.snapshot.failure?.code, "TSR021", source);
    assert.deepEqual(sayTexts(execution.result), [], source);
  }
});

test("interpolation checks the whole list before selecting, so the outcome does not depend on the seed", () => {
  const cases = [
    ['let values = [true]\nsay "${values}"', "TSR021"],
    ['let values = ["ok", null]\nsay "${values}"', "TSR021"],
    ['let values = ["ok", { value: 1 }]\nsay "${values}"', "TSR021"],
    ['let values = ["ok", ["nested"]]\nsay "${values}"', "TSR021"],
    ['let values = ["ok", 90 seconds]\nsay "${values}"', "TSR021"],
    ['let values = []\nsay "${values}"', "TSR019"],
  ] as const;
  for (const [source, code] of cases) {
    for (const randomValue of [0, 0.75]) {
      const execution = runSource(source, [randomValue]);
      assert.equal(execution.randomCalls, 0, source);
      assert.equal(execution.result.snapshot.failure?.code, code, source);
      assert.deepEqual(sayTexts(execution.result), [], source);
    }
  }
  const empty = runSource('let values = []\nsay "${values}"', []);
  assert.equal(
    empty.result.snapshot.failure?.message,
    "An interpolated list must contain at least one element to select from.",
  );
});

test("preserves direct scalar visible-text conversion", () => {
  const execution = runSource(["say true", "say null", "say 3.5"].join("\n"), []);

  assert.equal(execution.result.snapshot.failure, null);
  assert.equal(execution.randomCalls, 0);
  assert.deepEqual(sayTexts(execution.result), ["true", "null", "3.5"]);
});

function runSource(
  source: string,
  randomValues: readonly number[],
): { readonly result: RuntimeOperationResult; readonly randomCalls: number } {
  const plan = compile(source);
  let randomCalls = 0;
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
    random: {
      next(): number {
        const value = randomValues[randomCalls];
        randomCalls += 1;
        if (value === undefined) throw new Error("Unexpected random draw.");
        return value;
      },
    },
  });
  return { result, randomCalls };
}
