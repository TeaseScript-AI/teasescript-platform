import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  validateInstructionPlan,
  type Instruction,
  type InstructionPlan,
  type PlanValidationResult,
} from "../src/instructions.js";
import {
  CheckpointError,
  createCheckpoint,
  restoreCheckpoint,
} from "../src/runtime/checkpoint.js";
import {
  executeInstruction,
  run,
  RuntimeDataError,
} from "../src/runtime/engine.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
} from "../src/runtime/state.js";

const REGION_ERROR = "Control-flow target leaves the instruction's execution region.";

test("rejects a root jump into a function prologue", () => {
  const compiled = plan(rootBranchWithTwoFunctions());
  const jumpIndex = rootInstructionIndex(compiled, "jump");
  const second = compiled.functions[1]!;
  const malformed = mutateTarget(compiled, jumpIndex, "target", second.entryInstruction);

  assertRegionError(validateInstructionPlan(malformed), `$.instructions[${jumpIndex}].target`);
});

test("rejects a root conditional jump into a function body", () => {
  const compiled = plan(rootBranchWithTwoFunctions());
  const jumpIndex = rootInstructionIndex(compiled, "jumpIfFalse");
  const second = compiled.functions[1]!;
  const malformed = mutateTarget(compiled, jumpIndex, "target", second.bodyEntryInstruction);

  assertRegionError(validateInstructionPlan(malformed), `$.instructions[${jumpIndex}].target`);
});

test("rejects a function jump into root execution", () => {
  const compiled = plan(functionBranches());
  const first = compiled.functions[0]!;
  const jumpIndex = functionInstructionIndex(compiled, first.id, "jump");
  const malformed = mutateTarget(compiled, jumpIndex, "target", 0);

  assertRegionError(validateInstructionPlan(malformed), `$.instructions[${jumpIndex}].target`);
});

test("rejects a function A jump into function B", () => {
  const compiled = plan(functionBranches());
  const first = compiled.functions[0]!;
  const second = compiled.functions[1]!;
  const jumpIndex = functionInstructionIndex(compiled, first.id, "jump");
  const malformed = mutateTarget(compiled, jumpIndex, "target", second.bodyEntryInstruction);

  assertRegionError(validateInstructionPlan(malformed), `$.instructions[${jumpIndex}].target`);
});

test("rejects cross-region loopStart continue targets", () => {
  const compiled = plan(functionLoop());
  const definition = compiled.functions[0]!;
  const loopIndex = functionInstructionIndex(compiled, definition.id, "loopStart");
  const malformed = mutateTarget(compiled, loopIndex, "continueTarget", 0);

  assertRegionError(
    validateInstructionPlan(malformed),
    `$.instructions[${loopIndex}].continueTarget`,
  );
});

test("rejects cross-region loopStart exit targets", () => {
  const compiled = plan(functionLoop());
  const definition = compiled.functions[0]!;
  const loopIndex = functionInstructionIndex(compiled, definition.id, "loopStart");
  const malformed = mutateTarget(compiled, loopIndex, "target", 0);

  assertRegionError(validateInstructionPlan(malformed), `$.instructions[${loopIndex}].target`);
});

test("rejects cross-region loopControl targets", () => {
  const compiled = plan(functionLoop());
  const definition = compiled.functions[0]!;
  const controlIndex = functionInstructionIndex(compiled, definition.id, "loopControl");
  const malformed = mutateTarget(compiled, controlIndex, "target", 0);

  assertRegionError(validateInstructionPlan(malformed), `$.instructions[${controlIndex}].target`);
});

test("preserves valid root-local and function-local jumps", () => {
  const compiled = plan(functionBranches());
  const rootJump = rootInstructionIndex(compiled, "jump");
  const functionJump = functionInstructionIndex(compiled, compiled.functions[0]!.id, "jump");

  assert.ok(targetOf(compiled, rootJump, "target") < compiled.rootEndInstruction);
  assert.ok(
    targetOf(compiled, functionJump, "target") >= compiled.functions[0]!.entryInstruction,
  );
  assert.ok(
    targetOf(compiled, functionJump, "target") < compiled.functions[0]!.endInstruction,
  );
  assert.equal(validateInstructionPlan(compiled).valid, true);
});

