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
import { captureExternalData } from "../src/external-data-capture.js";
import { captureInstructionPlan } from "../src/plan/capture.js";
import { capturePlanData } from "../src/plan/capture-support.js";
import { captureExecutableData } from "../src/runtime/operations/support.js";
import { SerializableValueError } from "../src/runtime/serializable-values.js";
import { captureRuntimeSnapshotWithValidatedPlan } from "../src/runtime/state.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

const FAILING_BEFORE_DEPTH = 20_000;

function compiledPlan(source = "exit"): InstructionPlan {
  return compileValidPlan(source);
}

function mutablePlan(source = "exit"): InstructionPlan & Record<string, unknown> {
  // EVIDENCE: JSON round-trips a compiler-produced plan before fixtures add or replace external fields.
  return JSON.parse(JSON.stringify(compiledPlan(source))) as InstructionPlan &
    Record<string, unknown>;
}

function mutableSnapshot(plan: InstructionPlan): RuntimeSnapshot {
  // EVIDENCE: JSON round-trips the runtime-produced snapshot before boundary-focused fixture mutations.
  return JSON.parse(JSON.stringify(createFreshRuntimeSnapshot(plan))) as RuntimeSnapshot;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: fixture helper returns deliberately unvalidated external data for the validation boundary under test.
function deepArray(depth: number): unknown {
  return JSON.parse(`${"[".repeat(depth)}0${"]".repeat(depth)}`);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: fixture helper returns deliberately unvalidated external data for the validation boundary under test.
function deepObject(depth: number): unknown {
  return JSON.parse(`${'{"value":'.repeat(depth)}0${"}".repeat(depth)}`);
}

function deepListJson(depth: number, leaf = '"leaf"'): string {
  return `${'{"kind":"list","items":['.repeat(depth)}${leaf}${"]}".repeat(depth)}`;
}

function deepList(depth: number): SerializableRuntimeValue {
  // EVIDENCE: deepListJson constructs only nested canonical list envelopes with a string leaf.
  return JSON.parse(deepListJson(depth)) as SerializableRuntimeValue;
}

function deepSerializableObject(depth: number): SerializableRuntimeValue {
  // EVIDENCE: this JSON template constructs nested canonical object properties with a string leaf.
  return JSON.parse(
    `${'{"kind":"object","properties":[{"name":"value","value":'.repeat(depth)}` +
      `"leaf"${"}]}".repeat(depth)}`,
  ) as SerializableRuntimeValue;
}

function addBinding(snapshot: RuntimeSnapshot, value: unknown): void {
  // EVIDENCE: fixture insertion intentionally admits unvalidated values at the snapshot-validation boundary.
  (snapshot.frames[0]!.bindings as Array<{ name: string; value: unknown }>).push({
    name: "deep",
    value,
  });
}

function checkpoint(plan: InstructionPlan, snapshot: RuntimeSnapshot): RuntimeCheckpoint {
  // EVIDENCE: JSON round-trips a checkpoint created from the supplied validated plan and snapshot.
  return JSON.parse(JSON.stringify(createCheckpoint(plan, snapshot))) as RuntimeCheckpoint;
}

function assertCheckpointError(operation: () => void, message: string, path?: string): void {
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
        return { value: length, writable: true, enumerable: false, configurable: false };
      }
      if (typeof key === "string" && key in values) {
        return { value: values[key], writable: true, enumerable: true, configurable: true };
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
  // EVIDENCE: JSON round-trips the runtime-produced active-call snapshot selected by the loop above.
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
  }).counts;
  assert.equal(executableVisits.instructionPlanCaptureCalls, undefined);
  assert.ok((executableVisits.externalCaptureVisits ?? 0) < planVisits + snapshotVisits);

  const checkpointVisits = withValidationTestStatistics((finish) => {
    createCheckpoint(plan, snapshot);
    return finish();
  }).counts;
  assert.equal(checkpointVisits.instructionPlanCaptureCalls, undefined);
  assert.ok((checkpointVisits.externalCaptureVisits ?? 0) < planVisits + snapshotVisits);

  const serialized = JSON.stringify(createCheckpoint(plan, snapshot));
  const deserializeStatistics = withValidationTestStatistics((finish) => {
    deserializeCheckpoint(serialized);
    return finish();
  }).counts;
  assert.equal(deserializeStatistics.externalCaptureVisits, undefined);

  const capturedCheckpoint = createCheckpoint(plan, snapshot);
  const serializationStatistics = withValidationTestStatistics((finish) => {
    JSON.stringify(capturedCheckpoint);
    return finish();
  }).counts;
  assert.equal(serializationStatistics.externalCaptureVisits, undefined);
});

