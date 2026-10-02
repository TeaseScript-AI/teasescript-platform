import assert from "node:assert/strict";
import test from "node:test";

import { createCheckpoint, restoreCheckpoint } from "../src/runtime/checkpoint.js";
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
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("rejects zero xorshift32 seeds and direct zero-state advancement", () => {
  assert.throws(() => createXorShift32State(0), RangeError);

  assert.throws(() => nextXorShift32({ algorithm: XORSHIFT32_ALGORITHM, state: 0 }), TypeError);
});

test("rejects zero RNG state at fresh snapshot and validation boundaries", () => {
  const compiled = plan("exit");

  assert.throws(() => createFreshRuntimeSnapshot(compiled, { seed: 0 }), RangeError);

  const snapshot = createFreshRuntimeSnapshot(compiled);
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
  snapshot.rng.state = 0;

  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, false);
});

test("rejects checkpoint restore with a zero RNG state", () => {
  const compiled = plan("exit");
  // EVIDENCE: fixture: JSON.parse reconstructs the checkpoint just serialized by createCheckpoint.
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled))),
  ) as { snapshot: RuntimeSnapshot };
  assert.equal(restoreCheckpoint(checkpoint).snapshot.rng.state, checkpoint.snapshot.rng.state);
  checkpoint.snapshot.rng.state = 0;

  assertCheckpointRejected(checkpoint, "TSK002");
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

test("xorshift32-v1 matches the published xorshift32 (13, 17, 5) known-answer sequence", () => {
  // The one canonical known-answer vector for the versioned algorithm (ADR 0015): Marsaglia's
  // 32-bit xorshift with shifts 13, 17 and 5 from seed 1, each state returned divided by 2^32.
  // A different sequence needs a new algorithm version; higher-level tests check ranges and
  // repeatability instead of output sequences.
  const rng = createXorShift32State(1);
  for (const expectedState of [270_369, 67_634_689, 2_647_435_461, 307_599_695, 2_398_689_233]) {
    assert.equal(nextXorShift32(rng), expectedState / 0x1_0000_0000);
    assert.deepEqual(rng, { algorithm: "xorshift32-v1", state: expectedState });
  }
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
