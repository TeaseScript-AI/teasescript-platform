import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/instructions.js";
import {
  run,
  type RuntimeOperationResult,
} from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

test("selects an eligible visible list value exactly once", () => {
  const direct = runSource('say ["left", 2]', 0.75);
  assert.equal(direct.result.snapshot.failure, null);
  assert.equal(direct.randomCalls, 1);
  assert.deepEqual(sayTexts(direct.result), ["2"]);

  const template = runSource([
    'let values = ["left", 2]',
    'say `Value: ${values}`',
  ].join("\n"), 0);
  assert.equal(template.result.snapshot.failure, null);
  assert.equal(template.randomCalls, 1);
  assert.deepEqual(sayTexts(template.result), ["Value: left"]);
});

test("rejects ineligible automatically selected list values with one RNG call", () => {
  const cases = [
    "say [true]",
    "say [null]",
    "say [{ value: 1 }]",
    "say [set[1]]",
    "say [1..2]",
    'say [["nested"]]',
    "speaker vera {}\nsay [vera]",
  ] as const;

  for (const source of cases) {
    const execution = runSource(source, 0);
    assert.equal(execution.randomCalls, 1, source);
    assert.equal(execution.result.snapshot.status, "failed", source);
    assert.equal(execution.result.snapshot.failure?.code, "TSR021", source);
    assert.deepEqual(sayTexts(execution.result), [], source);
  }
});

test("preserves direct scalar visible-text conversion", () => {
  const execution = runSource([
    "say true",
    "say null",
    "say 3.5",
  ].join("\n"), 0);

  assert.equal(execution.result.snapshot.failure, null);
  assert.equal(execution.randomCalls, 0);
  assert.deepEqual(sayTexts(execution.result), ["true", "null", "3.5"]);
});

function runSource(
  source: string,
  randomValue: number,
): { readonly result: RuntimeOperationResult; readonly randomCalls: number } {
  const plan = compile(source);
  let randomCalls = 0;
  const result = run(
    plan,
    createFreshRuntimeSnapshot(plan),
    {
      random: {
        next(): number {
          randomCalls += 1;
          return randomValue;
        },
      },
    },
  );
  return { result, randomCalls };
}

function compile(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function sayTexts(result: RuntimeOperationResult): string[] {
  return result.events
    .filter((event) => event.kind === "say")
    .map((event) => event.text);
}