test("repeated event stepping reuses validated immutable plans and preserves restore behavior", () => {
  const statementCount = 64;
  const source = Array.from(
    { length: statementCount },
    (_, index) => `say "Line ${index}", instant`,
  ).join("\n");
  const plan = compiledPlan(source);
  const uninterrupted = run(plan, createFreshRuntimeSnapshot(plan));
  const wholePlanCaptureVisits = withValidationTestStatistics((finish) => {
    assert.notEqual(captureInstructionPlan(plan).plan, null);
    return finish();
  }).counts.externalCaptureVisits!;
  let snapshot = createFreshRuntimeSnapshot(plan);
  const events: (typeof uninterrupted.events)[number][] = [];
  let calls = 0;

  const statistics = withValidationTestStatistics((finish) => {
    while (snapshot.status !== "halted") {
      const callerBefore = structuredClone(snapshot);
      const stepped = stepToEvent(plan, snapshot);
      assert.deepEqual(snapshot, callerBefore);
      events.push(...stepped.events);
      calls += 1;
      snapshot = stepped.snapshot;
    }
    return finish();
  }).counts;

  assert.equal(calls, statementCount);
  assert.equal(statistics.instructionPlanCaptureCalls, undefined);
  assert.equal(statistics.runtimeSnapshotCaptureCalls, statementCount);
  assert.ok((statistics.externalCaptureVisits ?? 0) < wholePlanCaptureVisits * 2);
  assert.deepEqual(events, uninterrupted.events);
  assert.deepEqual(snapshot, uninterrupted.snapshot);

  let restoredPlan = plan;
  let restoredSnapshot = createFreshRuntimeSnapshot(plan);
  const restoredEvents: (typeof uninterrupted.events)[number][] = [];
  while (restoredSnapshot.status !== "halted") {
    const stepped = stepToEvent(restoredPlan, restoredSnapshot);
    restoredEvents.push(...stepped.events);
    const restored = deserializeCheckpoint(
      JSON.stringify(createCheckpoint(restoredPlan, stepped.snapshot)),
    );
    restoredPlan = restored.plan;
    restoredSnapshot = restored.snapshot;
  }
  assert.deepEqual(restoredEvents, uninterrupted.events);
  assert.deepEqual(restoredSnapshot, uninterrupted.snapshot);
});

