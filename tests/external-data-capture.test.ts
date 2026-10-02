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
import { SerializableValueError } from "../src/runtime/serializable-values.js";
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

function deepListJson(depth: number, leaf = '"leaf"'): string {
  return `${'{"kind":"list","items":['.repeat(depth)}${leaf}${"]}".repeat(depth)}`;
}

function deepList(depth: number): SerializableRuntimeValue {
  // EVIDENCE: deepListJson constructs only nested canonical list envelopes with a string leaf.
  return JSON.parse(deepListJson(depth)) as SerializableRuntimeValue;
}

function addBinding(snapshot: RuntimeSnapshot, value: unknown): void {
  // EVIDENCE: fixture insertion intentionally admits unvalidated values at the snapshot-validation boundary.
  (snapshot.frames[0]!.bindings as Array<{ name: string; value: unknown }>).push({
    name: "deep",
    value,
  });
}

function deepBindingValue(snapshot: RuntimeSnapshot): SerializableRuntimeValue | undefined {
  const matches = snapshot.frames
    .flatMap((frame) => frame.bindings)
    .filter((binding) => binding.name === "deep");
  assert.equal(matches.length, 1);
  return matches[0]?.value;
}

function withoutDeepBinding(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    ...snapshot,
    frames: snapshot.frames.map((frame) => ({
      ...frame,
      bindings: frame.bindings.filter((binding) => binding.name !== "deep"),
    })),
  };
}

// Walks single-item list envelopes iteratively so deep values never need recursive comparison.
function assertDeepList(
  value: SerializableRuntimeValue | undefined,
  depth: number,
): SerializableRuntimeValue[] {
  let current = value;
  let innermostItems: SerializableRuntimeValue[] = [];
  for (let level = 0; level < depth; level += 1) {
    assert.ok(typeof current === "object" && current?.kind === "list", `list level ${level}`);
    assert.equal(current.items.length, 1, `list level ${level}`);
    innermostItems = current.items;
    current = current.items[0];
  }
  assert.equal(current, "leaf");
  return innermostItems;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Follows fields and indexes through external JSON data, failing at the first missing step. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: fixture helper returns deliberately unvalidated external plan data for the validation boundary under test.
function jsonAt(root: unknown, steps: readonly (string | number)[]): unknown {
  let current = root;
  for (const step of steps) {
    const descriptor =
      typeof current === "object" && current !== null
        ? Object.getOwnPropertyDescriptor(current, step)
        : undefined;
    assert.ok(descriptor !== undefined && "value" in descriptor, `missing ${String(step)}`);
    current = descriptor.value;
  }
  return current;
}

function checkpoint(plan: InstructionPlan, snapshot: RuntimeSnapshot): RuntimeCheckpoint {
  // EVIDENCE: JSON round-trips a checkpoint created from the supplied validated plan and snapshot.
  return JSON.parse(JSON.stringify(createCheckpoint(plan, snapshot))) as RuntimeCheckpoint;
}

function assertCheckpointError(operation: () => void, path: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CheckpointError);
    assert.equal(error.info.code, "TSK002");
    assert.equal(error.info.path, path);
    return true;
  });
}

// Represents a snapshot whose frames array is huge and sparse through own descriptors only,
// so the comparison never iterates or materializes the sparse length.
function sparseSnapshotState(snapshot: RuntimeSnapshot): {
  ordinary: Omit<RuntimeSnapshot, "frames">;
  frames: Array<[string, PropertyDescriptor | undefined]>;
} {
  const { frames, ...ordinary } = snapshot;
  return {
    ordinary: structuredClone(ordinary),
    frames: Object.getOwnPropertyNames(frames).map((key) => [
      key,
      structuredClone(Object.getOwnPropertyDescriptor(frames, key)),
    ]),
  };
}

