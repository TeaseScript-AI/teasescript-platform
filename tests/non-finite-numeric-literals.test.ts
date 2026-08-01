import assert from "node:assert/strict";
import test from "node:test";

import type { Program } from "../src/ast.js";
import { compileSource } from "../src/compiler.js";
import {
  compileProgram,
  InstructionCompilationError,
} from "../src/compiler/compile-program.js";
import { parse } from "../src/parser.js";
import type { SourceSpan } from "../src/source.js";

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
