import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/instructions.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import {
  executeInstruction,
  run,
  stepToEvent,
} from "../src/runtime/engine.js";
import type {
  SerializableRuntimeObject,
  SerializableRuntimeSet,
  SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";

test("runtime snapshots survive JSON stringify and parse validation", () => {
  const compiled = plan("let values = set[3, 1, 2]\nexit");
  const execution = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled));
  const parsed = JSON.parse(JSON.stringify(execution.snapshot)) as unknown;

  assert.deepEqual(parsed, execution.snapshot);
  assert.equal(validateRuntimeSnapshot(parsed, compiled).valid, true);
});

test("restores a self-contained checkpoint from serialized JSON", () => {
  const compiled = plan('let score = 1\nsay `${score}`\nexit');
  const first = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled));
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, first.snapshot)));
  const completed = run(restored.plan, restored.snapshot);

  assert.equal(completed.snapshot.status, "halted");
  assert.deepEqual(completed.events.map((event) => event.sequence), [1, 2]);
});

test("uninterrupted and checkpoint-resumed execution are identical", () => {
  const compiled = plan([
    "speaker vera { title: \"Mistress\" }",
    "speaker vera",
    'let values = set["first", "second", "third"]',
    "let chosen = values.random",
    'say `Choice: ${chosen}`',
    'values.add("fourth")',
    'say `Again: ${values.random}`',
    "exit",
  ].join("\n"));
  const initial = createFreshRuntimeSnapshot(compiled, { seed: 12345 });
  const uninterrupted = run(compiled, initial);

  let partialSnapshot = initial;
  const partialEvents = [] as typeof uninterrupted.events[number][];
  for (let count = 0; count < 5; count += 1) {
    const operation = executeInstruction(compiled, partialSnapshot);
    partialSnapshot = operation.snapshot;
    partialEvents.push(...operation.events);
  }
  const restored = restoreCheckpoint(
    JSON.parse(JSON.stringify(createCheckpoint(compiled, partialSnapshot))) as unknown,
  );
  const resumed = run(restored.plan, restored.snapshot);

  assert.deepEqual([...partialEvents, ...resumed.events], uninterrupted.events);
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
});

test("preserves nested deep-copy independence and ordered sets after restore", () => {
  const compiled = plan([
    "let original = { nested: [[1]], values: set[3, 1, 2] }",
    "let copied = original",
    "copied.nested[0][0] = 9",
    "copied.values.add(4)",
    "exit",
  ].join("\n"));
  let snapshot = createFreshRuntimeSnapshot(compiled);
  snapshot = executeInstruction(compiled, snapshot).snapshot;
  snapshot = executeInstruction(compiled, snapshot).snapshot;
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, snapshot)),
  );
  const completed = run(restored.plan, restored.snapshot);
  const original = rootValue(completed.snapshot, "original") as SerializableRuntimeObject;
  const copied = rootValue(completed.snapshot, "copied") as SerializableRuntimeObject;

  assert.deepEqual(objectProperty(original, "nested"), {
    kind: "list",
    items: [{ kind: "list", items: [1] }],
  });
  assert.deepEqual(objectProperty(copied, "nested"), {
    kind: "list",
    items: [{ kind: "list", items: [9] }],
  });
  assert.deepEqual((objectProperty(original, "values") as SerializableRuntimeSet).items, [3, 1, 2]);
  assert.deepEqual((objectProperty(copied, "values") as SerializableRuntimeSet).items, [3, 1, 2, 4]);
});

test("keeps same-named speakers in sibling lexical scopes as distinct state", () => {
  const compiled = plan([
    "if true {",
    "  speaker voice {}",
    '  say as voice "First"',
    "}",
    "if true {",
    "  speaker voice {}",
    '  say as voice "Second"',
    "}",
    "exit",
  ].join("\n"));
  const completed = run(compiled, createFreshRuntimeSnapshot(compiled));

  assert.equal(completed.snapshot.status, "halted");
  assert.deepEqual(completed.snapshot.speakers.map((speaker) => speaker.id), [1, 2]);
  assert.deepEqual(
    completed.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["First", "Second"],
  );
});

