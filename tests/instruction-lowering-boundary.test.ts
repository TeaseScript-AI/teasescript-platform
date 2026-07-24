import assert from "node:assert/strict";
import test from "node:test";

import {
  compileProgram,
  InstructionCompilationError,
} from "../src/instructions.js";
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
    assert.ok(error instanceof InstructionCompilationError);
    assert.equal(error instanceof TypeError, false);
    assert.equal(error.code, "TSC003");
    assert.match(error.message, /positional argument 2/u);
    assert.deepEqual(
      [error.span.start.offset, error.span.end.offset],
      [secondArgumentStart, secondArgumentStart + 1],
    );
    return true;
  });
});
