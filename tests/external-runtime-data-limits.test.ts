import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CheckpointError,
  EXTERNAL_DATA_DEPTH_MESSAGE,
  EXTERNAL_DATA_WORK_MESSAGE,
  MAX_EXTERNAL_RUNTIME_DATA_DEPTH,
  MAX_EXTERNAL_RUNTIME_DATA_WORK,
  RuntimeDataError,
  cloneSerializableValue,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  executeInstruction,
  restoreCheckpoint,
  run,
  stepToEvent,
  validateInstructionPlan,
  validateRuntimeSnapshot,
  type InstructionPlan,
  type RuntimeCheckpoint,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { captureExternalData } from "../src/external-data-limits.js";
import {
  SerializableValueError,
  fromHostRuntimeValue,
  toHostRuntimeValue,
} from "../src/runtime/serializable-values.js";
import type { RuntimeValue } from "../src/runtime/values.js";

const FAILING_BEFORE_DEPTH = 20_000;

function compiledPlan(source = "exit"): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function mutablePlan(source = "exit"): Record<string, unknown> {
  return JSON.parse(JSON.stringify(compiledPlan(source))) as Record<string, unknown>;
}

function mutableSnapshot(plan: InstructionPlan): RuntimeSnapshot {
  return JSON.parse(
    JSON.stringify(createFreshRuntimeSnapshot(plan)),
  ) as RuntimeSnapshot;
}

function deepArray(depth: number): unknown {
  return JSON.parse(`${"[".repeat(depth)}0${"]".repeat(depth)}`) as unknown;
}

function deepObject(depth: number): unknown {
  return JSON.parse(`${'{"value":'.repeat(depth)}0${"}".repeat(depth)}`) as unknown;
}

function deepListJson(depth: number, leaf = '"leaf"'): string {
  return `${'{"kind":"list","items":['.repeat(depth)}${leaf}${"]}".repeat(depth)}`;
}

function deepList(depth: number): SerializableRuntimeValue {
  return JSON.parse(deepListJson(depth)) as SerializableRuntimeValue;
}

function deepSerializableObject(depth: number): SerializableRuntimeValue {
  return JSON.parse(
    `${'{"kind":"object","properties":[{"name":"value","value":'.repeat(depth)}` +
      `"leaf"${'}]}'.repeat(depth)}`,
  ) as SerializableRuntimeValue;
}

function addBinding(snapshot: RuntimeSnapshot, value: unknown): void {
  (snapshot.frames[0]!.bindings as Array<{ name: string; value: unknown }>).push({
    name: "deep",
    value,
  });
}

function checkpoint(plan: InstructionPlan, snapshot: RuntimeSnapshot): RuntimeCheckpoint {
  return JSON.parse(
    JSON.stringify(createCheckpoint(plan, snapshot)),
  ) as RuntimeCheckpoint;
}

function assertCheckpointError(
  operation: () => unknown,
  message: string,
  path?: string,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CheckpointError);
    assert.equal(error.info.code, "TSK002");
    assert.equal(error.info.message, message);
    if (path !== undefined) assert.equal(error.info.path, path);
    return true;
  });
}

function activeCallSnapshot(plan: InstructionPlan): RuntimeSnapshot {
  let snapshot = createFreshRuntimeSnapshot(plan);
  for (let steps = 0; steps < 20 && snapshot.callFrames.length === 0; steps += 1) {
    snapshot = executeInstruction(plan, snapshot).snapshot;
  }
  assert.ok(snapshot.callFrames.length > 0, "Expected an active call frame.");
  return JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshot;
}

test("plan validation rejects an above-limit nested array with TSC002 and an exact path", () => {
  const value = mutablePlan();
  value.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH);

  const result = validateInstructionPlan(value);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [{
    code: "TSC002",
    message: EXTERNAL_DATA_DEPTH_MESSAGE,
    path: `$.padding${"[0]".repeat(MAX_EXTERNAL_RUNTIME_DATA_DEPTH)}`,
  }]);
});

test("plan validation rejects an above-limit nested object without throwing", () => {
  const value = mutablePlan();
  value.padding = deepObject(MAX_EXTERNAL_RUNTIME_DATA_DEPTH);

  assert.doesNotThrow(() => validateInstructionPlan(value));
  const result = validateInstructionPlan(value);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0]?.code, "TSC002");
  assert.equal(result.errors[0]?.message, EXTERNAL_DATA_DEPTH_MESSAGE);
});

test("plan validation accepts nesting at the supported boundary", () => {
  const value = mutablePlan();
  value.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH - 1);
  assert.equal(validateInstructionPlan(value).valid, true);
});

