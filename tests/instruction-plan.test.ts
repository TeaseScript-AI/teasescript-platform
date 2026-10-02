import assert from "node:assert/strict";
import test from "node:test";

import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";
import { run } from "../src/runtime/engine.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("compiles if and else so that only the selected branch runs", () => {
  const branchSource = (condition: string) =>
    [`if ${condition} {`, '  say "yes"', "} else {", '  say "no"', "}"].join("\n");
  for (const [condition, expected] of [
    ["true", ["yes"]],
    ["false", ["no"]],
  ] as const) {
    const branchPlan = plan(branchSource(condition));
    const result = run(branchPlan, createFreshRuntimeSnapshot(branchPlan));
    assert.deepEqual(
      result.events.filter((event) => event.kind === "say").map((event) => event.text),
      expected,
      condition,
    );
  }
});

test("preserves relevant statement and nested expression source spans", () => {
  const source = "let total = 1 + 2";
  const compiled = plan(source);
  const instruction = compiled.instructions[0];

  assert.equal(instruction?.kind, "declareBinding");
  if (instruction?.kind !== "declareBinding") return;
  assert.deepEqual([instruction.span.so, instruction.span.eo], [0, source.length]);
  assert.deepEqual(
    [instruction.value.span.so, instruction.value.span.eo],
    [source.indexOf("1"), source.length],
  );
});

test("survives JSON stringify and parse as an equivalent executable plan", () => {
  const original = plan('let value = [1, 2]\nsay "${value.first}"\nexit');
  const restored: unknown = JSON.parse(JSON.stringify(original));

  assert.equal(validateInstructionPlan(restored).valid, true);
  assert.deepEqual(restored, original);
  // EVIDENCE: validation above established that the JSON-round-tripped value is an InstructionPlan.
  const restoredPlan = restored as InstructionPlan;
  const result = run(restoredPlan, createFreshRuntimeSnapshot(restoredPlan));
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["1"],
  );
});

test("rejects an out-of-range jumpIfFalse target", () => {
  // EVIDENCE: fixture: parse a compiler-produced plan into a mutable instruction dictionary for malformed jump injection.
  const malformed = JSON.parse(JSON.stringify(plan("if true { exit }"))) as {
    instructions: Array<Record<string, unknown>>;
  };
  const jumpIndex = malformed.instructions.findIndex(
    (instruction) => instruction.kind === "jumpIfFalse",
  );
  const jump = malformed.instructions[jumpIndex];
  assert.ok(jump !== undefined);
  jump.target = 999;

  const validation = validateInstructionPlan(malformed);
  assert.equal(validation.valid, false);
  assert.deepEqual(
    validation.errors
      .filter((error) => error.path === `$.instructions[${jumpIndex}].target`)
      .map((error) => error.code),
    ["TSC002"],
  );
});

test("contains no non-JSON-safe values and rejects them when supplied", () => {
  const compiled = plan("let value = { nested: set[1, 2] }\nexit");
  assert.doesNotThrow(() => JSON.stringify(compiled));
  assert.equal(findNonJsonValue(compiled), null);

  // EVIDENCE: fixture: parse the JSON-safe compiled plan into the mutable declaration shape of its set literal for invalid-value injection.
  const malformed = JSON.parse(JSON.stringify(compiled)) as {
    instructions: Array<{
      value: { properties: Array<{ value: { elements: Array<Record<string, unknown>> } }> };
    }>;
  };
  // A known literal-value field, so the rejection is about the value and not about an unknown key.
  malformed.instructions[0]!.value.properties[0]!.value.elements[0]!.value = () => undefined;
  const validation = validateInstructionPlan(malformed);
  assert.ok(
    validation.errors.some(
      (error) =>
        error.code === "TSC002" &&
        error.path === "$.instructions[0].value.properties[0].value.elements[0].value",
    ),
    JSON.stringify(validation.errors),
  );
});

test("compiler-produced plans remain deeply frozen", () => {
  const compiled = plan("let value = { nested: [1, { deeper: 2 }] }\nexit");
  const instruction = compiled.instructions[0];
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.instructions), true);
  assert.equal(Object.isFrozen(instruction), true);
  if (instruction?.kind !== "declareBinding" || instruction.value.kind !== "object") {
    assert.fail("Expected object declaration plan.");
  }
  assert.equal(Object.isFrozen(instruction.value.properties), true);
  assert.equal(Object.isFrozen(instruction.value.properties[0]), true);
  assert.equal(Object.isFrozen(instruction.value.properties[0]!.value), true);
  const list = instruction.value.properties[0]!.value;
  const inner = list.kind === "list" ? list.elements[1] : undefined;
  if (list.kind !== "list" || inner?.kind !== "object") {
    assert.fail("Expected nested list and object plans.");
  }
  for (const node of [
    list.elements,
    list.elements[0],
    inner,
    inner.properties,
    inner.properties[0],
    inner.properties[0]?.value,
  ]) {
    assert.ok(typeof node === "object" && Object.isFrozen(node));
  }
});

function findNonJsonValue(value: unknown, active = new Set<object>()): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : "number";
  if (typeof value !== "object") return typeof value;
  if (active.has(value)) return "cycle";
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return "prototype";
  }
  active.add(value);
  for (const nested of Object.values(value)) {
    const failure = findNonJsonValue(nested, active);
    if (failure !== null) return failure;
  }
  active.delete(value);
  return null;
}
