import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
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
import { captureInstructionPlan } from "../src/plan/capture.js";
import { serializeCapturedCheckpoint } from "../src/runtime/checkpoint.js";
import { captureExecutableData } from "../src/runtime/operations/support.js";
import { SerializableValueError } from "../src/runtime/serializable-values.js";
import { captureRuntimeSnapshotWithValidatedPlan } from "../src/runtime/state.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";

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

function proxyArray(
  length: number,
  keys: readonly string[],
  values: Readonly<Record<string, unknown>> = {},
): unknown[] {
  return new Proxy([], {
    ownKeys() {
      return keys;
    },
    getOwnPropertyDescriptor(_target, key) {
      if (key === "length") {
        return {
          value: length,
          writable: true,
          enumerable: false,
          configurable: false,
        };
      }
      if (typeof key === "string" && key in values) {
        return {
          value: values[key],
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return undefined;
    },
    get() {
      throw new Error("capture must not invoke array getters");
    },
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

test("plan validation measures deep and broad data without rejecting arbitrary work or depth", () => {
  const value = mutablePlan();
  value.deepPadding = deepArray(1_000);
  value.broadPadding = new Array(100_001).fill(0);

  const statistics = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(value).valid, true);
    return finish();
  }).counts;

  assert.ok((statistics.externalCaptureVisits ?? 0) > 100_000);
  assert.ok((statistics.externalCaptureMaximumDepth ?? 0) > 1_000);
});

test("compiler and runtime paths avoid duplicate whole-plan capture", () => {
  const source = Array.from({ length: 100 }, (_, index) => `say "Line ${index}"`).join("\n");
  const compileStatistics = withValidationTestStatistics((finish) => {
    assert.notEqual(compileSource(source).plan, null);
    return finish();
  }).counts;
  assert.equal(compileStatistics.externalCaptureVisits, undefined);

  const plan = compiledPlan(source);
  const snapshot = createFreshRuntimeSnapshot(plan);
  const planVisits = withValidationTestStatistics((finish) => {
    assert.notEqual(captureInstructionPlan(plan).plan, null);
    return finish();
  }).counts.externalCaptureVisits!;
  const snapshotVisits = withValidationTestStatistics((finish) => {
    assert.notEqual(captureRuntimeSnapshotWithValidatedPlan(snapshot, plan).snapshot, null);
    return finish();
  }).counts.externalCaptureVisits!;
  const executableVisits = withValidationTestStatistics((finish) => {
    captureExecutableData(plan, snapshot);
    return finish();
  }).counts.externalCaptureVisits!;
  assert.equal(executableVisits, planVisits + snapshotVisits);

  const checkpointVisits = withValidationTestStatistics((finish) => {
    createCheckpoint(plan, snapshot);
    return finish();
  }).counts.externalCaptureVisits!;
  assert.equal(checkpointVisits, planVisits + snapshotVisits);

  const serialized = JSON.stringify(createCheckpoint(plan, snapshot));
  const deserializeStatistics = withValidationTestStatistics((finish) => {
    deserializeCheckpoint(serialized);
    return finish();
  }).counts;
  assert.equal(deserializeStatistics.externalCaptureVisits, undefined);

  const capturedCheckpoint = createCheckpoint(plan, snapshot);
  const serializationStatistics = withValidationTestStatistics((finish) => {
    serializeCapturedCheckpoint(capturedCheckpoint);
    return finish();
  }).counts;
  assert.equal(serializationStatistics.externalCaptureVisits, undefined);
});

test("ordinary source compiles beyond the removed generic capture threshold", () => {
  const count = 5_000;
  const source = Array.from({ length: count }, (_, index) => `say "Line ${index}"`).join("\n");
  const compiled = compileSource(source);

  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  assert.equal(compiled.plan!.instructions.length, count);
  assert.equal(Object.isFrozen(compiled.plan), true);
});

test("snapshot validation accepts deeply nested serializable values", () => {
  const plan = compiledPlan();
  const snapshot = mutableSnapshot(plan);
  addBinding(snapshot, deepList(512));
  (snapshot.speakers as unknown as Array<Record<string, unknown>>).push({
    id: 1,
    identifier: "mistress",
    properties: [{ name: "profile", value: deepSerializableObject(256) }],
  });
  snapshot.nextSpeakerId = 2;

  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
});

test("snapshot validation accepts a deeply nested supplied call argument", () => {
  const plan = compiledPlan("function echo(value) { return value }\necho(1)\nexit");
  const snapshot = activeCallSnapshot(plan);
  const argument = snapshot.callFrames[0]!.arguments[0];
  assert.ok(argument?.supplied);
  (argument as { value: SerializableRuntimeValue }).value = deepList(512);
  snapshot.callFrames[0]!.callerTemporaries[0]!.value = deepList(512);

  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
});

test("checkpoint restore and JSON deserialize preserve deep valid data", () => {
  const plan = compiledPlan();
  const value = checkpoint(plan, createFreshRuntimeSnapshot(plan)) as RuntimeCheckpoint & {
    plan: Record<string, unknown>;
  };
  value.plan.padding = deepArray(512);
  addBinding(value.snapshot, deepList(512));
  const restored = restoreCheckpoint(value);
  assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);
  const deserialized = deserializeCheckpoint(JSON.stringify(restored));
  assert.equal(validateRuntimeSnapshot(deserialized.snapshot, deserialized.plan).valid, true);
});

test("runtime entry points accept valid deep plan and snapshot data without mutating the caller", () => {
  const validPlan = compiledPlan("exit");
  const extendedPlan = JSON.parse(JSON.stringify(validPlan)) as InstructionPlan & {
    padding: unknown;
  };
  extendedPlan.padding = deepObject(512);

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = mutableSnapshot(validPlan);
    addBinding(snapshot, deepList(512));
    const before = JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshot;
    assert.doesNotThrow(() => operation(extendedPlan, snapshot));
    assert.deepEqual(snapshot, before);
  }
});