test("runtime entry validates mutable external plans and snapshots before halted or failed returns", () => {
  const exitPlan = compiledPlan("exit");
  const halted = run(exitPlan, createFreshRuntimeSnapshot(exitPlan)).snapshot;
  const faultSource = "let values = []\nsay values.first\nexit";
  const faultPlan = compiledPlan(faultSource);
  const failed = run(faultPlan, createFreshRuntimeSnapshot(faultPlan)).snapshot;

  for (const terminal of [
    { source: "exit", plan: exitPlan, snapshot: halted },
    { source: faultSource, plan: faultPlan, snapshot: failed },
  ]) {
    for (const operation of [executeInstruction, stepToEvent, run]) {
      const malformedPlan = mutablePlan(terminal.source);
      // EVIDENCE: this external plan has not passed the private immutable-plan validation seam.
      (malformedPlan as { version: number }).version += 1;
      assert.throws(
        () => operation(malformedPlan, terminal.snapshot),
        (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
      );

      const malformedSnapshot = structuredClone(terminal.snapshot);
      // EVIDENCE: terminal status cannot bypass validation of caller-controlled snapshot fields.
      (malformedSnapshot as { nextEventSequence: number }).nextEventSequence = 0;
      assert.throws(
        () => operation(terminal.plan, malformedSnapshot),
        (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
      );
    }
  }
});

test("a shallow-frozen external plan is recaptured after nested mutation", () => {
  const plan = mutablePlan("exit");
  Object.freeze(plan);
  const initial = createFreshRuntimeSnapshot(compiledPlan("exit"));
  assert.equal(run(plan, initial).snapshot.status, "halted");

  // EVIDENCE: freezing only the root does not make the caller-owned nested instruction graph immutable.
  (plan.instructions[0] as { kind: string }).kind = "unknown";
  assert.throws(
    () => run(plan, initial),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
  );
});

test("external plan capture freezes the detached graph without freezing generic capture", () => {
  const plan = mutablePlan("let value = [1, { nested: 2 }]\nexit");
  const captured = captureInstructionPlan(plan);
  assert.ok(captured.validation.valid);
  assert.notEqual(captured.plan, null);

  const capturedPlan = captured.plan!;
  const capturedInstruction = capturedPlan.instructions[0]!;
  const capturedSpan = capturedInstruction.span;
  assert.equal(Object.isFrozen(captured.plan), true);
  assert.equal(Object.isFrozen(capturedPlan.instructions), true);
  assert.equal(Object.isFrozen(capturedInstruction), true);
  assert.equal(Object.isFrozen(capturedSpan), true);

  // EVIDENCE: mutablePlan returns a detached fixture whose instruction spans are intentionally mutable.
  const originalInstruction = plan.instructions[0] as { span: { so: number } };
  originalInstruction.span.so = 3;
  assert.notEqual(capturedSpan.so, 3);

  const generic = captureExternalData({ nested: [1, { value: 2 }] });
  assert.equal(generic.ok, true);
  // EVIDENCE: successful capture preserves the supplied numeric/object tuple and its numeric `value` field.
  const genericValue = generic.value as { nested: [number, { value: number }] };
  assert.equal(Object.isFrozen(genericValue), false);
  assert.equal(Object.isFrozen(genericValue.nested), false);
  assert.equal(Object.isFrozen(genericValue.nested[1]!), false);
});

test("validation-only plan capture remains mutable while returned plan capture freezes", () => {
  const plan = mutablePlan('say "ready"');
  const validationCapture = capturePlanData(plan);
  assert.ok("value" in validationCapture);
  // EVIDENCE: capturePlanData succeeded for the compiler-produced plan and retains instruction spans.
  const validationPlan = validationCapture.value as { instructions: Array<{ span: object }> };
  assert.notEqual(validationPlan, plan);
  assert.equal(Object.isFrozen(validationPlan), false);
  assert.equal(Object.isFrozen(validationPlan.instructions), false);
  assert.equal(Object.isFrozen(validationPlan.instructions[0]!), false);
  assert.equal(Object.isFrozen(validationPlan.instructions[0]!.span), false);

  const returnedCapture = captureInstructionPlan(plan);
  assert.ok(returnedCapture.validation.valid);
  assert.notEqual(returnedCapture.plan, null);
  assert.equal(Object.isFrozen(returnedCapture.plan), true);
  assert.equal(Object.isFrozen(returnedCapture.plan!.instructions), true);
  assert.equal(Object.isFrozen(returnedCapture.plan!.instructions[0]!), true);
  assert.equal(Object.isFrozen(returnedCapture.plan!.instructions[0]!.span), true);
});

test("runtime snapshot capture remains mutable after plan capture freezes on leave", () => {
  const plan = compiledPlan();
  const snapshot = captureRuntimeSnapshotWithValidatedPlan(mutableSnapshot(plan), plan);
  assert.notEqual(snapshot.snapshot, null);
  assert.equal(Object.isFrozen(snapshot.snapshot), false);
  assert.equal(Object.isFrozen(snapshot.snapshot!.frames), false);
  snapshot.snapshot!.nextInstruction = 1;
  assert.equal(snapshot.snapshot!.nextInstruction, 1);
});

test("parsed checkpoint plans retain the independent freeze path", () => {
  const plan = compiledPlan('say "ready"');
  const restored = deserializeCheckpoint(
    JSON.stringify(createCheckpoint(plan, createFreshRuntimeSnapshot(plan))),
  );
  assert.equal(Object.isFrozen(restored.plan), true);
  assert.equal(Object.isFrozen(restored.plan.instructions), true);
  assert.equal(Object.isFrozen(restored.plan.instructions[0]!), true);
  assert.equal(Object.isFrozen(restored.plan.instructions[0]!.span), true);
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
  addBinding(snapshot, deepList(5_000));
  snapshot.speakers.push({
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
  // EVIDENCE: the supplied call argument is intentionally replaced with a valid deeply nested runtime value.
  (argument as { value: SerializableRuntimeValue }).value = deepList(5_000);

  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
});

test("checkpoint restore and JSON deserialize preserve deeply nested valid state", () => {
  const plan = compiledPlan();
  // EVIDENCE: the runtime-created checkpoint is extended only with an extra plan field accepted by validation.
  const live = checkpoint(plan, createFreshRuntimeSnapshot(plan)) as RuntimeCheckpoint & {
    plan: Record<string, unknown>;
  };
  live.plan.padding = deepArray(512);
  addBinding(live.snapshot, deepList(5_000));
  const restored = restoreCheckpoint(live);
  assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);

  const serializedSnapshot = mutableSnapshot(plan);
  addBinding(serializedSnapshot, "__DEEP_VALUE__");
  const json = JSON.stringify(createCheckpoint(plan, serializedSnapshot)).replace(
    '"__DEEP_VALUE__"',
    deepListJson(5_000),
  );
  const deserialized = deserializeCheckpoint(json);
  assert.equal(validateRuntimeSnapshot(deserialized.snapshot, deserialized.plan).valid, true);
});

test("runtime entry points accept valid deep plan and snapshot data without mutating the caller", () => {
  const validPlan = compiledPlan("exit");
  // EVIDENCE: JSON preserves the compiler-produced plan before this accepted padding field is added.
  const extendedPlan = JSON.parse(JSON.stringify(validPlan)) as InstructionPlan & {
    padding: unknown;
  };
  extendedPlan.padding = deepObject(512);

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = mutableSnapshot(validPlan);
    addBinding(snapshot, deepList(512));
    const before = structuredClone(snapshot);
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
  // EVIDENCE: Object.create(null) yields the key-only container whose many non-enumerable descriptors are measured.
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
  for (const keys of [
    ["length", "4294967294"],
    ["4294967294", "length"],
  ]) {
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

  assert.equal(captureExternalData(proxyArray(2, ["1", "length"], { "1": "present" })).ok, false);
});

test("external capture rejects malformed proxy length descriptors without invoking getters", () => {
  for (const getOwnPropertyDescriptor of [
    () => undefined,
    () => ({ get: () => 0, enumerable: false, configurable: false }),
    () => {
      throw new Error("raw descriptor failure");
    },
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
  // EVIDENCE: fixture replaces the instruction list with a hostile proxy array at the validation boundary.
  (malformedPlan as { instructions: unknown }).instructions = hostile();
  assert.deepEqual(validateInstructionPlan(malformedPlan), {
    valid: false,
    errors: [
      { code: "TSC002", message: "Plan contains a non-JSON-safe value.", path: "$.instructions" },
    ],
  });

  const plan = compiledPlan();
  const malformedSnapshot = mutableSnapshot(plan);
  // EVIDENCE: fixture widens only `frames` to inject a proxy array with an impossible length/index combination.
  (malformedSnapshot as { frames: unknown }).frames = hostile();
  assert.deepEqual(validateRuntimeSnapshot(malformedSnapshot, plan), {
    valid: false,
    errors: ["Runtime snapshot contains a non-JSON-safe value."],
  });

  const malformedCheckpoint = checkpoint(plan, createFreshRuntimeSnapshot(plan));
  // EVIDENCE: fixture widens only checkpoint `frames` to inject the hostile proxy array under validation.
  (malformedCheckpoint.snapshot as { frames: unknown }).frames = hostile();
  assertCheckpointError(
    () => restoreCheckpoint(malformedCheckpoint),
    "Checkpoint contains a non-JSON-safe value.",
    "$.snapshot",
  );

  assert.throws(
    () => {
      // EVIDENCE: the hostile proxy array deliberately violates the serializable list's dense-array invariant.
      return cloneSerializableValue({ kind: "list", items: hostile() } as never);
    },
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

  const extended = new Array<SerializableRuntimeValue>(acceptedCount + 1).fill(null);
  const extendedClone = cloneSerializableValue({ kind: "list", items: extended });
  assert.ok(typeof extendedClone === "object" && extendedClone?.kind === "list");
  assert.equal(extendedClone.items.length, extended.length);

  assert.deepEqual(cloneSerializableValue({ kind: "list", items: ["a", null, 3] }), {
    kind: "list",
    items: ["a", null, 3],
  });

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
  // EVIDENCE: JSON preserves the compiler-produced plan before its instruction array length is made sparse.
  const malformedPlan = JSON.parse(JSON.stringify(validPlan)) as InstructionPlan;
  // EVIDENCE: fixture mutates only the instruction-array length to create a sparse external plan.
  (malformedPlan.instructions as { length: number }).length = 0xffff_ffff;

  assert.deepEqual(validateInstructionPlan(malformedPlan), {
    valid: false,
    errors: [
      { code: "TSC002", message: "Plan contains a non-JSON-safe value.", path: "$.instructions" },
    ],
  });

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = createFreshRuntimeSnapshot(validPlan);
    const before = structuredClone(snapshot);
    let randomCalls = 0;
    assert.throws(
      () =>
        operation(malformedPlan, snapshot, {
          random: {
            next: () => {
              randomCalls += 1;
              return 0.5;
            },
          },
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
  malformedSnapshot.frames.length = 0xffff_ffff;

  assert.deepEqual(validateRuntimeSnapshot(malformedSnapshot, plan), {
    valid: false,
    errors: ["Runtime snapshot contains a non-JSON-safe value."],
  });

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = mutableSnapshot(plan);
    snapshot.frames.length = 0xffff_ffff;
    const rngState = snapshot.rng.state;
    const eventSequence = snapshot.nextEventSequence;
    let randomCalls = 0;
    assert.throws(
      () =>
        operation(plan, snapshot, {
          random: {
            next: () => {
              randomCalls += 1;
              return 0.5;
            },
          },
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

  const malformedCheckpoint = checkpoint(plan, createFreshRuntimeSnapshot(plan));
  malformedCheckpoint.snapshot.frames.length = 0xffff_ffff;
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

  const cyclicValue: { kind: "list"; items: SerializableRuntimeValue[] } = {
    kind: "list",
    items: [],
  };
  cyclicValue.items.push(cyclicValue);
  assert.throws(
    () => cloneSerializableValue(cyclicValue),
    (error: unknown) => error instanceof SerializableValueError && error.code === "cyclic",
  );

  assert.throws(
    () => {
      // EVIDENCE: unsupported `kind` is intentionally presented as a serializable value for rejection.
      return cloneSerializableValue({ kind: "unknown" } as never);
    },
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === "$.kind is unsupported.",
  );
});