test("plan validation bounds wide shallow external data", () => {
  const value = mutablePlan();
  value.padding = new Array(MAX_EXTERNAL_RUNTIME_DATA_WORK).fill(0);

  const result = validateInstructionPlan(value);

  assert.equal(result.valid, false);
  assert.equal(result.errors[0]?.code, "TSC002");
  assert.equal(result.errors[0]?.message, EXTERNAL_DATA_WORK_MESSAGE);
});

test("snapshot validation bounds nested binding lists and preserves below-limit values", () => {
  const plan = compiledPlan();
  const accepted = mutableSnapshot(plan);
  addBinding(accepted, deepList(50));
  assert.equal(validateRuntimeSnapshot(accepted, plan).valid, true);

  const rejected = mutableSnapshot(plan);
  addBinding(rejected, deepList(65));
  const result = validateRuntimeSnapshot(rejected, plan);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [EXTERNAL_DATA_DEPTH_MESSAGE]);
});

test("snapshot validation bounds a nested object in a speaker property", () => {
  const plan = compiledPlan();
  const snapshot = mutableSnapshot(plan);
  (snapshot.speakers as unknown as Array<Record<string, unknown>>).push({
    id: 1,
    identifier: "mistress",
    properties: [{ name: "profile", value: deepSerializableObject(50) }],
  });
  snapshot.nextSpeakerId = 2;

  const result = validateRuntimeSnapshot(snapshot, plan);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [EXTERNAL_DATA_DEPTH_MESSAGE]);
});

test("snapshot validation bounds a nested supplied call argument", () => {
  const plan = compiledPlan("function echo(value) { return value }\necho(1)\nexit");
  const snapshot = activeCallSnapshot(plan);
  const argument = snapshot.callFrames[0]!.arguments[0];
  assert.ok(argument?.supplied);
  (argument as { value: SerializableRuntimeValue }).value = deepList(65);

  const result = validateRuntimeSnapshot(snapshot, plan);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [EXTERNAL_DATA_DEPTH_MESSAGE]);
});

test("restoreCheckpoint rejects deeply nested plan data with structured TSK002", () => {
  const plan = compiledPlan();
  const value = checkpoint(plan, createFreshRuntimeSnapshot(plan)) as RuntimeCheckpoint & {
    plan: Record<string, unknown>;
  };
  value.plan.padding = deepArray(FAILING_BEFORE_DEPTH);

  assertCheckpointError(
    () => restoreCheckpoint(value),
    EXTERNAL_DATA_DEPTH_MESSAGE,
  );
  assert.equal(value.plan.padding !== undefined, true);
});

test("restoreCheckpoint rejects deeply nested snapshot data with structured TSK002", () => {
  const plan = compiledPlan();
  const value = checkpoint(plan, createFreshRuntimeSnapshot(plan));
  addBinding(value.snapshot, deepList(65));

  assertCheckpointError(
    () => restoreCheckpoint(value),
    EXTERNAL_DATA_DEPTH_MESSAGE,
    "$.snapshot",
  );
});

test("deserializeCheckpoint parses deep JSON first and returns structured TSK002", () => {
  const plan = compiledPlan();
  const value = {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan,
    snapshot: mutableSnapshot(plan),
  } as RuntimeCheckpoint;
  addBinding(value.snapshot, "__DEEP_VALUE__");
  const json = JSON.stringify(value).replace(
    '"__DEEP_VALUE__"',
    deepListJson(FAILING_BEFORE_DEPTH),
  );

  assert.doesNotThrow(() => JSON.parse(json) as unknown);
  assertCheckpointError(
    () => deserializeCheckpoint(json),
    EXTERNAL_DATA_DEPTH_MESSAGE,
    "$.snapshot",
  );
});

test("checkpoint restoration preserves valid below-limit nested values", () => {
  const plan = compiledPlan();
  const snapshot = mutableSnapshot(plan);
  addBinding(snapshot, deepList(50));

  const restored = restoreCheckpoint({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan,
    snapshot,
  });

  assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);
});

test("runtime entry points reject an over-limit plan before execution or RNG use", () => {
  const validPlan = compiledPlan("say random()\nexit");
  const malformedPlan = JSON.parse(JSON.stringify(validPlan)) as InstructionPlan & {
    padding: unknown;
  };
  malformedPlan.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH);

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = createFreshRuntimeSnapshot(validPlan);
    const before = JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshot;
    let randomCalls = 0;
    assert.throws(
      () => operation(malformedPlan, snapshot, {
        random: { next: () => { randomCalls += 1; return 0.5; } },
      }),
      (error: unknown) =>
        error instanceof RuntimeDataError &&
        error.code === "TSR100" &&
        error.message === EXTERNAL_DATA_DEPTH_MESSAGE,
    );
    assert.equal(randomCalls, 0);
    assert.deepEqual(snapshot, before);
  }
});

