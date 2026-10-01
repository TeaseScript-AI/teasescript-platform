import assert from "node:assert/strict";
import test from "node:test";

import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";
import { run } from "../src/runtime/engine.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

test("compiles deterministically to the same instruction plan", () => {
  const source = 'let score = 1\nscore = score + 1\nsay "${score}"\nexit';

  assert.deepEqual(plan(source), plan(source));
});

test("compiles if and else to explicit validated jump targets", () => {
  const branches = (condition: string) =>
    ["if " + condition + " {", '  say "yes"', "} else {", '  say "no"', "}"].join("\n");
  const compiled = plan(branches("true"));
  const sayIndex = (text: string) =>
    compiled.instructions.findIndex(
      (instruction) =>
        instruction.kind === "say" &&
        instruction.value.kind === "literal" &&
        instruction.value.value === text,
    );
  const conditionIndex = compiled.instructions.findIndex(
    (instruction) => instruction.kind === "jumpIfFalse",
  );
  const skipElseIndex = compiled.instructions.findIndex(
    (instruction, index) => index > sayIndex("yes") && instruction.kind === "jump",
  );
  const condition = compiled.instructions[conditionIndex];
  const skipElse = compiled.instructions[skipElseIndex];
  assert.ok(condition?.kind === "jumpIfFalse" && skipElse?.kind === "jump");

  // The false edge enters the else branch after the then branch's exit jump, which skips past it.
  assert.ok(conditionIndex < sayIndex("yes") && sayIndex("yes") < skipElseIndex);
  assert.ok(skipElseIndex < condition.target && condition.target <= sayIndex("no"));
  assert.ok(skipElse.target > sayIndex("no"));
  assert.equal(validateInstructionPlan(compiled).valid, true);
  assert.deepEqual(sayTexts(runValidSource(branches("true"))), ["yes"]);
  assert.deepEqual(sayTexts(runValidSource(branches("false"))), ["no"]);
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

test("rejects an out-of-range jump target", () => {
  // EVIDENCE: fixture: parse a compiler-produced plan into a mutable instruction dictionary for malformed jump injection.
  const malformed = JSON.parse(JSON.stringify(plan("if true { exit }"))) as {
    instructions: Array<Record<string, unknown>>;
  };
  const jumpIndex = malformed.instructions.findIndex(
    (instruction) => instruction.kind === "jumpIfFalse",
  );
  assert.ok(jumpIndex >= 0);
  malformed.instructions[jumpIndex]!.target = 999;

  const validation = validateInstructionPlan(malformed);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some(
      (error) => error.code === "TSC002" && error.path === `$.instructions[${jumpIndex}].target`,
    ),
    JSON.stringify(validation.errors),
  );
});

test("contains no non-JSON-safe values and rejects them when supplied", () => {
  const compiled = plan("let value = { nested: set[1, 2] }\nexit");
  assert.doesNotThrow(() => JSON.stringify(compiled));
  assert.equal(findNonJsonValue(compiled), null);

  // EVIDENCE: fixture: parse the JSON-safe compiled plan into mutable instruction dictionaries for invalid-value injection.
  const malformed = JSON.parse(JSON.stringify(compiled)) as {
    instructions: Array<Record<string, unknown>>;
  };
  malformed.instructions[0]!.callback = () => undefined;
  assert.equal(validateInstructionPlan(malformed).valid, false);
});

test("compiler-produced plans remain deeply frozen", () => {
  const compiled = plan("let value = { nested: [1, { deeper: 2 }] }\nexit");
  const unfrozen: string[] = [];
  const objectPropertyNames: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value !== "object" || value === null) return;
    if (!Object.isFrozen(value)) unfrozen.push(path);
    for (const [key, nested] of Object.entries(value)) {
      if (path.endsWith(".properties") && typeof nested === "object" && nested !== null) {
        objectPropertyNames.push("name" in nested ? String(nested.name) : "");
      }
      visit(nested, `${path}.${key}`);
    }
  };
  visit(compiled, "plan");

  assert.deepEqual(objectPropertyNames, ["nested", "deeper"]);
  assert.deepEqual(unfrozen, []);
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
