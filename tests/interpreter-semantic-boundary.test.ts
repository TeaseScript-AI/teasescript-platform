import assert from "node:assert/strict";
import test from "node:test";

import type { Program } from "../src/ast.js";
import { parse } from "../src/parser.js";
import {
  execute,
  InterpreterCompilationError,
  type BuiltinFunction,
  type RandomSource,
} from "../src/runtime/interpreter.js";
import {
  createRuntimeObject,
  type RuntimeValue,
} from "../src/runtime/values.js";

const random: RandomSource = { next: () => 0 };

const invalidCalls = [
  {
    name: "too many positional arguments",
    source: [
      "function identity(value) { return value }",
      "identity(1, 2)",
    ].join("\n"),
    code: "TSV020",
  },
  {
    name: "mixed positional and named arguments",
    source: [
      "function pair(left, right) { return left + right }",
      "pair(1, right: 2)",
    ].join("\n"),
    code: "TSV021",
  },
  {
    name: "unknown named arguments",
    source: [
      "function identity(value) { return value }",
      "identity(other: 1)",
    ].join("\n"),
    code: "TSV022",
  },
  {
    name: "duplicate named arguments",
    source: [
      "function identity(value) { return value }",
      "identity(value: 1, value: 2)",
    ].join("\n"),
    code: "TSV023",
  },
  {
    name: "missing required named arguments",
    source: [
      "function pair(left, right = 2) { return left + right }",
      "pair(right: 2)",
    ].join("\n"),
    code: "TSV024",
  },
] as const;

for (const invalidCall of invalidCalls) {
  test(`direct AST execution rejects ${invalidCall.name} with diagnostics`, () => {
    const program = parseProgram(invalidCall.source);

    assert.throws(() => execute(program, { random }), (error: unknown) => {
      assert.ok(error instanceof InterpreterCompilationError);
      assert.equal(error instanceof TypeError, false);
      assert.ok(
        error.diagnostics.some(
          (diagnostic) => diagnostic.code === invalidCall.code,
        ),
        JSON.stringify(error.diagnostics),
      );
      return true;
    });
  });
}

test("direct AST validation includes configured globals and builtins", () => {
  const player = createRuntimeObject(
    new Map<string, RuntimeValue>([["alias", "puppy"]]),
  );
  const captured: RuntimeValue[] = [];
  const capture: BuiltinFunction = (call) => {
    captured.push(call.positional[0] ?? null);
    return null;
  };
  const program = parseProgram("capture(player.alias)");

  const result = execute(program, {
    random,
    builtins: { capture },
    globals: { player },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, ["puppy"]);
});

function parseProgram(source: string): Program {
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.program;
}