test("runtime entry points reject an over-limit snapshot before execution or RNG use", () => {
  const plan = compiledPlan("say random()\nexit");

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = mutableSnapshot(plan);
    addBinding(snapshot, deepList(65));
    const rngState = snapshot.rng.state;
    const eventSequence = snapshot.nextEventSequence;
    let randomCalls = 0;
    assert.throws(
      () => operation(plan, snapshot, {
        random: { next: () => { randomCalls += 1; return 0.5; } },
      }),
      (error: unknown) =>
        error instanceof RuntimeDataError &&
        error.code === "TSR101" &&
        error.message === EXTERNAL_DATA_DEPTH_MESSAGE,
    );
    assert.equal(randomCalls, 0);
    assert.equal(snapshot.rng.state, rngState);
    assert.equal(snapshot.nextEventSequence, eventSequence);
  }
});

test("serializable cloning accepts the depth boundary and rejects the next level", () => {
  const acceptedDepth = MAX_EXTERNAL_RUNTIME_DATA_DEPTH / 2;
  assert.doesNotThrow(() => cloneSerializableValue(deepList(acceptedDepth)));
  assert.throws(
    () => cloneSerializableValue(deepList(acceptedDepth + 1)),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === EXTERNAL_DATA_DEPTH_MESSAGE,
  );
});

test("host/runtime conversion is bounded before recursive conversion", () => {
  let accepted: RuntimeValue = "leaf";
  for (let depth = 0; depth < MAX_EXTERNAL_RUNTIME_DATA_DEPTH; depth += 1) {
    accepted = { kind: "list", items: [accepted] };
  }
  assert.doesNotThrow(() => fromHostRuntimeValue(accepted));

  const rejected: RuntimeValue = { kind: "list", items: [accepted] };
  assert.throws(
    () => fromHostRuntimeValue(rejected),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.message === EXTERNAL_DATA_DEPTH_MESSAGE,
  );

  assert.throws(
    () => toHostRuntimeValue(deepList(65)),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.message === EXTERNAL_DATA_DEPTH_MESSAGE,
  );
});

test("external capture bounds sparse array length before detailed validation", () => {
  const accepted: unknown[] = [];
  accepted.length = MAX_EXTERNAL_RUNTIME_DATA_WORK;
  const acceptedCapture = captureExternalData(accepted, "$.items");
  assert.equal(acceptedCapture.ok, true);
  if (acceptedCapture.ok) {
    assert.ok(Array.isArray(acceptedCapture.value));
    assert.equal(
      (acceptedCapture.value as unknown[]).length,
      MAX_EXTERNAL_RUNTIME_DATA_WORK,
    );
  }

  const rejected: unknown[] = [];
  rejected.length = MAX_EXTERNAL_RUNTIME_DATA_WORK + 1;
  assert.deepEqual(captureExternalData(rejected, "$.items"), {
    ok: false,
    failure: {
      kind: "work",
      path: "$.items",
    },
  });
});

test("serializable cloning maps huge sparse arrays to the work-limit error", () => {
  const items: SerializableRuntimeValue[] = [];
  items.length = 0xffff_ffff;

  assert.throws(
    () => cloneSerializableValue({ kind: "list", items }),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === EXTERNAL_DATA_WORK_MESSAGE,
  );
});

test("serializable cloning preserves dense and small sparse boundary behavior", () => {
  const acceptedCount = MAX_EXTERNAL_RUNTIME_DATA_WORK - 3;
  const accepted = new Array<SerializableRuntimeValue>(acceptedCount).fill(null);
  const cloned = cloneSerializableValue({ kind: "list", items: accepted });
  assert.equal(typeof cloned === "object" && cloned?.kind === "list", true);
  if (typeof cloned === "object" && cloned?.kind === "list") {
    assert.equal(cloned.items.length, acceptedCount);
  }

  const aboveCaptureBudget = new Array<SerializableRuntimeValue>(
    acceptedCount + 1,
  ).fill(null);
  assert.throws(
    () => cloneSerializableValue({ kind: "list", items: aboveCaptureBudget }),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === EXTERNAL_DATA_WORK_MESSAGE,
  );

  assert.deepEqual(
    cloneSerializableValue({ kind: "list", items: ["a", null, 3] }),
    { kind: "list", items: ["a", null, 3] },
  );

  const smallSparse: SerializableRuntimeValue[] = [];
  smallSparse.length = 2;
  smallSparse[1] = "present";
  assert.throws(
    () => cloneSerializableValue({ kind: "list", items: smallSparse }),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === "$.items[0] is not a JSON-safe runtime value.",
  );
});

