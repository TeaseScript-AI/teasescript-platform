import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  validateInstructionPlan,
  type InstructionPlan,
} from "../src/instructions.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";
import { run } from "../src/runtime/engine.js";

test("compiles deterministically to the same instruction plan", () => {
  const source = 'let score = 1\nscore = score + 1\nsay `${score}`\nexit';

  assert.deepEqual(plan(source), plan(source));
});

test("compiles if and else to explicit validated jump targets", () => {
  const compiled = plan([
    "if true {",
    '  say "yes"',
    "} else {",
    '  say "no"',
    "}",
  ].join("\n"));

  assert.deepEqual(
    compiled.instructions.map((instruction) =>
      instruction.kind === "jump" || instruction.kind === "jumpIfFalse"
        ? [instruction.kind, instruction.target]
        : instruction.kind,
    ),
    [
      ["jumpIfFalse", 5],
      "enterScope",
      "say",
      "leaveScope",
      ["jump", 8],
      "enterScope",
      "say",
      "leaveScope",
    ],
  );
  assert.equal(validateInstructionPlan(compiled).valid, true);
});

test("preserves relevant statement and nested expression source spans", () => {
  const source = "let total = 1 + 2";
  const compiled = plan(source);
  const instruction = compiled.instructions[0];

  assert.equal(instruction?.kind, "declareBinding");
  if (instruction?.kind !== "declareBinding") return;
  assert.deepEqual(
    [instruction.span.start.offset, instruction.span.end.offset],
    [0, source.length],
  );
  assert.deepEqual(
    [instruction.value.span.start.offset, instruction.value.span.end.offset],
    [source.indexOf("1"), source.length],
  );
});

test("survives JSON stringify and parse as an equivalent executable plan", () => {
  const original = plan('let value = [1, 2]\nsay `${value.first}`\nexit');
  const restored = JSON.parse(JSON.stringify(original)) as unknown;

  assert.equal(validateInstructionPlan(restored).valid, true);
  assert.deepEqual(restored, original);
  const result = run(
    restored as InstructionPlan,
    createFreshRuntimeSnapshot(restored as InstructionPlan),
  );
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["1"],
  );
});

test("rejects malformed instructions and out-of-range jumps", () => {
  const malformed = JSON.parse(JSON.stringify(plan("if true { exit }"))) as {
    instructions: Array<Record<string, unknown>>;
  };
  const jump = malformed.instructions.find((instruction) => instruction.kind === "jumpIfFalse");
  assert.ok(jump !== undefined);
  jump.target = 999;

  const validation = validateInstructionPlan(malformed);
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0]?.message ?? "", /Jump target/u);
});

test("contains no non-JSON-safe values and rejects them when supplied", () => {
  const compiled = plan("let value = { nested: set[1, 2] }\nexit");
  assert.doesNotThrow(() => JSON.stringify(compiled));
  assert.equal(findNonJsonValue(compiled), null);

  const malformed = JSON.parse(JSON.stringify(compiled)) as {
    instructions: Array<Record<string, unknown>>;
  };
  malformed.instructions[0]!.callback = () => undefined;
  assert.equal(validateInstructionPlan(malformed).valid, false);
});

function plan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

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