test("continues fallback-warning deduplication and event sequences after restore", () => {
  const compiled = plan([
    "speaker vera {}",
    "speaker vera",
    'say "First"',
    'say "Second"',
    "exit",
  ].join("\n"));
  const firstBoundary = stepToEvent(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(firstBoundary.events.map((event) => event.kind), [
    "developerWarning",
    "say",
  ]);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, firstBoundary.snapshot)),
  );
  const remaining = run(restored.plan, restored.snapshot);

  assert.equal(remaining.events.some((event) => event.kind === "developerWarning"), false);
  assert.deepEqual(remaining.events.map((event) => event.sequence), [3, 4]);
});

test("continues deterministic RNG state after restore", () => {
  const compiled = plan([
    'let values = ["a", "b", "c", "d"]',
    "say values.random",
    "say values.random",
    "exit",
  ].join("\n"));
  const initial = createFreshRuntimeSnapshot(compiled, { seed: 0x1234_5678 });
  const uninterrupted = run(compiled, initial);
  const first = stepToEvent(compiled, initial);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, first.snapshot)),
  );
  const rest = run(restored.plan, restored.snapshot);

  assert.deepEqual([...first.events, ...rest.events], uninterrupted.events);
  assert.deepEqual(rest.snapshot.rng, uninterrupted.snapshot.rng);
});

test("rejects unsupported checkpoint and nested format versions", () => {
  const compiled = plan("exit");
  const checkpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled))),
  ) as Record<string, unknown>;

  checkpoint.version = 99;
  assertCheckpointCode(checkpoint, "TSK001");
  checkpoint.version = 1;
  (checkpoint.plan as Record<string, unknown>).version = 99;
  assertCheckpointCode(checkpoint, "TSK001");
});

test("rejects corrupted checkpoint data through structured errors", () => {
  const compiled = plan("exit");
  const checkpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled))),
  ) as { snapshot: Record<string, unknown> };
  checkpoint.snapshot.frames = [];

  assertCheckpointCode(checkpoint, "TSK002");
  assert.throws(() => deserializeCheckpoint("{"), (error: unknown) => {
    return error instanceof CheckpointError && error.info.code === "TSK003";
  });
});

test("rejects colliding or malformed scope-frame identity state", () => {
  const compiled = plan('if true {\n  say "inside"\n}\nexit');
  const conditional = executeInstruction(
    compiled,
    createFreshRuntimeSnapshot(compiled),
  );
  const entered = executeInstruction(compiled, conditional.snapshot);
  const checkpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, entered.snapshot)),
  ) as { snapshot: RuntimeSnapshot };

  checkpoint.snapshot.nextScopeId = checkpoint.snapshot.frames[1]!.id;
  assertCheckpointCode(checkpoint, "TSK002");
  checkpoint.snapshot.nextScopeId = 2;
  (checkpoint.snapshot.frames[0] as { id: number }).id = 9;
  assertCheckpointCode(checkpoint, "TSK002");
});

test("fails structurally when the configurable instruction budget is exhausted", () => {
  const compiled = plan("let first = 1\nlet second = 2\nexit");
  const result = run(compiled, createFreshRuntimeSnapshot(compiled), {}, {
    instructionBudget: 1,
  });

  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.failure?.code, "TSR037");
  assert.deepEqual(result.events.map((event) => event.kind), ["runtimeFailure"]);
});

function plan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function rootValue(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const binding = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(binding !== undefined);
  return binding.value;
}

function objectProperty(
  object: SerializableRuntimeObject,
  name: string,
): SerializableRuntimeValue {
  const property = object.properties.find((item) => item.name === name);
  assert.ok(property !== undefined);
  return property.value;
}

function assertCheckpointCode(value: unknown, code: string): void {
  assert.throws(() => restoreCheckpoint(value), (error: unknown) => {
    return error instanceof CheckpointError && error.info.code === code;
  });
}