function proxyArray(
  length: number,
  keys: readonly string[],
  values: Readonly<Record<string, unknown>> = {},
  access = { gets: 0 },
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
      access.gets += 1;
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

test("plan validation accepts deep and broad plan data without a generic depth or work limit", () => {
  const depth = 1_000;
  const width = 10_000;
  const plan = mutablePlan(
    `let deep = ${"[".repeat(depth)}0${"]".repeat(depth)}\nlet broad = [0]\nexit`,
  );
  const broad = jsonAt(plan, ["instructions", 1, "value", "elements"]);
  assert.ok(Array.isArray(broad));
  // Repeating the compiled element keeps every broad element in an accepted plan shape.
  while (broad.length < width) broad.push(structuredClone(broad[0]));
  assert.deepEqual(validateInstructionPlan(plan), { valid: true, errors: [] });

  // A non-finite value at the deepest leaf or the last element proves that validation reached it.
  const deepest = jsonAt(plan, [
    "instructions",
    0,
    "value",
    ...Array.from({ length: depth }, () => ["elements", 0]).flat(),
  ]);
  const last = broad.at(-1);
  for (const [leaf, path] of [
    [deepest, `$.instructions[0].value${".elements[0]".repeat(depth)}.value`],
    [last, `$.instructions[1].value.elements[${width - 1}].value`],
  ] as const) {
    assert.ok(isJsonRecord(leaf) && leaf.value === 0, path);
    leaf.value = Number.POSITIVE_INFINITY;
    assert.deepEqual(
      validateInstructionPlan(plan).errors.map((error) => [error.code, error.path]),
      [["TSC002", path]],
    );
    leaf.value = 0;
  }
});

test("repeated stepping and checkpoint entries reuse the validated immutable plan", () => {
  const statementCount = 64;
  const source = Array.from(
    { length: statementCount },
    (_, index) => `say "Line ${index}", instant`,
  ).join("\n");
  const plan = compiledPlan(source);
  const uninterrupted = run(plan, createFreshRuntimeSnapshot(plan));
  // validateInstructionPlan always captures its input, so this measures one whole-plan capture.
  const wholePlanVisits = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(plan).valid, true);
    return finish();
  }).counts.externalCaptureVisits!;
  let snapshot = createFreshRuntimeSnapshot(plan);
  const events: (typeof uninterrupted.events)[number][] = [];
  let entries = 0;

  const statistics = withValidationTestStatistics((finish) => {
    while (snapshot.status !== "halted") {
      // One event boundary per instant say, plus the terminal step.
      assert.ok(entries < 2 * (statementCount + 1), "stepping did not halt");
      const callerBefore = structuredClone(snapshot);
      const stepped = stepToEvent(plan, snapshot);
      assert.deepEqual(snapshot, callerBefore);
      events.push(...stepped.events);
      snapshot = stepped.snapshot;
      assert.equal(createCheckpoint(plan, snapshot).plan, plan);
      entries += 2;
    }
    return finish();
  }).counts;

  assert.deepEqual(events, uninterrupted.events);
  assert.equal(restoreCheckpoint(createCheckpoint(plan, snapshot)).plan, plan);
  // Scoped regression oracle for RUNTIME.md plan-identity reuse, not a performance requirement: recapturing the plan
  // at every entry would cost at least `entries` whole-plan captures; reuse leaves only the small snapshot captures.
  assert.ok((statistics.externalCaptureVisits ?? 0) < (entries * wholePlanVisits) / 4);
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

test("checkpoint entries return deeply frozen plans detached from the caller", () => {
  const source = "let value = [1, { nested: 2 }]\nexit";
  const plan = mutablePlan(source);
  const created = createCheckpoint(plan, createFreshRuntimeSnapshot(compiledPlan(source)));
  const json = JSON.stringify(created);

  for (const [entry, returned] of [
    ["createCheckpoint", created.plan],
    ["restoreCheckpoint", restoreCheckpoint(JSON.parse(json)).plan],
    ["deserializeCheckpoint", deserializeCheckpoint(json).plan],
  ] as const) {
    const instruction = returned.instructions[0]!;
    for (const value of [returned, returned.instructions, instruction, instruction.span]) {
      assert.equal(Object.isFrozen(value), true, entry);
    }
    // Module code is strict, so a write into a frozen returned graph throws instead of reaching later entries.
    assert.throws(() => {
      // EVIDENCE: the write deliberately targets the readonly span of a returned plan.
      (instruction.span as { so: number }).so = 3;
    }, TypeError);
  }

  // EVIDENCE: mutablePlan returns a detached fixture whose instruction spans are intentionally mutable.
  (plan.instructions[0] as { span: { so: number } }).span.so = 3;
  assert.notEqual(created.plan.instructions[0]!.span.so, 3);
});

