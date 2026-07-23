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
  const result = compileSource([
    "repeat 2 {",
    "  while true {",
    "    break",
    "  }",
    "  continue",
    "}",
  ].join("\n"));

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
    'let bad = "a"..3',
    "for value in 1.5..3 { say value }",
    "repeat -1 { say \"never\" }",
    "repeat 1.5 { say \"never\" }",
    'repeat "twice" { say "never" }',
  ];
  for (const source of cases) {
    const result = compileSource(source);
    assert.equal(result.plan, null);
    assert.ok(result.semanticDiagnostics.some((item) =>
      item.code === "TSV010" || item.code === "TSV011"
    ));
  }
});

test("semantic range validation detects chained ASTs independently", () => {
  const result = compileSource("let bad = (1..2)..3");

  assert.equal(result.plan, null);
  assert.ok(
    result.parserDiagnostics.some((item) => item.code === "TSP022") ||
      result.semanticDiagnostics.some((item) =>
        item.code === "TSV009" || item.code === "TSV010"
      ),
  );
});

test("recognizes and protects the core random built-ins", () => {
  assert.deepEqual(compileSource("say random()").diagnostics, []);
  const shadowed = compileSource("let random = 1");
  assert.equal(shadowed.plan, null);
  assert.ok(shadowed.semanticDiagnostics.some((item) => item.code === "TSV001"));
});
