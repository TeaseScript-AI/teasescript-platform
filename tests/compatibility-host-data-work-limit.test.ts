import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_DATA_WORK_MESSAGE,
  MAX_EXTERNAL_RUNTIME_DATA_WORK,
} from "../src/external-data-limits.js";
import { parse } from "../src/parser.js";
import {
  Interpreter,
  type BuiltinFunction,
  type RandomSource,
} from "../src/runtime/interpreter.js";
import {
  SerializableValueError,
  fromHostRuntimeValue,
} from "../src/runtime/serializable-values.js";
import { createRuntimeList } from "../src/runtime/values.js";

function program() {
  const parsed = parse("exit");
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.program;
}

function oversizedRecord(): { value: Record<string, unknown>; descriptorCalls: () => number } {
  const keys = Array.from(
    { length: MAX_EXTERNAL_RUNTIME_DATA_WORK + 1 },
    (_, index) => `key${index}`,
  );
  let calls = 0;
  const value = new Proxy(Object.create(null) as Record<string, unknown>, {
    ownKeys: () => keys,
    getOwnPropertyDescriptor: () => {
      calls += 1;
      return { value: null, writable: true, enumerable: true, configurable: true };
    },
  });
  return { value, descriptorCalls: () => calls };
}

const random = (): RandomSource => ({ next: () => 0.5 });

test("compatibility options reject oversized keysets before descriptor iteration", () => {
  const oversized = oversizedRecord();
  assert.throws(
    () => new Interpreter(oversized.value as never),
    (error: unknown) => error instanceof TypeError && error.message === EXTERNAL_DATA_WORK_MESSAGE,
  );
  assert.equal(oversized.descriptorCalls(), 0);
});

test("compatibility globals and builtins reject oversized keysets before execution", () => {
  for (const field of ["globals", "builtins"] as const) {
    const oversized = oversizedRecord();
    let randomCalls = 0;
    const interpreter = new Interpreter({
      random: { next: () => { randomCalls += 1; return 0.5; } },
      [field]: oversized.value,
    } as never);
    assert.throws(
      () => interpreter.execute(program()),
      (error: unknown) => error instanceof TypeError && error.message === EXTERNAL_DATA_WORK_MESSAGE,
    );
    assert.equal(oversized.descriptorCalls(), 0, field);
    assert.equal(randomCalls, 0, field);
  }
});

test("compatibility globals share one recursive host-capture work budget", () => {
  const repeated = createRuntimeList(
    Array.from({ length: 2_000 }, () => null),
  );
  const globals = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`global${index}`, repeated]),
  );
  let randomCalls = 0;
  const parsed = parse("let sampled = random()\nexit");
  assert.deepEqual(parsed.diagnostics, []);
  const interpreter = new Interpreter({
    random: {
      next: () => {
        randomCalls += 1;
        return 0.5;
      },
    },
    globals,
  });
  assert.throws(
    () => interpreter.execute(parsed.program),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === EXTERNAL_DATA_WORK_MESSAGE,
  );
  assert.equal(randomCalls, 0);
});

test("compatibility builtin list results share the recursive key-work budget", () => {
  const extraKeys = Array.from(
    { length: MAX_EXTERNAL_RUNTIME_DATA_WORK + 1 },
    (_, index) => `extra${index}`,
  );
  let descriptorCalls = 0;
  const items = new Proxy([], {
    ownKeys: () => ["length", ...extraKeys],
    getOwnPropertyDescriptor: (_target, key) => {
      descriptorCalls += 1;
      if (key === "length") {
        return { value: 0, writable: true, enumerable: false, configurable: false };
      }
      return { value: null, writable: true, enumerable: true, configurable: true };
    },
  });
  const builtin: BuiltinFunction = () => ({ kind: "list", items } as never);
  const parsed = parse("provide()");
  assert.deepEqual(parsed.diagnostics, []);
  const interpreter = new Interpreter({ random: random(), builtins: { provide: builtin } });
  const result = interpreter.execute(parsed.program);
  assert.deepEqual(result.errors.map((error) => error.code), ["TSR013"]);
  assert.equal(result.errors[0]?.message, EXTERNAL_DATA_WORK_MESSAGE);
  assert.equal(descriptorCalls, 0);
});

test("direct host conversion preserves ordinary values and rejects oversized records", () => {
  assert.deepEqual(
    fromHostRuntimeValue(createRuntimeList(["a", 2, null])),
    { kind: "list", items: ["a", 2, null] },
  );
  const oversized = oversizedRecord();
  assert.throws(
    () => fromHostRuntimeValue(oversized.value as never),
    (error: unknown) =>
      error instanceof SerializableValueError &&
      error.code === "invalid" &&
      error.message === EXTERNAL_DATA_WORK_MESSAGE,
  );
  assert.equal(oversized.descriptorCalls(), 0);
});