test("serializable cloning is stack-independent beyond the removed depth threshold", () => {
  assert.doesNotThrow(() => cloneSerializableValue(deepList(FAILING_BEFORE_DEPTH)));
});

test("external capture rejects sparse arrays as non-canonical regardless of length", () => {
  for (const length of [1, 100_001, 0xffff_ffff]) {
    const sparse: unknown[] = [];
    sparse.length = length;
    assert.deepEqual(captureExternalData(sparse, "$.items"), {
      ok: false,
      failure: { kind: "nonJsonSafeValue", path: "$.items" },
    });
  }
});

test("external capture measures broad descriptor work without rejecting it", () => {
  const broad = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < 100_001; index += 1) {
    Object.defineProperty(broad, `hidden${index}`, {
      value: null,
      enumerable: false,
      configurable: true,
    });
  }
  const statistics = withValidationTestStatistics((finish) => {
    const captured = captureExternalData(broad);
    assert.equal(captured.ok, true);
    return finish();
  }).counts;
  assert.equal(statistics.externalCaptureDescriptors, 100_001);

  const dense = new Array(100_001).fill(null);
  assert.deepEqual(captureExternalData(dense).ok, true);
});

test("external capture rejects non-canonical proxy arrays before indexed traversal", () => {
  assert.deepEqual(captureExternalData(proxyArray(2, ["1", "length"], { "1": "present" })), {
    ok: false,
    failure: { kind: "nonJsonSafeValue", path: "$" },
  });
});

test("external capture rejects proxy indexes that conflict with validated array length", () => {
  for (const keys of [["length", "4294967294"], ["4294967294", "length"]]) {
    assert.deepEqual(captureExternalData(proxyArray(0, keys, { "4294967294": 1 })), {
      ok: false,
      failure: { kind: "nonJsonSafeValue", path: "$" },
    });
  }

  for (const key of ["0", "1", "4294967295", "01", "1.0"]) {
    assert.equal(
      captureExternalData(proxyArray(0, ["length", key], { [key]: 1 })).ok,
      false,
      `Expected ${key} to be rejected.`,
    );
  }

  assert.equal(
    captureExternalData(proxyArray(2, ["1", "length"], { "1": "present" })).ok,
    false,
  );
});

