import assert from "node:assert/strict";
import test from "node:test";

import type { Program } from "../src/ast.js";
import { compileSource } from "../src/compiler.js";
import {
  compileProgram,
  InstructionCompilationError,
} from "../src/plan/model.js";
import { parse } from "../src/parser.js";
import type { SourceSpan } from "../src/source.js";
import {
  execute,
  InterpreterCompilationError,
  type RandomSource,
} from "../src/runtime/interpreter.js";

for (const source of [
  "let value = 1e999\nexit",
  "let value = -1e999\nexit",
]) {
  test(`rejects non-finite numeric literal in ${JSON.stringify(source)}`, () => {
    const result = compileSource(source);
    const literalStart = source.indexOf("1e999");

    assert.equal(result.plan, null);
    assert.equal(result.parserDiagnostics.length, 1);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, "TSC001");
    assert.match(result.diagnostics[0]?.message ?? "", /finite/u);
    assert.deepEqual(
      [
        result.diagnostics[0]?.span.start.offset,
        result.diagnostics[0]?.span.end.offset,
      ],
      [literalStart, literalStart + "1e999".length],
    );
  });
}

test("preserves large finite scientific notation", () => {
  const result = compileSource("let value = 1e308\nexit");

  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
});

for (const [name, source, value] of [
  ["Infinity", "let value = 1\nexit", Infinity],
  ["-Infinity", "say 1\nexit", -Infinity],
  ["NaN", "let values = [1]\nsay values\nexit", NaN],
] as const) {
  test(`direct AST execution rejects ${name} before runtime setup`, () => {
    const program = mutableProgram(source);
    const literal = numberLiterals(program).at(-1)!;
    literal.value = value;
    let randomCalls = 0;
    const random: RandomSource = {
      next: () => {
        randomCalls += 1;
        return 0;
      },
    };

    assert.throws(() => execute(program, { random }), (error: unknown) => {
      assert.ok(error instanceof InterpreterCompilationError);
      assert.deepEqual(error.diagnostics.map((diagnostic) => diagnostic.code), ["TSC001"]);
      assert.deepEqual(error.diagnostics[0]?.span, literal.span);
      return true;
    });
    assert.equal(randomCalls, 0);
  });
}

test("direct AST execution reports nested and multiple non-finite literals once in source order", () => {
  const program = mutableProgram("let values = [1, [2]]\nsay unknown");
  const literals = numberLiterals(program);
  literals[0]!.value = Infinity;
  literals[1]!.value = NaN;

  assert.throws(() => execute(program, { random: { next: () => 0 } }), (error: unknown) => {
    assert.ok(error instanceof InterpreterCompilationError);
    assert.deepEqual(
      error.diagnostics.map((diagnostic) => diagnostic.code),
      ["TSC001", "TSC001", "TSV002"],
    );
    assert.deepEqual(
      error.diagnostics.slice(0, 2).map((diagnostic) => diagnostic.span),
      [literals[0]!.span, literals[1]!.span],
    );
    return true;
  });
});

test("direct lowering rejects a non-finite literal with a structured compiler error", () => {
  const program = mutableProgram("let value = 1\nexit");
  const literal = numberLiterals(program)[0]!;
  literal.value = Infinity;

  assert.throws(() => compileProgram(program), (error: unknown) => {
    assert.ok(error instanceof InstructionCompilationError);
    assert.equal(error.code, "TSC001");
    assert.deepEqual(error.span, literal.span);
    return true;
  });
});

test("valid manually constructed AST programs remain executable", () => {
  const result = execute(mutableProgram("say 1\nexit"), {
    random: { next: () => 0 },
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.exited, true);
});

function mutableProgram(source: string): Program {
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  return JSON.parse(JSON.stringify(parsed.program)) as Program;
}

interface MutableNumberLiteral {
  value: number;
  span: SourceSpan;
}

function numberLiterals(program: Program): MutableNumberLiteral[] {
  const literals: MutableNumberLiteral[] = [];
  visit(program);
  return literals;

  function visit(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as { kind?: unknown; value?: unknown; span?: unknown };
    if (node.kind === "numberLiteral" && typeof node.value === "number") {
      literals.push(node as MutableNumberLiteral);
    }
    Object.values(value).forEach(visit);
  }
}
