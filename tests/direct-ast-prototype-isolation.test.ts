import assert from "node:assert/strict";
import test from "node:test";

import type { Program } from "../src/ast.js";
import { captureProgramAst } from "../src/ast-validation.js";
import {
  InstructionCompilationError,
  compileProgram,
} from "../src/compiler/compile-program.js";
import { parse } from "../src/parser.js";

function mutableProgram(source: string): Program & Record<string, unknown> {
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  return JSON.parse(JSON.stringify(parsed.program)) as Program & Record<string, unknown>;
}

test("captured AST roots ignore inherited Object.prototype data and getters", () => {
  const program = mutableProgram("exit");
  delete (program as Record<string, unknown>).kind;
  let getterCalls = 0;
  Object.defineProperty(Object.prototype, "kind", {
    configurable: true,
    get() {
      getterCalls += 1;
      return "program";
    },
  });
  try {
    assert.throws(
      () => compileProgram(program),
      (error: unknown) =>
        error instanceof InstructionCompilationError && error.code === "TSC005",
    );
    assert.equal(getterCalls, 0);
  } finally {
    delete (Object.prototype as Record<string, unknown>).kind;
  }
});

test("captured nested AST records have no ambient object prototype", () => {
  const program = mutableProgram("say 1");
  const statement = program.statements[0] as unknown as Record<string, unknown>;
  const literal = statement.value as Record<string, unknown>;
  delete literal.value;
  let getterCalls = 0;
  Object.defineProperty(Object.prototype, "value", {
    configurable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  try {
    const captured = captureProgramAst(program);
    assert.notEqual(captured.program, null);
    const capturedStatement = captured.program!.statements[0] as unknown as Record<string, unknown>;
    const capturedLiteral = capturedStatement.value as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(capturedLiteral), null);
    assert.equal(Object.hasOwn(capturedLiteral, "value"), false);
    assert.equal(capturedLiteral.value, undefined);
    assert.equal(getterCalls, 0);
  } finally {
    delete (Object.prototype as Record<string, unknown>).value;
  }
});

test("AST array staging and output bypass inherited numeric setters", () => {
  const program = mutableProgram("exit\nexit\nexit\nexit");
  let setterCalls = 0;
  Object.defineProperty(Array.prototype, "3", {
    configurable: true,
    set() {
      setterCalls += 1;
      throw new Error("inherited numeric setter must not run");
    },
  });
  let captured: ReturnType<typeof captureProgramAst>;
  try {
    captured = captureProgramAst(program);
  } finally {
    delete (Array.prototype as unknown as Record<string, unknown>)["3"];
  }
  assert.notEqual(captured!.program, null);
  assert.equal(captured!.program!.statements.length, 4);
  assert.equal(Object.hasOwn(captured!.program!.statements, 3), true);
  assert.equal(setterCalls, 0);
});

test("direct AST source positions reject non-safe integers", () => {
  const program = mutableProgram("exit");
  (program.span.start as unknown as { offset: number }).offset = Number.MAX_SAFE_INTEGER + 1;

  const captured = captureProgramAst(program);

  assert.equal(captured.program, null);
  assert.equal(captured.diagnostic?.code, "TSC005");
});