test("external capture rejects malformed proxy length descriptors without invoking getters", () => {
  for (const getOwnPropertyDescriptor of [
    () => undefined,
    () => ({ get: () => 0, enumerable: false, configurable: false }),
    () => { throw new Error("raw descriptor failure"); },
  ]) {
    const hostile = new Proxy([], { getOwnPropertyDescriptor });
    assert.deepEqual(captureExternalData(hostile), {
      ok: false,
      failure: { kind: "nonJsonSafeValue", path: "$" },
    });
  }
});

test("proxy array length inflation is structured at plan, snapshot, checkpoint, and serializable boundaries", () => {
  const hostile = () => proxyArray(0, ["length", "4294967294"], { "4294967294": null });

  const malformedPlan = mutablePlan();
  malformedPlan.instructions = hostile();
  assert.deepEqual(validateInstructionPlan(malformedPlan), {
    valid: false,
    errors: [{
      code: "TSC002",
      message: "Plan contains a non-JSON-safe value.",
      path: "$.instructions",
    }],
  });

  const plan = compiledPlan();
  const malformedSnapshot = mutableSnapshot(plan);
  (malformedSnapshot as { frames: unknown }).frames = hostile();
  assert.deepEqual(validateRuntimeSnapshot(malformedSnapshot, plan), {
    valid: false,
    errors: ["Runtime snapshot contains a non-JSON-safe value."],
  });

  const malformedCheckpoint = checkpoint(plan, createFreshRuntimeSnapshot(plan));
  (malformedCheckpoint.snapshot as { frames: unknown }).frames = hostile();
  assertCheckpointError(
    () => restoreCheckpoint(malformedCheckpoint),
    "Checkpoint contains a non-JSON-safe value.",
    "$.snapshot",
  );

  assert.throws(
    () => cloneSerializableValue({ kind: "list", items: hostile() } as never),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === "$.items is not a JSON-safe runtime value.",
  );
});

test("serializable cloning rejects huge sparse arrays as non-canonical", () => {
  const items: SerializableRuntimeValue[] = [];
  items.length = 0xffff_ffff;

  assert.throws(
    () => cloneSerializableValue({ kind: "list", items }),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === "$.items is not a JSON-safe runtime value.",
  );
});

test("serializable cloning accepts broad dense arrays and rejects sparse arrays", () => {
  const acceptedCount = 100_001;
  const accepted = new Array<SerializableRuntimeValue>(acceptedCount).fill(null);
  const cloned = cloneSerializableValue({ kind: "list", items: accepted });
  assert.equal(typeof cloned === "object" && cloned?.kind === "list", true);
  if (typeof cloned === "object" && cloned?.kind === "list") {
    assert.equal(cloned.items.length, acceptedCount);
  }

  const extended = new Array<SerializableRuntimeValue>(
    acceptedCount + 1,
  ).fill(null);
  assert.equal(
    (cloneSerializableValue({ kind: "list", items: extended }) as { items: unknown[] }).items.length,
    extended.length,
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
      error.message === "$.items is not a JSON-safe runtime value.",
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
      message: "Plan contains a non-JSON-safe value.",
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
        error.message === "Plan contains a non-JSON-safe value.",
    );
    assert.equal(randomCalls, 0);
    assert.deepEqual(snapshot, before);
  }
});

test("snapshot and checkpoint paths reject sparse arrays as malformed data", () => {
  const plan = compiledPlan("say random()\nexit");
  const malformedSnapshot = mutableSnapshot(plan);
  (malformedSnapshot.frames as unknown[]).length = 0xffff_ffff;

  assert.deepEqual(validateRuntimeSnapshot(malformedSnapshot, plan), {
    valid: false,
    errors: ["Runtime snapshot contains a non-JSON-safe value."],
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
        error.message === "Runtime snapshot contains a non-JSON-safe value.",
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
    "Checkpoint contains a non-JSON-safe value.",
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