test("ordinary source compiles beyond the removed generic capture threshold", () => {
  const count = 5_000;
  const source = Array.from({ length: count }, (_, index) => `say "Line ${index}"`).join("\n");
  const compiled = compileSource(source);

  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  assert.equal(Object.isFrozen(compiled.plan), true);
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
  const live = checkpoint(plan, createFreshRuntimeSnapshot(plan));
  addBinding(live.snapshot, deepList(5_000));
  const restored = restoreCheckpoint(live);
  assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);
  assertDeepList(deepBindingValue(restored.snapshot), 5_000);
  assert.deepEqual(withoutDeepBinding(restored.snapshot), createFreshRuntimeSnapshot(plan));
  assert.deepEqual(restored.plan, plan);

  // Any node shared with the caller would expose this innermost rewrite through the restored graph.
  assertDeepList(deepBindingValue(live.snapshot), 5_000)[0] = "changed";
  assertDeepList(deepBindingValue(restored.snapshot), 5_000);

  const serializedSnapshot = mutableSnapshot(plan);
  addBinding(serializedSnapshot, "__DEEP_VALUE__");
  const json = JSON.stringify(createCheckpoint(plan, serializedSnapshot)).replace(
    '"__DEEP_VALUE__"',
    deepListJson(5_000),
  );
  const deserialized = deserializeCheckpoint(json);
  assert.equal(validateRuntimeSnapshot(deserialized.snapshot, deserialized.plan).valid, true);
  assertDeepList(deepBindingValue(deserialized.snapshot), 5_000);
  assert.deepEqual(withoutDeepBinding(deserialized.snapshot), createFreshRuntimeSnapshot(plan));
  assert.deepEqual(deserialized.plan, plan);
});

test("runtime entry points accept valid deep plan and snapshot data without mutating the caller", () => {
  const depth = 512;
  // The plan is a mutable external copy, so each entry captures and validates its deep list literal.
  const plan = mutablePlan(`let planned = ${"[".repeat(depth)}"leaf"${"]".repeat(depth)}\nexit`);

  for (const operation of [executeInstruction, stepToEvent, run]) {
    let snapshot = mutableSnapshot(plan);
    addBinding(snapshot, deepList(depth));
    const before = structuredClone(snapshot);
    const result = operation(plan, snapshot);
    assert.deepEqual(snapshot, before);
    assert.equal(result.snapshot.failure, null);
    assertDeepList(deepBindingValue(result.snapshot), depth);
    snapshot = result.snapshot;
    if (snapshot.status !== "halted") snapshot = run(plan, snapshot).snapshot;
    assert.equal(snapshot.status, "halted");
    const planned = snapshot.frames[0]!.bindings.find((binding) => binding.name === "planned");
    assertDeepList(planned?.value, depth);
  }
});

test("serializable cloning is stack-independent beyond the removed depth threshold", () => {
  const input = deepList(FAILING_BEFORE_DEPTH);
  const cloned = cloneSerializableValue(input);

  // Walk input and clone together iteratively: same depth and leaf, with no shared list or items array.
  let source: SerializableRuntimeValue | undefined = input;
  let copy: SerializableRuntimeValue | undefined = cloned;
  for (let level = 0; level < FAILING_BEFORE_DEPTH; level += 1) {
    assert.ok(typeof source === "object" && source?.kind === "list", `input level ${level}`);
    assert.ok(typeof copy === "object" && copy?.kind === "list", `clone level ${level}`);
    assert.notEqual(copy, source, `shared list at level ${level}`);
    assert.notEqual(copy.items, source.items, `shared items at level ${level}`);
    assert.equal(copy.items.length, 1, `clone level ${level}`);
    source = source.items[0];
    copy = copy.items[0];
  }
  assert.equal(source, "leaf");
  assert.equal(copy, "leaf");
});

