import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  cloneSerializableValue,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  restoreCheckpoint,
  validateInstructionPlan,
  validateRuntimeSnapshot,
  type InstructionPlan,
  type RuntimeCheckpoint,
  type RuntimeSnapshot,
} from "../src/index.js";
import { captureExternalData } from "../src/external-data-limits.js";
import { SerializableValueError } from "../src/runtime/serializable-values.js";

function compiledPlan(): InstructionPlan {
  const compiled = compileSource("exit");
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
}

function mutable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withArrayPrototypeIndex(
  descriptor: PropertyDescriptor,
  operation: () => void,
): void {
  const previous = Reflect.getOwnPropertyDescriptor(Array.prototype, "0");
  Reflect.defineProperty(Array.prototype, "0", {
    configurable: true,
    enumerable: false,
    ...descriptor,
  });
  try {
    operation();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(Array.prototype, "0");
    else Reflect.defineProperty(Array.prototype, "0", previous);
  }
}

test("captured sparse arrays ignore inherited numeric values", () => {
  const sparse = new Array<unknown>(1);
  withArrayPrototypeIndex(
    { value: "inherited", writable: true },
    () => {
      const captured = captureExternalData(sparse);
      assert.equal(captured.ok, true);
      if (!captured.ok) return;
      assert.equal(Array.isArray(captured.value), true);
      assert.notEqual(Object.getPrototypeOf(captured.value), Array.prototype);
      assert.equal(Object.hasOwn(captured.value as object, 0), false);
      assert.equal(0 in (captured.value as unknown[]), false);
      assert.equal(typeof (captured.value as unknown[]).map, "function");
    },
  );
});

test("inherited numeric getters are never invoked across captured-data boundaries", () => {
  const plan = compiledPlan();
  const malformedPlan = mutable(plan) as unknown as Record<string, unknown>;
  malformedPlan.instructions = new Array(1);

  const malformedSnapshot = mutable(createFreshRuntimeSnapshot(plan));
  (malformedSnapshot as unknown as { frames: unknown[] }).frames = new Array(1);

  const malformedCheckpoint = mutable(
    createCheckpoint(plan, createFreshRuntimeSnapshot(plan)),
  ) as RuntimeCheckpoint;
  (malformedCheckpoint.snapshot as unknown as { frames: unknown[] }).frames = new Array(1);

  const serializable = {
    kind: "list",
    items: new Array(1),
  };
  let getterCalls = 0;
  const setter = function(this: unknown[], value: unknown): void {
    Reflect.defineProperty(this, "0", {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };
  withArrayPrototypeIndex(
    {
      get() {
        getterCalls += 1;
        return "inherited";
      },
      set: setter,
    },
    () => {
      assert.equal(validateInstructionPlan(malformedPlan).valid, false);
      assert.equal(
        validateRuntimeSnapshot(malformedSnapshot as RuntimeSnapshot, plan).valid,
        false,
      );
      assert.throws(() => restoreCheckpoint(malformedCheckpoint), CheckpointError);
      assert.throws(
        () => cloneSerializableValue(serializable as never),
        SerializableValueError,
      );
    },
  );
  assert.equal(getterCalls, 0);
});