test("preserves a compiler-generated root-end target", () => {
  const compiled = plan([
    'function hidden { say "hidden" }',
    'if false { say "never" }',
  ].join("\n"));
  const jumpIndex = rootInstructionIndex(compiled, "jumpIfFalse");

  assert.equal(targetOf(compiled, jumpIndex, "target"), compiled.rootEndInstruction);
  assert.equal(validateInstructionPlan(compiled).valid, true);
});

test("preserves a compiler-generated owning-function implicit-return target", () => {
  const compiled = plan([
    "function boundary {",
    '  if false { say "never" }',
    "}",
    "boundary()",
    "exit",
  ].join("\n"));
  const definition = compiled.functions[0]!;
  const jumpIndex = functionInstructionIndex(compiled, definition.id, "jumpIfFalse");

  assert.equal(
    targetOf(compiled, jumpIndex, "target"),
    definition.implicitReturnInstruction,
  );
  assert.equal(validateInstructionPlan(compiled).valid, true);
});

test("keeps function-call return targets inside the caller region", () => {
  const compiled = plan(rootBranchWithTwoFunctions());
  const callSource = [
    'function first { say "first" }',
    'function second { say "second" }',
    "first()",
    "exit",
  ].join("\n");
  const callable = plan(callSource);
  const callIndex = rootInstructionIndex(callable, "callFunction");
  const malformed = mutateTarget(
    callable,
    callIndex,
    "returnInstruction",
    callable.functions[1]!.bodyEntryInstruction,
  );

  assertRegionError(
    validateInstructionPlan(malformed),
    `$.instructions[${callIndex}].returnInstruction`,
  );
  assert.equal(validateInstructionPlan(compiled).valid, true);
});

test("keeps parameter-default targets inside their function region", () => {
  const compiled = plan([
    "function first(value = 1) { say value }",
    "function second { say 2 }",
    "first()",
    "exit",
  ].join("\n"));
  const first = compiled.functions[0]!;
  const prepareIndex = functionInstructionIndex(
    compiled,
    first.id,
    "prepareParameterDefault",
  );
  const malformed = mutateTarget(
    compiled,
    prepareIndex,
    "target",
    compiled.functions[1]!.entryInstruction,
  );

  assertRegionError(
    validateInstructionPlan(malformed),
    `$.instructions[${prepareIndex}].target`,
  );
});

test("preserves compiler-generated control flow, calls, and returns", () => {
  const sources = [
    rootBranchWithTwoFunctions(),
    functionBranches(),
    functionLoop(),
    [
      "function answer { return 42 }",
      "let result = answer()",
      "say result",
      "exit",
    ].join("\n"),
  ];

  for (const source of sources) {
    assert.equal(validateInstructionPlan(plan(source)).valid, true);
  }

  const callable = plan(sources[3]!);
  const completed = run(callable, createFreshRuntimeSnapshot(callable));
  assert.equal(completed.snapshot.status, "halted");
  assert.deepEqual(
    completed.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["42"],
  );
});

test("preserves checkpoint round trips for valid function control flow", () => {
  const compiled = plan(functionLoop());
  const initial = createFreshRuntimeSnapshot(compiled);
  const first = executeInstruction(compiled, initial);
  const checkpoint = createCheckpoint(compiled, first.snapshot);
  const restored = restoreCheckpoint(JSON.parse(JSON.stringify(checkpoint)) as unknown);
  const uninterrupted = run(compiled, first.snapshot);
  const resumed = run(restored.plan, restored.snapshot);

  assert.deepEqual(resumed.events, uninterrupted.events);
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
});

test("prevents the poisoned-snapshot path before execution", () => {
  const original = plan([
    'function hidden { say "inside function" }',
    "if false { exit }",
  ].join("\n"));
  const jumpIndex = rootInstructionIndex(original, "jumpIfFalse");
  const malformed = mutateTarget(
    original,
    jumpIndex,
    "target",
    original.functions[0]!.bodyEntryInstruction,
  );
  const validation = validateInstructionPlan(malformed);

  if (validation.valid) {
    const firstStep = executeInstruction(
      malformed,
      createFreshRuntimeSnapshot(malformed),
    );
    assert.equal(firstStep.instructionsExecuted, 1);
    assert.equal(validateRuntimeSnapshot(firstStep.snapshot, malformed).valid, false);
  }

  assertRegionError(validation, `$.instructions[${jumpIndex}].target`);
  assert.throws(
    () => createFreshRuntimeSnapshot(malformed),
    /Control-flow target leaves the instruction's execution region\./,
  );
  assert.throws(
    () => executeInstruction(malformed, createFreshRuntimeSnapshot(original)),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
  );
});