test("external capture rejects non-canonical and length-conflicting proxy arrays", () => {
  const rows = [
    {
      name: "hole before a present index",
      length: 2,
      keys: ["1", "length"],
      values: { "1": "present" },
    },
    ...[
      ["length", "4294967294"],
      ["4294967294", "length"],
    ].map((keys) => ({
      name: `maximum index beyond length with keys ${keys.join(",")}`,
      length: 0,
      keys,
      values: { "4294967294": 1 },
    })),
    // One non-index key and one non-canonical index string. The length matches the key count,
    // so only the per-key index rule can reject them.
    ...["4294967295", "01"].map((key) => ({
      name: `key ${key} with matching length`,
      length: 1,
      keys: ["length", key],
      values: { [key]: 1 },
    })),
  ];

  // Every row is rejected without invoking a getter.
  for (const row of rows) {
    const access = { gets: 0 };
    assert.deepEqual(
      captureExternalData(proxyArray(row.length, row.keys, row.values, access)),
      { ok: false, failure: { kind: "nonJsonSafeValue", path: "$" } },
      row.name,
    );
    assert.equal(access.gets, 0, row.name);
  }
});

test("external capture rejects failed proxy length-descriptor traps without invoking get", () => {
  // Hiding or reporting an accessor for a real array's non-configurable `length` violates Proxy
  // invariants, so Reflect fails these traps before capture can inspect the returned descriptor.
  for (const [name, lengthDescriptor] of [
    ["hidden length (invariant violation)", () => undefined],
    [
      "accessor length (invariant violation)",
      () => ({ get: () => 0, enumerable: false, configurable: false }),
    ],
    [
      "explicitly throwing trap",
      () => {
        throw new Error("raw descriptor failure");
      },
    ],
  ] as const) {
    const access = { descriptors: 0, gets: 0 };
    const hostile = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        access.descriptors += 1;
        return key === "length"
          ? lengthDescriptor()
          : Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) {
        access.gets += 1;
        return Reflect.get(target, key, receiver); // oxlint-disable-line anti-slop/no-reflect-get -- EVIDENCE: fixture forwards and counts any property read so the test can require none.
      },
    });
    assert.deepEqual(
      captureExternalData(hostile),
      { ok: false, failure: { kind: "nonJsonSafeValue", path: "$" } },
      name,
    );
    assert.ok(access.descriptors > 0, name);
    assert.equal(access.gets, 0, name);
  }
});
test("proxy array length inflation is structured at plan, snapshot, checkpoint, and serializable boundaries", () => {
  const hostile = () => proxyArray(0, ["length", "4294967294"], { "4294967294": null });

  const malformedPlan = mutablePlan();
  // EVIDENCE: fixture replaces the instruction list with a hostile proxy array at the validation boundary.
  (malformedPlan as { instructions: unknown }).instructions = hostile();
  assert.deepEqual(
    validateInstructionPlan(malformedPlan).errors.map((error) => [error.code, error.path]),
    [["TSC002", "$.instructions"]],
  );

  const plan = compiledPlan();
  const malformedSnapshot = mutableSnapshot(plan);
  // EVIDENCE: fixture widens only `frames` to inject a proxy array with an impossible length/index combination.
  (malformedSnapshot as { frames: unknown }).frames = hostile();
  const snapshotErrors = validateRuntimeSnapshot(malformedSnapshot, plan).errors;
  assert.ok(
    snapshotErrors.some((error) => error.includes("non-JSON-safe")),
    snapshotErrors.join("; "),
  );

  const malformedCheckpoint = checkpoint(plan, createFreshRuntimeSnapshot(plan));
  // EVIDENCE: fixture widens only checkpoint `frames` to inject the hostile proxy array under validation.
  (malformedCheckpoint.snapshot as { frames: unknown }).frames = hostile();
  assertCheckpointError(() => restoreCheckpoint(malformedCheckpoint), "$.snapshot");

  assert.throws(
    () => {
      // EVIDENCE: the hostile proxy array deliberately violates the serializable list's dense-array invariant.
      return cloneSerializableValue({ kind: "list", items: hostile() } as never);
    },
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message.startsWith("$.items "),
  );
});

