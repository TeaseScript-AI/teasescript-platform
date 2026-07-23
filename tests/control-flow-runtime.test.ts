import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  validateInstructionPlan,
  type InstructionPlan,
} from "../src/instructions.js";
import {
  CheckpointError,
  createCheckpoint,
  restoreCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run, stepToEvent } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

test("executes exclusive and inclusive integer ranges", () => {
  assert.deepEqual(sayTexts(runSource("for value in 1..4 { say value }")), ["1", "2", "3"]);
  assert.deepEqual(sayTexts(runSource("for value in 1..=4 { say value }")), ["1", "2", "3", "4"]);
  assert.deepEqual(sayTexts(runSource("for value in 4..1 { say value }")), []);
});

test("iterates lists and sets in order and performs zero iterations", () => {
  const result = runSource([
    'for item in ["a", "b"] { say item }',
    'for item in set["b", "a", "b"] { say item }',
    "repeat 0 { say \"never\" }",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["a", "b", "b", "a"]);
});

test("supports nested loops, repeat, break, continue, and lexical variables", () => {
  const result = runSource([
    "repeat 2 {",
    "  for value in 1..=4 {",
    "    if value == 2 { continue }",
    "    if value == 4 { break }",
    "    say value",
    "  }",
    "}",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["1", "3", "1", "3"]);
  assert.deepEqual(result.snapshot.loopFrames, []);
  assert.equal(result.snapshot.frames.length, 1);
});

test("executes while and else-if deterministically", () => {
  const result = runSource([
    "let count = 0",
    "while count < 2 { count = count + 1 }",
    'if count == 1 { say "one" } else if count == 2 { say "two" } else { say "other" }',
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["two"]);
});

test("uses one deterministic RNG for random, chance, and randomInteger", () => {
  const source = [
    "say random()",
    "say chance(50)",
    "say randomInteger(1..=6)",
    "say randomInteger(0..3)",
  ].join("\n");
  const first = runSource(source, 0x1234_5678);
  const second = runSource(source, 0x1234_5678);

  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.snapshot.rng, second.snapshot.rng);
  assert.deepEqual(sayTexts(first).slice(2), ["2", "1"]);
});

test("invalid random built-in arguments fail with source-associated errors", () => {
  for (const source of ["say chance(101)", "say randomInteger(1.5..=3)", "say randomInteger(3..3)"]) {
    const compiled = compileSource(source);
    if (compiled.plan === null) {
      assert.ok(compiled.diagnostics.length > 0);
      continue;
    }
    const result = run(compiled.plan, createFreshRuntimeSnapshot(compiled.plan));
    assert.equal(result.snapshot.status, "failed");
    assert.equal(result.events.at(-1)?.kind, "runtimeFailure");
    assert.ok(result.snapshot.failure?.span.start.offset !== undefined);
  }
});

test("instruction budget stops an infinite while loop", () => {
  const compiled = plan("while true {}\n");
  const result = run(compiled, createFreshRuntimeSnapshot(compiled), {}, { instructionBudget: 20 });

  assert.equal(result.snapshot.failure?.code, "TSR037");
});

test("loop plans are deterministic, JSON-safe, and reject malformed targets", () => {
  const source = [
    "for value in 1..=3 {",
    "  if value == 2 { continue }",
    "  say value",
    "}",
  ].join("\n");
  const first = plan(source);
  const second = plan(source);
  assert.deepEqual(first, second);
  const parsed = JSON.parse(JSON.stringify(first)) as InstructionPlan;
  assert.deepEqual(parsed, first);
  assert.equal(validateInstructionPlan(parsed).valid, true);
  const control = parsed.instructions.find((instruction) => instruction.kind === "loopControl");
  assert.ok(control?.kind === "loopControl");
  (control as { target: number }).target = parsed.instructions.length;
  assert.equal(validateInstructionPlan(parsed).valid, false);
});

test("checkpoint restore in every loop kind matches uninterrupted events", () => {
  for (const source of [
    'repeat 3 { say "repeat" }',
    'for value in ["a", "b", "c"] { say value }',
    'for value in set["a", "b", "c"] { say value }',
    "for value in 1..=3 { say value }",
    "let value = 0\nwhile value < 3 { value = value + 1\nsay value }",
    "for value in 1..=3 {\n  if value == 1 { continue }\n  say value\n}",
  ]) {
    assertResumeMatches(source);
  }
});

test("checkpoint restore preserves RNG and event sequences between calls", () => {
  const compiled = plan("say random()\nsay randomInteger(1..=10)\nexit");
  const initial = createFreshRuntimeSnapshot(compiled, { seed: 77 });
  const uninterrupted = run(compiled, initial);
  const first = stepToEvent(compiled, initial);
  const checkpoint = restoreCheckpoint(
    JSON.parse(JSON.stringify(createCheckpoint(compiled, first.snapshot))) as unknown,
  );
  const rest = run(checkpoint.plan, checkpoint.snapshot);

  assert.deepEqual([...first.events, ...rest.events], uninterrupted.events);
  assert.deepEqual(rest.snapshot.rng, uninterrupted.snapshot.rng);
  assert.deepEqual(rest.events.map((event) => event.sequence), [2, 3]);
});

test("rejects old formats and malformed serialized loop state", () => {
  const compiled = plan("for value in 1..=3 { say value }");
  const active = stepToEvent(compiled, createFreshRuntimeSnapshot(compiled));
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(compiled, active.snapshot)),
  ) as Record<string, unknown>;

  checkpoint.version = 1;
  assertCheckpointRejected(checkpoint, "TSK001");
  checkpoint.version = 2;
  const snapshot = checkpoint.snapshot as Record<string, unknown>;
  snapshot.version = 1;
  assertCheckpointRejected(checkpoint, "TSK001");
  snapshot.version = 2;
  const checkpointPlan = checkpoint.plan as Record<string, unknown>;
  checkpointPlan.version = 1;
  assertCheckpointRejected(checkpoint, "TSK001");
  checkpointPlan.version = 2;
  const loops = snapshot.loopFrames as Array<Record<string, unknown>>;
  loops[0]!.position = 99;
  assertCheckpointRejected(checkpoint, "TSK002");
});