test("rejects malformed cross-region plans during checkpoint restoration", () => {
  const original = plan([
    'function hidden { say "inside function" }',
    "if false { exit }",
  ].join("\n"));
  const jumpIndex = rootInstructionIndex(original, "jumpIfFalse");
  const malformed = mutateTarget(
    original,
    jumpIndex,
    "target",
    original.functions[0]!.bodyEntryInstruction,
  );
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(original, createFreshRuntimeSnapshot(original))),
  ) as { plan: InstructionPlan };
  checkpoint.plan = malformed;

  assert.throws(() => restoreCheckpoint(checkpoint), (error: unknown) => {
    return error instanceof CheckpointError &&
      error.info.code === "TSK002" &&
      error.info.path === `$.plan.instructions[${jumpIndex}].target` &&
      error.info.message === REGION_ERROR;
  });
});

test("keeps snapshots valid after accepted root control flow reaches its boundary", () => {
  const compiled = plan([
    'function hidden { say "hidden" }',
    'if false { say "never" }',
  ].join("\n"));
  const initial = createFreshRuntimeSnapshot(compiled);
  const first = executeInstruction(compiled, initial);

  assert.equal(first.snapshot.status, "halted");
  assert.equal(first.snapshot.nextInstruction, compiled.rootEndInstruction);
  assert.equal(validateRuntimeSnapshot(first.snapshot, compiled).valid, true);
});

function rootBranchWithTwoFunctions(): string {
  return [
    'function first { say "first" }',
    'function second { say "second" }',
    "if true {",
    '  say "root then"',
    "} else {",
    '  say "root else"',
    "}",
    "exit",
  ].join("\n");
}

function functionBranches(): string {
  return [
    "function first {",
    "  if true {",
    '    say "first then"',
    "  } else {",
    '    say "first else"',
    "  }",
    "}",
    "function second {",
    "  if true {",
    '    say "second then"',
    "  } else {",
    '    say "second else"',
    "  }",
    "}",
    "if true {",
    '  say "root then"',
    "} else {",
    '  say "root else"',
    "}",
    "first()",
    "exit",
  ].join("\n");
}

function functionLoop(): string {
  return [
    "function looper {",
    "  repeat 2 {",
    "    continue",
    "  }",
    "}",
    "looper()",
    "exit",
  ].join("\n");
}

function plan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function rootInstructionIndex(plan: InstructionPlan, kind: Instruction["kind"]): number {
  const index = plan.instructions.findIndex(
    (instruction, instructionIndex) =>
      instructionIndex < plan.rootEndInstruction && instruction.kind === kind,
  );
  assert.notEqual(index, -1, `Expected root ${kind} instruction.`);
  return index;
}

function functionInstructionIndex(
  plan: InstructionPlan,
  functionId: number,
  kind: Instruction["kind"],
): number {
  const definition = plan.functions.find((item) => item.id === functionId);
  assert.ok(definition !== undefined);
  for (let index = definition.entryInstruction; index < definition.endInstruction; index += 1) {
    if (plan.instructions[index]?.kind === kind) return index;
  }
  assert.fail(`Expected function ${functionId} ${kind} instruction.`);
}

function mutateTarget(
  plan: InstructionPlan,
  instructionIndex: number,
  field: "target" | "continueTarget" | "returnInstruction",
  target: number,
): InstructionPlan {
  const clone = JSON.parse(JSON.stringify(plan)) as InstructionPlan;
  const instruction = clone.instructions[instructionIndex] as unknown as Record<string, unknown>;
  instruction[field] = target;
  return clone;
}

function targetOf(
  plan: InstructionPlan,
  instructionIndex: number,
  field: "target" | "continueTarget" | "returnInstruction",
): number {
  const instruction = plan.instructions[instructionIndex] as unknown as Record<string, unknown>;
  const target = instruction[field];
  assert.equal(typeof target, "number");
  return target as number;
}

function assertRegionError(result: PlanValidationResult, path: string): void {
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.filter((error) => error.message === REGION_ERROR),
    [{ code: "TSC002", message: REGION_ERROR, path }],
  );
}
