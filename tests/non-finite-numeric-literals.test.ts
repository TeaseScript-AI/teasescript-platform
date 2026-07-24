import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

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
