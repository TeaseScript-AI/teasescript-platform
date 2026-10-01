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

function assertCheckpointError(operation: () => void, path: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CheckpointError);
    assert.deepEqual({ code: error.info.code, path: error.info.path }, { code: "TSK002", path });
    return true;
  });
}

function assertPlanErrorAt(value: unknown, path: string): void {
  const validation = validateInstructionPlan(value);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => error.code === "TSC002" && error.path === path),
    `plan reports TSC002 at ${path}`,
  );
}

function isInvalidSerializableValueAt(path: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof SerializableValueError &&
    error.code === "invalid" &&
    error.message.startsWith(`${path} `);
}

interface ProxyArrayReads {
  gets: number;
  indexDescriptors: number;
  lengthDescriptors: number;
}

function zeroProxyArrayReads(): ProxyArrayReads {
  return { gets: 0, indexDescriptors: 0, lengthDescriptors: 0 };
}

function proxyArray(
  length: number,
  keys: readonly string[],
  values: Readonly<Record<string, unknown>> = {},
  reads: ProxyArrayReads = zeroProxyArrayReads(),
): unknown[] {
  return new Proxy([], {
    ownKeys() {
      return keys;
    },
    getOwnPropertyDescriptor(_target, key) {
      if (key === "length") {
        reads.lengthDescriptors += 1;
        return { value: length, writable: true, enumerable: false, configurable: false };
      }
      reads.indexDescriptors += 1;
      if (typeof key === "string" && key in values) {
        return { value: values[key], writable: true, enumerable: true, configurable: true };
      }
      return undefined;
    },
    get() {
      reads.gets += 1;
      throw new Error("capture must not invoke array getters");
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Iteratively follows nested singleton lists, returning the nesting depth and innermost list/value. */
function listChain(value: unknown): {
  depth: number;
  innermost: { items: unknown[] } | null;
  leaf: unknown;
} {
  let depth = 0;
  let innermost: { items: unknown[] } | null = null;
  let current = value;
  while (isRecord(current) && current.kind === "list") {
    const items = current.items;
    assert.ok(Array.isArray(items) && items.length === 1, `list level ${depth} has one item`);
    innermost = { items };
    current = items[0];
    depth += 1;
  }
  return { depth, innermost, leaf: current };
}

/** Iteratively follows nested singleton arrays or `value` objects, returning depth and innermost data. */
function containerChain(value: unknown): {
  depth: number;
  innermost: Record<string, unknown> | unknown[] | null;
  leaf: unknown;
} {
  let depth = 0;
  let innermost: Record<string, unknown> | unknown[] | null = null;
  let current = value;
  for (;;) {
    if (Array.isArray(current)) {
      assert.equal(current.length, 1, `array level ${depth} has one item`);
      innermost = current;
      current = current[0];
    } else if (isRecord(current)) {
      assert.deepEqual(Object.keys(current), ["value"], `object level ${depth} has one field`);
      innermost = current;
      current = current.value;
    } else {
      return { depth, innermost, leaf: current };
    }
    depth += 1;
  }
}

function assertSteppedOrHalted(snapshot: RuntimeSnapshot): void {
  assert.ok(
    snapshot.status === "running" || snapshot.status === "halted",
    `unexpected ${snapshot.status} snapshot while stepping instant says`,
  );
}

/**
 * Bounded caller-state view: own descriptors of every snapshot field and of the sparse frames
 * array (its length and own entries), without iterating the sparse length.
 */
function sparseSnapshotState(snapshot: RuntimeSnapshot) {
  const ownDescriptors = (value: RuntimeSnapshot | readonly unknown[], skip?: string) =>
    Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([key]) => key !== skip)
      .map(([key, descriptor]) => [
        key,
        { ...descriptor, value: structuredClone(descriptor.value) },
      ]);
  return { fields: ownDescriptors(snapshot, "frames"), frames: ownDescriptors(snapshot.frames) };
}

function deepBindingValue(snapshot: RuntimeSnapshot): SerializableRuntimeValue | undefined {
  return snapshot.frames[0]!.bindings.find((binding) => binding.name === "deep")?.value;
}

/** Removes the fixture's deep binding so the remaining state can be compared without deep recursion. */
function withoutDeepBinding(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    ...snapshot,
    frames: snapshot.frames.map((frame) => ({
      ...frame,
      bindings: frame.bindings.filter((binding) => binding.name !== "deep"),
    })),
  };
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

  // One event per instant say, plus a small terminal allowance, bounds both stepping loops.
  const stepLimit = statementCount + 2;
  const statistics = withValidationTestStatistics((finish) => {
    while (snapshot.status !== "halted") {
      assert.ok(calls < stepLimit, "event stepping exceeded the expected event count");
      const callerBefore = structuredClone(snapshot);
      const stepped = stepToEvent(plan, snapshot);
      assert.deepEqual(snapshot, callerBefore);
      assertSteppedOrHalted(stepped.snapshot);
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
  for (let restoredCalls = 0; restoredSnapshot.status !== "halted"; restoredCalls += 1) {
    assert.ok(restoredCalls < stepLimit, "restored stepping exceeded the expected event count");
    const stepped = stepToEvent(restoredPlan, restoredSnapshot);
    assertSteppedOrHalted(stepped.snapshot);
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

test("external plan capture freezes the detached graph", () => {
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
  // EVIDENCE: the restored plan is validated external plan data that retains the accepted padding field.
  const { padding, ...restoredPlanFields } = restored.plan as InstructionPlan & {
    padding?: unknown;
  };
  assert.deepEqual(restoredPlanFields, plan);
  const restoredPadding = containerChain(padding);
  assert.deepEqual([restoredPadding.depth, restoredPadding.leaf], [512, 0]);
  const restoredDeep = listChain(deepBindingValue(restored.snapshot));
  assert.deepEqual([restoredDeep.depth, restoredDeep.leaf], [5_000, "leaf"]);
  assert.deepEqual(withoutDeepBinding(restored.snapshot), createFreshRuntimeSnapshot(plan));

  // Changing the caller's innermost data after restore must not reach the restored graphs.
  listChain(deepBindingValue(live.snapshot)).innermost!.items[0] = "changed";
  // EVIDENCE: the caller padding is the nested singleton array built by deepArray above.
  (containerChain(live.plan.padding).innermost as unknown[])[0] = 1;
  assert.equal(listChain(deepBindingValue(restored.snapshot)).leaf, "leaf");
  assert.equal(containerChain(padding).leaf, 0);

  const serializedSnapshot = mutableSnapshot(plan);
  addBinding(serializedSnapshot, "__DEEP_VALUE__");
  const json = JSON.stringify(createCheckpoint(plan, serializedSnapshot)).replace(
    '"__DEEP_VALUE__"',
    deepListJson(5_000),
  );
  const deserialized = deserializeCheckpoint(json);
  assert.equal(validateRuntimeSnapshot(deserialized.snapshot, deserialized.plan).valid, true);
  assert.deepEqual(deserialized.plan, plan);
  const deserializedDeep = listChain(deepBindingValue(deserialized.snapshot));
  assert.deepEqual([deserializedDeep.depth, deserializedDeep.leaf], [5_000, "leaf"]);
  assert.deepEqual(withoutDeepBinding(deserialized.snapshot), createFreshRuntimeSnapshot(plan));
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
    const result = operation(extendedPlan, snapshot);
    assert.equal(result.snapshot.status, "halted", operation.name);
    assert.equal(result.snapshot.failure, null, operation.name);
    assert.deepEqual(
      result.events.map((event) => event.kind),
      ["exit"],
      operation.name,
    );
    const retained = listChain(deepBindingValue(result.snapshot));
    assert.deepEqual([retained.depth, retained.leaf], [512, "leaf"], operation.name);
    assert.deepEqual(snapshot, before, operation.name);
  }
  const padding = containerChain(extendedPlan.padding);
  assert.deepEqual([padding.depth, padding.leaf], [512, 0]);
});

test("serializable cloning is stack-independent beyond the removed depth threshold", () => {
  const input = deepList(FAILING_BEFORE_DEPTH);
  const copy = listChain(cloneSerializableValue(input));
  assert.deepEqual([copy.depth, copy.leaf], [FAILING_BEFORE_DEPTH, "leaf"]);
  // Changing the innermost copied list leaves the input intact, so no level is shared.
  copy.innermost!.items[0] = "changed";
  assert.equal(listChain(input).leaf, "leaf");
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

test("external capture rejects non-canonical proxy arrays without invoking getters", () => {
  const rejected = { ok: false, failure: { kind: "nonJsonSafeValue", path: "$" } };
  // The reported index count differs from the validated length, so density is rejected from the
  // length descriptor and key count alone, before any indexed traversal.
  const densityRows: ReadonlyArray<readonly [string, number, readonly string[]]> = [
    ["missing index 0", 2, ["1", "length"]],
    ["maximum index beyond empty length, length first", 0, ["length", "4294967294"]],
    ["maximum index beyond empty length, length last", 0, ["4294967294", "length"]],
    ["index 0 beyond empty length", 0, ["length", "0"]],
    ["index 1 beyond empty length", 0, ["length", "1"]],
  ];
  for (const [name, length, keys] of densityRows) {
    const key = keys.find((candidate) => candidate !== "length")!;
    const reads = zeroProxyArrayReads();
    assert.deepEqual(
      captureExternalData(proxyArray(length, keys, { [key]: 1 }, reads)),
      rejected,
      name,
    );
    assert.deepEqual(reads, { gets: 0, indexDescriptors: 0, lengthDescriptors: 1 }, name);
  }

  // Length 1 with one reported key passes the density count, so each row reaches validation of
  // the reported index itself.
  const indexRows: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["index at length", ["length", "1"]],
    ["maximum index beyond length, length first", ["length", "4294967294"]],
    ["maximum index beyond length, length last", ["4294967294", "length"]],
    ["non-index 2 ** 32 - 1", ["length", "4294967295"]],
    ["leading zero", ["length", "01"]],
    ["decimal", ["length", "1.0"]],
  ];
  for (const [name, keys] of indexRows) {
    const key = keys.find((candidate) => candidate !== "length")!;
    const reads = zeroProxyArrayReads();
    assert.deepEqual(captureExternalData(proxyArray(1, keys, { [key]: 1 }, reads)), rejected, name);
    assert.equal(reads.gets, 0, name);
  }
});

test("external capture rejects failing proxy length-descriptor traps without invoking getters", () => {
  // The first two rows violate the Proxy invariants for an array's non-configurable length, so the
  // descriptor request itself throws before capture can inspect the reported shape.
  const rows: ReadonlyArray<readonly [string, () => PropertyDescriptor | undefined]> = [
    ["missing length descriptor", () => undefined],
    [
      "accessor length descriptor",
      () => ({ get: () => 0, enumerable: false, configurable: false }),
    ],
    [
      "throwing descriptor trap",
      () => {
        throw new Error("raw descriptor failure");
      },
    ],
  ];
  for (const [name, describe] of rows) {
    const reads = { descriptors: 0, gets: 0 };
    const hostile = new Proxy([], {
      getOwnPropertyDescriptor() {
        reads.descriptors += 1;
        return describe();
      },
      get() {
        reads.gets += 1;
        return 0;
      },
    });
    assert.deepEqual(
      captureExternalData(hostile),
      { ok: false, failure: { kind: "nonJsonSafeValue", path: "$" } },
      name,
    );
    assert.deepEqual(reads, { descriptors: 1, gets: 0 }, name);
  }
});

test("proxy array length inflation is structured at plan, snapshot, checkpoint, and serializable boundaries", () => {
  const hostile = () => proxyArray(0, ["length", "4294967294"], { "4294967294": null });

  const malformedPlan = mutablePlan();
  // EVIDENCE: fixture replaces the instruction list with a hostile proxy array at the validation boundary.
  (malformedPlan as { instructions: unknown }).instructions = hostile();
  assertPlanErrorAt(malformedPlan, "$.instructions");

  const plan = compiledPlan();
  const malformedSnapshot = mutableSnapshot(plan);
  // EVIDENCE: fixture widens only `frames` to inject a proxy array with an impossible length/index combination.
  (malformedSnapshot as { frames: unknown }).frames = hostile();
  assert.equal(validateRuntimeSnapshot(malformedSnapshot, plan).valid, false);

  const malformedCheckpoint = checkpoint(plan, createFreshRuntimeSnapshot(plan));
  // EVIDENCE: fixture widens only checkpoint `frames` to inject the hostile proxy array under validation.
  (malformedCheckpoint.snapshot as { frames: unknown }).frames = hostile();
  assertCheckpointError(() => restoreCheckpoint(malformedCheckpoint), "$.snapshot");

  assert.throws(() => {
    // EVIDENCE: the hostile proxy array deliberately violates the serializable list's dense-array invariant.
    return cloneSerializableValue({ kind: "list", items: hostile() } as never);
  }, isInvalidSerializableValueAt("$.items"));
});

test("serializable cloning accepts broad dense arrays and rejects small and huge sparse arrays", () => {
  const acceptedCount = 100_001;
  const expectedItem = (index: number): SerializableRuntimeValue => {
    if (index === 0) return "first";
    if (index === acceptedCount - 1) return "last";
    return index % 3 === 0 ? index : index % 3 === 1 ? `item ${index}` : index % 2 === 0;
  };
  const accepted = Array.from({ length: acceptedCount }, (_unused, index) => expectedItem(index));
  const cloned = cloneSerializableValue({ kind: "list", items: accepted });
  assert.ok(typeof cloned === "object" && cloned?.kind === "list");
  assert.notEqual(cloned.items, accepted);
  assert.equal(cloned.items.length, acceptedCount);
  accepted[0] = "changed after clone";
  accepted[acceptedCount - 1] = "changed after clone";
  for (let index = 0; index < acceptedCount; index += 1) {
    if (!Object.hasOwn(cloned.items, index) || cloned.items[index] !== expectedItem(index)) {
      assert.fail(`cloned item ${index} is missing or differs from the input pattern`);
    }
  }

  assert.deepEqual(cloneSerializableValue({ kind: "list", items: ["a", null, 3] }), {
    kind: "list",
    items: ["a", null, 3],
  });

  // The maximum-length row also catches length-sized traversal or allocation.
  for (const length of [2, 0xffff_ffff]) {
    const sparse: SerializableRuntimeValue[] = [];
    sparse.length = length;
    sparse[1] = "present";
    assert.throws(
      () => cloneSerializableValue({ kind: "list", items: sparse }),
      isInvalidSerializableValueAt("$.items"),
      String(length),
    );
  }
});

test("plan validation rejects sparse instruction length before execution", () => {
  const validPlan = compiledPlan("say random()\nexit");
  // EVIDENCE: JSON preserves the compiler-produced plan before its instruction array length is made sparse.
  const malformedPlan = JSON.parse(JSON.stringify(validPlan)) as InstructionPlan;
  // EVIDENCE: fixture mutates only the instruction-array length to create a sparse external plan.
  (malformedPlan.instructions as { length: number }).length = 0xffff_ffff;

  assertPlanErrorAt(malformedPlan, "$.instructions");

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
      (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
    );
    assert.equal(randomCalls, 0);
    assert.deepEqual(snapshot, before);
  }
});

test("snapshot and checkpoint paths reject sparse arrays as malformed data", () => {
  const plan = compiledPlan("say random()\nexit");
  const malformedSnapshot = mutableSnapshot(plan);
  malformedSnapshot.frames.length = 0xffff_ffff;

  assert.equal(validateRuntimeSnapshot(malformedSnapshot, plan).valid, false);

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const snapshot = mutableSnapshot(plan);
    snapshot.frames.length = 0xffff_ffff;
    const before = sparseSnapshotState(snapshot);
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
      (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
    );
    assert.equal(randomCalls, 0);
    assert.deepEqual(sparseSnapshotState(snapshot), before);
  }

  const malformedCheckpoint = checkpoint(plan, createFreshRuntimeSnapshot(plan));
  malformedCheckpoint.snapshot.frames.length = 0xffff_ffff;
  const checkpointSnapshotBefore = sparseSnapshotState(malformedCheckpoint.snapshot);
  assertCheckpointError(() => restoreCheckpoint(malformedCheckpoint), "$.snapshot");
  assert.deepEqual(sparseSnapshotState(malformedCheckpoint.snapshot), checkpointSnapshotBefore);
});

test("cycles, non-plain objects, non-finite numbers, and malformed kinds remain rejected", () => {
  // The validator reports each at the offending path; the capture failure kind names the rule.
  const cyclicPlan = mutablePlan();
  cyclicPlan.self = cyclicPlan;
  assertPlanErrorAt(cyclicPlan, "$.self");
  assert.equal(captureInstructionPlan(cyclicPlan).failureKind, "cycle");

  const nonPlainPlan = mutablePlan();
  nonPlainPlan.padding = new Date(0);
  assertPlanErrorAt(nonPlainPlan, "$.padding");
  assert.equal(captureInstructionPlan(nonPlainPlan).failureKind, "nonPlainObject");

  const nonFinitePlan = mutablePlan();
  nonFinitePlan.padding = Number.POSITIVE_INFINITY;
  assertPlanErrorAt(nonFinitePlan, "$.padding");
  assert.equal(captureInstructionPlan(nonFinitePlan).failureKind, "nonFiniteNumber");

  const cyclicValue: { kind: "list"; items: SerializableRuntimeValue[] } = {
    kind: "list",
    items: [],
  };
  cyclicValue.items.push(cyclicValue);
  assert.throws(
    () => cloneSerializableValue(cyclicValue),
    (error: unknown) => error instanceof SerializableValueError && error.code === "cyclic",
  );

  assert.throws(() => {
    // EVIDENCE: unsupported `kind` is intentionally presented as a serializable value for rejection.
    return cloneSerializableValue({ kind: "unknown" } as never);
  }, isInvalidSerializableValueAt("$.kind"));
});