test("rejects loop frames that do not match the next plan instruction", () => {
  const compiled = plan('repeat 2 { say "again" }');
  const active = stepToEvent(compiled, createFreshRuntimeSnapshot(compiled));
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(compiled, active.snapshot)),
  ) as { snapshot: { loopFrames: Array<{ loopId: number }> } };
  checkpoint.snapshot.loopFrames[0]!.loopId = 999;

  assertCheckpointRejected(checkpoint, "TSK002");
});

test("loop variables deep-copy composite list elements", () => {
  const result = runSource([
    "let source = [[1], [2]]",
    "for item in source { item[0] = 9 }",
    "say source[0][0]",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["1"]);
});

function assertResumeMatches(source: string): void {
  const compiled = plan(source);
  const initial = createFreshRuntimeSnapshot(compiled, { seed: 9 });
  const uninterrupted = run(compiled, initial);
  const first = stepToEvent(compiled, initial);
  assert.ok(first.snapshot.loopFrames.length > 0);
  const checkpoint = restoreCheckpoint(
    JSON.parse(JSON.stringify(createCheckpoint(compiled, first.snapshot))) as unknown,
  );
  const resumed = run(checkpoint.plan, checkpoint.snapshot);
  assert.deepEqual([...first.events, ...resumed.events], uninterrupted.events);
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
}

function runSource(source: string, seed = 1) {
  const compiled = plan(source);
  return run(compiled, createFreshRuntimeSnapshot(compiled, { seed }));
}

function sayTexts(result: ReturnType<typeof run>): string[] {
  return result.events.filter((event) => event.kind === "say").map((event) => event.text);
}

function plan(source: string): InstructionPlan {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
}

function assertCheckpointRejected(value: unknown, code: string): void {
  assert.throws(() => restoreCheckpoint(value), (error: unknown) =>
    error instanceof CheckpointError && error.info.code === code
  );
}
