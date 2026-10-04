import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

test("rejects break and continue outside loops", () => {
  for (const source of ["break", "continue", "if true { break }"]) {
    const result = compileSource(source);
    assert.equal(result.plan, null);
    assert.ok(result.semanticDiagnostics.some((item) => item.code === "TSV008"));
  }
});

test("accepts loop control in nested loops", () => {
  const result = compileSource(
    ["repeat 2 {", "  while true {", "    break", "  }", "  continue", "}", "exit"].join("\n"),
  );

  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
});

test("validates loop sources and body identifiers", () => {
  const source = compileSource("for item in missing { say alsoMissing }");

  assert.equal(source.plan, null);
  assert.deepEqual(
    source.semanticDiagnostics.map((item) => item.code),
    ["TSV002", "TSV002"],
  );
});

test("rejects statically known non-iterable loop sources", () => {
  for (const source of ["for item in 1 { say item }", 'for item in "text" { say item }']) {
    const result = compileSource(source);
    assert.equal(result.plan, null);
    assert.ok(result.semanticDiagnostics.some((item) => item.code === "TSV012"));
  }
});

test("loop variables have lexical scope and conflict with visible names", () => {
  const escaped = compileSource("for item in [1] { say item }\nsay item");
  assert.ok(escaped.semanticDiagnostics.some((item) => item.code === "TSV002"));

  const duplicate = compileSource("let item = 1\nfor item in [2] { say item }");
  assert.ok(duplicate.semanticDiagnostics.some((item) => item.code === "TSV001"));
});

test("rejects statically invalid range operands and repeat counts", () => {
  const cases = [
    ['let bad = "a"..3', "TSV010"],
    ["for value in 1.5..3 { say value }", "TSV010"],
    ['repeat -1 { say "never" }', "TSV011"],
    ['repeat 1.5 { say "never" }', "TSV011"],
    ['repeat "twice" { say "never" }', "TSV011"],
  ] as const;
  for (const [source, code] of cases) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.deepEqual(
      result.semanticDiagnostics.map((item) => item.code),
      [code],
      source,
    );
  }
});

test("rejects a range-valued bound through semantic validation", () => {
  // The parenthesized start parses as an ordinary bound; semantic validation rejects its range value.
  const result = compileSource("let bad = (1..2)..3");

  assert.equal(result.plan, null);
  assert.deepEqual(result.parserDiagnostics, []);
  assert.deepEqual(
    result.semanticDiagnostics.map((item) => item.code),
    ["TSV010"],
  );
});
