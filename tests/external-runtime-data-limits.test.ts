import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  restoreCheckpoint,
  validateInstructionPlan,
  validateRuntimeSnapshot,
  type InstructionPlan,
  type RuntimeCheckpoint,
  type RuntimeSnapshot,
} from "../src/index.js";

const FAILING_BEFORE_DEPTH = 20_000;

function plan(): InstructionPlan {
  const result = compileSource("exit");
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function deepArray(depth: number): unknown {
  return JSON.parse(`${"[".repeat(depth)}0${"]".repeat(depth)}`) as unknown;
}

function deepSerializableListJson(depth: number): string {
  return `${'{"kind":"list","items":['.repeat(depth)}"leaf"${"]}".repeat(depth)}`;
}

function deepSerializableList(depth: number): unknown {
  return JSON.parse(deepSerializableListJson(depth)) as unknown;
}

function mutablePlan(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(plan())) as Record<string, unknown>;
}

function mutableSnapshot(compiled: InstructionPlan): RuntimeSnapshot {
  return JSON.parse(
    JSON.stringify(createFreshRuntimeSnapshot(compiled)),
  ) as RuntimeSnapshot;
}

test("failing-before: validateInstructionPlan does not leak stack overflow", () => {
  const value = mutablePlan();
  value.padding = deepArray(FAILING_BEFORE_DEPTH);
  assert.doesNotThrow(() => validateInstructionPlan(value));
});

test("failing-before: validateRuntimeSnapshot does not leak stack overflow", () => {
  const compiled = plan();
  const snapshot = mutableSnapshot(compiled) as RuntimeSnapshot & {
    frames: Array<{ bindings: Array<{ name: string; value: unknown }> }>;
  };
  snapshot.frames[0]!.bindings.push({
    name: "deep",
    value: deepSerializableList(FAILING_BEFORE_DEPTH),
  });
  assert.doesNotThrow(() => validateRuntimeSnapshot(snapshot, compiled));
});

test("failing-before: restoreCheckpoint does not leak stack overflow", () => {
  const compiled = plan();
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled))),
  ) as RuntimeCheckpoint & {
    plan: Record<string, unknown>;
  };
  checkpoint.plan.padding = deepArray(FAILING_BEFORE_DEPTH);
  assert.doesNotThrow(() => restoreCheckpoint(checkpoint));
});

test("failing-before: deserializeCheckpoint does not leak stack overflow", () => {
  const compiled = plan();
  const checkpoint = {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: compiled,
    snapshot: mutableSnapshot(compiled),
  } as RuntimeCheckpoint & {
    snapshot: RuntimeSnapshot & {
      frames: Array<{ bindings: Array<{ name: string; value: unknown }> }>;
    };
  };
  checkpoint.snapshot.frames[0]!.bindings.push({
    name: "deep",
    value: "__DEEP_VALUE__",
  });
  const json = JSON.stringify(checkpoint).replace(
    '"__DEEP_VALUE__"',
    deepSerializableListJson(FAILING_BEFORE_DEPTH),
  );
  assert.doesNotThrow(() => deserializeCheckpoint(json));
});
