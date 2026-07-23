import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

test("reports unknown variables and withholds an executable plan", () => {
  const result = compileSource("let score = missing + 1");

  assert.deepEqual(result.parserDiagnostics, []);
  assert.deepEqual(result.semanticDiagnostics.map((item) => item.code), ["TSV002"]);
  assert.equal(result.plan, null);
});

test("rejects declarations that duplicate a visible name", () => {
  const result = compileSource([
    "let score = 1",
    "if true {",
    "  let score = 2",
    "}",
  ].join("\n"));

  assert.deepEqual(result.semanticDiagnostics.map((item) => item.code), ["TSV001"]);
});

test("reports assignment to unknown variables and invalid binding replacement", () => {
  const result = compileSource([
    "missing = 1",
    "speaker vera {}",
    "vera = 2",
  ].join("\n"));

  assert.deepEqual(result.semanticDiagnostics.map((item) => item.code), [
    "TSV003",
    "TSV004",
  ]);
});

test("reports unknown speaker references", () => {
  const result = compileSource([
    "speaker missing",
    'say as other "Hello"',
  ].join("\n"));

  assert.deepEqual(result.semanticDiagnostics.map((item) => item.code), [
    "TSV005",
    "TSV005",
  ]);
});

test("accepts nested lexical access and sibling-local reuse", () => {
  const result = compileSource([
    "let score = 1",
    "if true {",
    "  let first = score + 1",
    "  score = first",
    "}",
    "if false {",
    "  let local = score",
    "} else {",
    "  let local = score + 1",
    "}",
    "exit",
  ].join("\n"));

  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
});

test("detects definitely invalid set elements without full type checking", () => {
  const result = compileSource("let values = set[[1], { value: 2 }, set[3]]");

  assert.deepEqual(result.semanticDiagnostics.map((item) => item.code), [
    "TSV006",
    "TSV006",
    "TSV006",
  ]);
});

test("keeps parser and semantic diagnostics distinct", () => {
  const parserFailure = compileSource("let = 1");
  assert.ok(parserFailure.parserDiagnostics.length > 0);
  assert.deepEqual(parserFailure.semanticDiagnostics, []);

  const semanticFailure = compileSource("say unknownName");
  assert.deepEqual(semanticFailure.parserDiagnostics, []);
  assert.deepEqual(
    semanticFailure.semanticDiagnostics.map((item) => item.code),
    ["TSV002"],
  );
});

test("accepts explicitly declared injected built-ins and globals", () => {
  const result = compileSource("capture(player)", {
    builtins: ["capture"],
    globals: ["player"],
  });

  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
});
