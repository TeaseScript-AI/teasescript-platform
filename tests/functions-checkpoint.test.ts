import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/instructions.js";
import {
  CheckpointError,
  createCheckpoint,
  restoreCheckpoint,
} from "../src/runtime/checkpoint.js";
import {
  executeInstruction,
  run,
  type RuntimeBuiltinFunction,
} from "../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../src/runtime/serializable-values.js";
import {
  createFreshRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";

test("restores every instruction boundary during defaults and nested calls", () => {
  const observations = assertEveryInstructionResume([
    "let count = 0",
    "function next(value) { count = count + 1\nreturn `${value}:${count}` }",
    'function describe(name, title = next(name)) { say `inside:${title}`\nreturn title }',
    'say describe("pet")',
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.at(-1)?.parameterState.phase === "supplied" &&
    snapshot.callFrames.at(-1)?.parameterState.parameterIndex === 0
  ));
  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.some((frame) => frame.parameterState.phase === "defaults")
  ));
  assert.ok(observations.some((snapshot) => snapshot.callFrames.length >= 2));
  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.length === 0 && snapshot.temporaries.length > 0
  ));
});

test("restores inside function loops, after continue, and before early return", () => {
  const observations = assertEveryInstructionResume([
    "function find(limit) {",
    "  for value in 1..=limit {",
    "    if value == 1 { continue }",
    '    say `loop:${value}`',
    "    if value == 3 { return value }",
    "  }",
    "  return null",
    "}",
    "say find(4)",
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.length === 1 && snapshot.loopFrames.length === 1
  ));
  assert.ok(observations.some((snapshot) => {
    const next = snapshot.nextInstruction;
    return snapshot.callFrames.length === 1 && snapshot.loopFrames.length === 1 && next >= 0;
  }));
});

test("restores direct and mutual recursion at every instruction boundary", () => {
  const direct = assertEveryInstructionResume([
    "function factorial(value) {",
    "  if value <= 1 { return 1 }",
    "  return value * factorial(value - 1)",
    "}",
    "say factorial(5)",
  ].join("\n"));
  assert.ok(direct.some((snapshot) => snapshot.callFrames.length >= 4));

  const mutual = assertEveryInstructionResume([
    "function even(value) { if value == 0 { return true }\nreturn odd(value - 1) }",
    "function odd(value) { if value == 0 { return false }\nreturn even(value - 1) }",
    "say even(5)",
  ].join("\n"));
  assert.ok(mutual.some((snapshot) =>
    snapshot.callFrames.some((frame) => frame.functionName === "even") &&
    snapshot.callFrames.some((frame) => frame.functionName === "odd")
  ));
});

test("restores between nested calls and around say events without duplicates", () => {
  const observations = assertEveryInstructionResume([
    "function first { say \"first\"\nreturn 1 }",
    "function second { say \"second\"\nreturn 2 }",
    "say first() + second()",
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.length === 0 &&
    snapshot.temporaries.length > 0 &&
    snapshot.status === "running"
  ));
});

test("restores exact RNG state through nested calls", () => {
  const observations = assertEveryInstructionResume([
    "function roll { return randomInteger(1..=6) }",
    "function pair { return roll() + roll() }",
    "say pair()",
    "say roll()",
  ].join("\n"));

  assert.ok(new Set(observations.map((snapshot) => snapshot.rng.state)).size > 1);
});

test("checkpoint creation defensively isolates the supplied plan", () => {
  const original = mutablePlan(plan("function value { return 1 }\nsay value()"));
  const snapshot = createFreshRuntimeSnapshot(original as InstructionPlan);
  const checkpoint = createCheckpoint(original as InstructionPlan, snapshot);
  const originalName = checkpoint.plan.functions[0]!.name;

  original.functions[0]!.name = "mutated";
  assert.equal(checkpoint.plan.functions[0]!.name, originalName);
});

test("rejects legacy v1 and v2 checkpoint, plan, and snapshot formats", () => {
  const compiled = plan("exit");
  const base = mutableCheckpoint(
    createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled)),
  );

  for (const version of [1, 2]) {
    const checkpointVersion = structuredClone(base);
    checkpointVersion.version = version;
    assertCheckpointRejected(checkpointVersion, "TSK001");

    const planVersion = structuredClone(base);
    planVersion.plan.version = version;
    assertCheckpointRejected(planVersion, "TSK001");

    const snapshotVersion = structuredClone(base);
    snapshotVersion.snapshot.version = version;
    assertCheckpointRejected(snapshotVersion, "TSK001");
  }
});

