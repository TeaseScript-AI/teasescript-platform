import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  CheckpointError,
  createCheckpoint,
  restoreCheckpoint,
} from "../src/runtime/checkpoint.js";
import {
  createXorShift32State,
  nextXorShift32,
  XORSHIFT32_ALGORITHM,
} from "../src/runtime/random.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";

test("rejects zero xorshift32 seeds and direct zero-state advancement", () => {
  assert.throws(
    () => createXorShift32State(0),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message === "The xorshift32 seed must be a non-zero unsigned 32-bit integer.",
  );

  assert.throws(
    () => nextXorShift32({ algorithm: XORSHIFT32_ALGORITHM, state: 0 }),
    (error: unknown) =>
      error instanceof TypeError && error.message === "Malformed xorshift32 state.",
  );
});

test("rejects zero RNG state at fresh snapshot and validation boundaries", () => {
  const compiled = plan("exit");

  assert.throws(
    () => createFreshRuntimeSnapshot(compiled, { seed: 0 }),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message === "The xorshift32 seed must be a non-zero unsigned 32-bit integer.",
  );

  const snapshot = createFreshRuntimeSnapshot(compiled);
  snapshot.rng.state = 0;
  const validation = validateRuntimeSnapshot(snapshot, compiled);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes("Runtime RNG state is malformed or unsupported."));
});

test("rejects checkpoint restore with a zero RNG state", () => {
  const compiled = plan("exit");
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled))),
  ) as { snapshot: RuntimeSnapshot };
  checkpoint.snapshot.rng.state = 0;

  assert.throws(
    () => restoreCheckpoint(checkpoint),
    (error: unknown) =>
      error instanceof CheckpointError &&
      error.info.code === "TSK002" &&
      error.info.message === "Runtime RNG state is malformed or unsupported.",
  );
});

test("preserves deterministic advancement for valid non-zero seeds", () => {
  const first = createXorShift32State(0x1234_5678);
  const second = createXorShift32State(0x1234_5678);
  const firstValues = Array.from({ length: 5 }, () => nextXorShift32(first));
  const secondValues = Array.from({ length: 5 }, () => nextXorShift32(second));

  assert.deepEqual(firstValues, secondValues);
  assert.deepEqual(first, second);
  assert.ok(firstValues.every((value) => value >= 0 && value < 1));
});

function plan(source: string): InstructionPlan {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
}