test("serializable cloning accepts broad dense arrays and rejects sparse arrays", () => {
  const acceptedCount = 100_001;
  const expectedItem = (index: number): SerializableRuntimeValue => {
    if (index === 0) return "first";
    if (index === acceptedCount - 1) return "last";
    if (index % 4 === 0) return index;
    if (index % 4 === 1) return `item ${index}`;
    return index % 4 === 2 ? index % 8 === 2 : null;
  };
  const accepted = Array.from({ length: acceptedCount }, (_, index) => expectedItem(index));
  const cloned = cloneSerializableValue({ kind: "list", items: accepted });
  assert.ok(typeof cloned === "object" && cloned?.kind === "list");
  assert.notEqual(cloned.items, accepted);
  assert.equal(cloned.items.length, acceptedCount);
  accepted[1] = "changed";
  for (let index = 0; index < acceptedCount; index += 1) {
    assert.ok(Object.hasOwn(cloned.items, index), `missing item ${index}`);
    assert.equal(cloned.items[index], expectedItem(index), `item ${index}`);
  }

  assert.deepEqual(cloneSerializableValue({ kind: "list", items: ["a", null, 3] }), {
    kind: "list",
    items: ["a", null, 3],
  });

  const smallSparse: SerializableRuntimeValue[] = [];
  smallSparse.length = 2;
  smallSparse[1] = "present";
  // The maximum-length row catches accidental length-sized traversal or allocation.
  const hugeSparse: SerializableRuntimeValue[] = [];
  hugeSparse.length = 0xffff_ffff;
  for (const [name, items] of [
    ["small sparse", smallSparse],
    ["maximum-length sparse", hugeSparse],
  ] as const) {
    assert.throws(
      () => cloneSerializableValue({ kind: "list", items }),
      (error: unknown) =>
        error instanceof SerializableValueError &&
        error.code === "invalid" &&
        error.message.startsWith("$.items "),
      name,
    );
  }
});

test("plan validation rejects sparse instruction length before execution", () => {
  const validPlan = compiledPlan("say random()\nexit");
  // EVIDENCE: JSON preserves the compiler-produced plan before its instruction array length is made sparse.
  const malformedPlan = JSON.parse(JSON.stringify(validPlan)) as InstructionPlan;
  // EVIDENCE: fixture mutates only the instruction-array length to create a sparse external plan.
  (malformedPlan.instructions as { length: number }).length = 0xffff_ffff;

  assert.deepEqual(
    validateInstructionPlan(malformedPlan).errors.map((error) => [error.code, error.path]),
    [["TSC002", "$.instructions"]],
  );

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
  const validationBefore = sparseSnapshotState(malformedSnapshot);

  assert.equal(validateRuntimeSnapshot(malformedSnapshot, plan).valid, false);
  assert.deepEqual(sparseSnapshotState(malformedSnapshot), validationBefore);

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
  const checkpointBefore = sparseSnapshotState(malformedCheckpoint.snapshot);
  assertCheckpointError(() => restoreCheckpoint(malformedCheckpoint), "$.snapshot");
  assert.deepEqual(sparseSnapshotState(malformedCheckpoint.snapshot), checkpointBefore);
});

test("serializable cloning rejects cyclic values and unknown kinds", () => {
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
      error.message.startsWith("$.kind "),
  );
});