test("plan validation rejects sparse instruction length before execution", () => {
  const validPlan = compiledPlan("say random()\nexit");
  const malformedPlan = JSON.parse(JSON.stringify(validPlan)) as InstructionPlan;
  (malformedPlan.instructions as unknown[]).length = 0xffff_ffff;

  assert.deepEqual(validateInstructionPlan(malformedPlan), {
    valid: false,
    errors: [{
      code: "TSC002",
      message: EXTERNAL_DATA_WORK_MESSAGE,
      path: "$.instructions",
    }],
  });

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = createFreshRuntimeSnapshot(validPlan);
    const before = JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshot;
    let randomCalls = 0;
    assert.throws(
      () => operation(malformedPlan, snapshot, {
        random: { next: () => { randomCalls += 1; return 0.5; } },
      }),
      (error: unknown) =>
        error instanceof RuntimeDataError &&
        error.code === "TSR100" &&
        error.message === EXTERNAL_DATA_WORK_MESSAGE,
    );
    assert.equal(randomCalls, 0);
    assert.deepEqual(snapshot, before);
  }
});

test("snapshot and checkpoint paths preserve sparse-array work errors", () => {
  const plan = compiledPlan("say random()\nexit");
  const malformedSnapshot = mutableSnapshot(plan);
  (malformedSnapshot.frames as unknown[]).length = 0xffff_ffff;

  assert.deepEqual(validateRuntimeSnapshot(malformedSnapshot, plan), {
    valid: false,
    errors: [EXTERNAL_DATA_WORK_MESSAGE],
  });

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = mutableSnapshot(plan);
    (snapshot.frames as unknown[]).length = 0xffff_ffff;
    const rngState = snapshot.rng.state;
    const eventSequence = snapshot.nextEventSequence;
    let randomCalls = 0;
    assert.throws(
      () => operation(plan, snapshot, {
        random: { next: () => { randomCalls += 1; return 0.5; } },
      }),
      (error: unknown) =>
        error instanceof RuntimeDataError &&
        error.code === "TSR101" &&
        error.message === EXTERNAL_DATA_WORK_MESSAGE,
    );
    assert.equal(randomCalls, 0);
    assert.equal(snapshot.rng.state, rngState);
    assert.equal(snapshot.nextEventSequence, eventSequence);
  }

  const malformedCheckpoint = checkpoint(
    plan,
    createFreshRuntimeSnapshot(plan),
  );
  (malformedCheckpoint.snapshot.frames as unknown[]).length = 0xffff_ffff;
  assertCheckpointError(
    () => restoreCheckpoint(malformedCheckpoint),
    EXTERNAL_DATA_WORK_MESSAGE,
    "$.snapshot",
  );
});

test("cycles, non-plain objects, non-finite numbers, and malformed kinds remain rejected", () => {
  const cyclicPlan = mutablePlan();
  cyclicPlan.self = cyclicPlan;
  assert.deepEqual(validateInstructionPlan(cyclicPlan).errors[0], {
    code: "TSC002",
    message: "Plan contains a cycle.",
    path: "$.self",
  });

  const nonPlainPlan = mutablePlan();
  nonPlainPlan.padding = new Date(0);
  assert.equal(
    validateInstructionPlan(nonPlainPlan).errors[0]?.message,
    "Plan contains a non-plain object.",
  );

  const nonFinitePlan = mutablePlan();
  nonFinitePlan.padding = Number.POSITIVE_INFINITY;
  assert.equal(
    validateInstructionPlan(nonFinitePlan).errors[0]?.message,
    "Plan contains a non-finite number.",
  );

  const cyclicValue = { kind: "list", items: [] } as unknown as {
    kind: "list";
    items: SerializableRuntimeValue[];
  };
  cyclicValue.items.push(cyclicValue);
  assert.throws(
    () => cloneSerializableValue(cyclicValue),
    (error: unknown) =>
      error instanceof SerializableValueError && error.code === "cyclic",
  );

  assert.throws(
    () => cloneSerializableValue({ kind: "unknown" } as never),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === "$.kind is unsupported.",
  );
});
