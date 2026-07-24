import assert from "node:assert/strict";
import test from "node:test";

import { compileProgram } from "../src/instructions.js";
import { parse } from "../src/parser.js";

const source = [
  "function identity(value) { return value }",
  "identity(1, 2)",
].join("\n");

test("function-call lowering reports a controlled missing-parameter error", () => {
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  const secondArgumentStart = source.lastIndexOf("2");

  assert.throws(() => compileProgram(parsed.program), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "InstructionCompilationError");
    assert.equal(error instanceof TypeError, false);
    assert.equal((error as { code?: string }).code, "TSC003");
    assert.match(error.message, /positional argument 2/u);
    const span = (error as {
      span?: { start: { offset: number }; end: { offset: number } };
    }).span;
    assert.deepEqual(
      span === undefined
        ? null
        : [span.start.offset, span.end.offset],
      [secondArgumentStart, secondArgumentStart + 1],
    );
    return true;
  });
});
