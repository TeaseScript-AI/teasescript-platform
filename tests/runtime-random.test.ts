import assert from "node:assert/strict";
import test from "node:test";

import { CheckpointError, createCheckpoint, restoreCheckpoint } from "../src/runtime/checkpoint.js";
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
import { run } from "../src/runtime/engine.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

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
  // EVIDENCE: fixture: JSON.parse reconstructs the checkpoint just serialized by createCheckpoint.
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

test("distinguishes an absent random hook from invalid and valid hook results", () => {
  const compiled = plan("let value = random()\nexit");
  const seed = 0x1234_5678;
  const seededSnapshot = createFreshRuntimeSnapshot(compiled, { seed });
  const seeded = run(compiled, seededSnapshot);
  const expectedRng = createXorShift32State(seed);
  const expectedValue = nextXorShift32(expectedRng);

  assert.equal(seeded.snapshot.status, "halted");
  assert.deepEqual(seeded.snapshot.rng, expectedRng);
  assert.equal(
    seeded.snapshot.frames[0]?.bindings.find((binding) => binding.name === "value")?.value,
    expectedValue,
  );

  for (const invalidResult of [null, undefined] as const) {
    const snapshot = createFreshRuntimeSnapshot(compiled, { seed });
    let calls = 0;
    const result = run(compiled, snapshot, {
      random: {
        next: () => {
          calls += 1;
          // EVIDENCE: fixture: deliberately violates the hook's number contract to test runtime validation.
          return invalidResult as never;
        },
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.snapshot.status, "failed");
    assert.equal(result.snapshot.failure?.code, "TSR012");
    assert.equal(result.snapshot.rng.state, seed);
  }

  const overriddenSnapshot = createFreshRuntimeSnapshot(compiled, { seed });
  let overrideCalls = 0;
  const overridden = run(compiled, overriddenSnapshot, {
    random: {
      next: () => {
        overrideCalls += 1;
        return 0.25;
      },
    },
  });

  assert.equal(overrideCalls, 1);
  assert.equal(overridden.snapshot.status, "halted");
  assert.equal(overridden.snapshot.rng.state, seed);
  assert.equal(
    overridden.snapshot.frames[0]?.bindings.find((binding) => binding.name === "value")?.value,
    0.25,
  );
});
