import assert from "node:assert/strict";
import test from "node:test";

import type { Program } from "../src/ast.js";
import { parse } from "../src/parser.js";
import {
  InstructionCompilationError,
  compileProgram,
} from "../src/compiler/compile-program.js";
import {
  InterpreterCompilationError,
  execute,
  type BuiltinFunction,
} from "../src/runtime/interpreter.js";

function parsed(source = "exit"): Program {
  const result = parse(source);
  assert.deepEqual(result.diagnostics, []);
  return result.program;
}

function mutable(source = "exit"): Program & Record<string, unknown> {
  return structuredClone(parsed(source)) as Program & Record<string, unknown>;
}

function assertCompatibilityRejected(
  program: Program,
  expectedCode = "TSC005",
): void {
  let randomCalls = 0;
  let builtinCalls = 0;
  const builtin: BuiltinFunction = () => {
    builtinCalls += 1;
    return null;
  };
  assert.throws(
    () => execute(program, {
      random: { next: () => { randomCalls += 1; return 0.5; } },
      builtins: { hostileBuiltin: builtin },
    }),
    (error: unknown) =>
      error instanceof InterpreterCompilationError &&
      error.diagnostics[0]?.code === expectedCode,
  );
  assert.equal(randomCalls, 0);
  assert.equal(builtinCalls, 0);
}

test("direct AST cycles are rejected before recursive validation or execution", () => {
  const program = mutable();
  program.self = program;
  assertCompatibilityRejected(program);
  assert.throws(
    () => compileProgram(program),
    (error: unknown) =>
      error instanceof InstructionCompilationError && error.code === "TSC005",
  );
});

test("direct AST accessors are rejected without invocation", () => {
  const program = mutable();
  let getterCalls = 0;
  Object.defineProperty(program, "hostile", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return null;
    },
  });
  assertCompatibilityRejected(program);
  assert.equal(getterCalls, 0);
});

test("direct AST proxy traps and non-plain objects are typed input failures", () => {
  const throwing = new Proxy(mutable(), {
    ownKeys() {
      throw new Error("host trap");
    },
  });
  assertCompatibilityRejected(throwing);

  const nonPlain = mutable();
  nonPlain.hostile = new Date();
  assertCompatibilityRejected(nonPlain);
});

test("direct AST depth and width are bounded before descriptor traversal", () => {
  const deep = mutable();
  let current: Record<string, unknown> = deep;
  for (let index = 0; index < 140; index += 1) {
    const nested: Record<string, unknown> = {};
    current.extra = nested;
    current = nested;
  }
  assertCompatibilityRejected(deep);

  const keys = Array.from({ length: 100_001 }, (_, index) => `key${index}`);
  let descriptorCalls = 0;
  const wide = new Proxy(Object.create(null) as Program, {
    ownKeys: () => keys,
    getOwnPropertyDescriptor: () => {
      descriptorCalls += 1;
      return { value: null, enumerable: true, configurable: true, writable: true };
    },
  });
  assertCompatibilityRejected(wide);
  assert.equal(descriptorCalls, 0);
});

test("valid direct AST behavior and diagnostic priority remain unchanged", () => {
  const valid = parsed('say "visible"');
  const result = execute(valid, { random: { next: () => 0.5 } });
  assert.deepEqual(result.events.map((event) => event.kind), ["say"]);

  const nonFinite = mutable("let value = 1\nsay missing");
  const declaration = nonFinite.statements[0] as unknown as {
    initializer: { value: number };
  };
  declaration.initializer.value = Number.NaN;
  assertCompatibilityRejected(nonFinite, "TSC001");

  const wait = parsed("wait 1 ms");
  assertCompatibilityRejected(wait, "TSC004");
});