test("rejects malformed active call-frame identity and return state", () => {
  const { plan: compiled, snapshot } = recursiveSnapshot(3);
  const cases: Array<(checkpoint: MutableCheckpoint) => void> = [
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.functionId = 999; },
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.returnInstruction = 999; },
    (checkpoint) => {
      checkpoint.snapshot.callFrames[1]!.id = checkpoint.snapshot.callFrames[0]!.id;
    },
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.scopeBaseDepth = 0; },
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.loopBaseDepth = 999; },
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.destinationTemporary = 0; },
    (checkpoint) => {
      checkpoint.snapshot.callFrames.at(-1)!.parameterState.parameterIndex = 999;
    },
    (checkpoint) => { checkpoint.snapshot.maxCallDepth = 1; },
  ];

  for (const mutate of cases) {
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    mutate(checkpoint);
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects empty serialized names and impossible status combinations", () => {
  const compiled = plan("let value = 1\nfunction read(input) { return input }\nread(value)");
  let active = createFreshRuntimeSnapshot(compiled);
  active = executeInstruction(compiled, active).snapshot;
  const bindingCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  bindingCheckpoint.snapshot.frames[0]!.bindings[0]!.name = "";
  assertCheckpointRejected(bindingCheckpoint, "TSK002");

  const functionCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  functionCheckpoint.plan.functions[0]!.name = "";
  assertCheckpointRejected(functionCheckpoint, "TSK002");

  const parameterCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  parameterCheckpoint.plan.functions[0]!.parameters[0]!.name = "";
  assertCheckpointRejected(parameterCheckpoint, "TSK002");

  active = executeInstruction(compiled, active).snapshot;
  const statusCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  statusCheckpoint.snapshot.status = "halted";
  assertCheckpointRejected(statusCheckpoint, "TSK002");
});

test("rejects cyclic runtime state without overflowing validation", () => {
  const compiled = plan("let value = [1]\nexit");
  const snapshot = createFreshRuntimeSnapshot(compiled);
  const checkpoint = {
    format: "teasescript-checkpoint",
    version: 3,
    plan: compiled,
    snapshot,
  } as Record<string, unknown>;
  const cyclic = { kind: "list", items: [] as unknown[] };
  cyclic.items.push(cyclic);
  snapshot.frames[0]!.bindings.push({
    name: "cyclic",
    value: cyclic as SerializableRuntimeValue,
  });

  assertCheckpointRejected(checkpoint, "TSK002");
});

test("cyclic builtin results become source-associated runtime failures", () => {
  const compiledResult = compileSource("say cyclic()", { builtins: ["cyclic"] });
  assert.deepEqual(compiledResult.diagnostics, []);
  const compiled = compiledResult.plan!;
  const cyclic = { kind: "list", items: [] as unknown[] };
  cyclic.items.push(cyclic);
  const builtin: RuntimeBuiltinFunction = () => cyclic as SerializableRuntimeValue;
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    { builtins: { cyclic: builtin } },
  );

  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.failure?.code, "TSR013");
  assert.ok(result.snapshot.failure?.span.start.offset !== undefined);
});

function assertEveryInstructionResume(source: string): RuntimeSnapshot[] {
  const compiled = plan(source);
  const initial = createFreshRuntimeSnapshot(compiled, { seed: 0x1234_5678 });
  const uninterrupted = run(compiled, initial);
  const observed: RuntimeSnapshot[] = [];
  let partial = initial;
  const events = [] as typeof uninterrupted.events[number][];
  let guard = 0;
  while (partial.status !== "halted" && partial.status !== "failed") {
    const operation = executeInstruction(compiled, partial);
    partial = operation.snapshot;
    events.push(...operation.events);
    const restored = restoreCheckpoint(
      JSON.parse(JSON.stringify(createCheckpoint(compiled, partial))) as unknown,
    );
    assert.deepEqual(restored.snapshot, partial);
    const resumed = run(restored.plan, restored.snapshot);
    assert.deepEqual([...events, ...resumed.events], uninterrupted.events);
    assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
    observed.push(partial);
    guard += 1;
    assert.ok(guard < 2_000, "instruction-boundary checkpoint test did not terminate");
  }
  return observed;
}

function recursiveSnapshot(depth: number): {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
} {
  const compiled = plan("function recurse { return recurse() }\nrecurse()");
  let snapshot = createFreshRuntimeSnapshot(compiled, { maxCallDepth: 16 });
  while (snapshot.callFrames.length < depth) {
    snapshot = executeInstruction(compiled, snapshot).snapshot;
  }
  return { plan: compiled, snapshot };
}

function plan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

type MutableCheckpoint = ReturnType<typeof mutableCheckpoint>;

function mutableCheckpoint(checkpoint: ReturnType<typeof createCheckpoint>): any {
  return JSON.parse(JSON.stringify(checkpoint));
}

function mutablePlan(compiled: InstructionPlan): any {
  return JSON.parse(JSON.stringify(compiled));
}

function assertCheckpointRejected(value: unknown, code: string): void {
  assert.throws(
    () => restoreCheckpoint(value),
    (error: unknown) => error instanceof CheckpointError && error.info.code === code,
  );
}
