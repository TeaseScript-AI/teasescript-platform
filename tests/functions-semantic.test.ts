import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

test("collects top-level functions before validating calls and mutual recursion", () => {
  const result = compileSource([
    "let result = first(3)",
    "function first(input) {",
    "  if input == 0 { return 0 }",
    "  return second(input - 1)",
    "}",
    "function second(input) {",
    "  if input == 0 { return 0 }",
    "  return first(input - 1)",
    "}",
  ].join("\n"));

  assert.deepEqual(result.diagnostics, []);
});

test("rejects duplicate functions, parameters, and nested declarations", () => {
  const result = compileSource([
    "function same(value, value) {",
    "  function nested { return }",
    "}",
    "function same { return }",
  ].join("\n"));

  assert.equal(result.plan, null);
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV013"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV014"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV016"));
});

test("rejects return outside functions and required parameters after defaults", () => {
  const result = compileSource([
    "return 1",
    "function invalid(first = 1, second) { return second }",
  ].join("\n"));

  assert.deepEqual(
    result.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV017", "TSV015"],
  );
});

test("validates positional and named user-function arguments", () => {
  const sources = [
    ["function greet(name, title = \"pet\") {}\ngreet()", "TSV020"],
    ["function greet(name) {}\ngreet(\"A\", \"B\")", "TSV020"],
    ["function greet(name) {}\ngreet(other: \"A\")", "TSV022"],
    ["function greet(name) {}\ngreet(name: \"A\", name: \"B\")", "TSV023"],
    ["function greet(name, title = \"pet\") {}\ngreet(title: \"pet\")", "TSV024"],
  ] as const;
  for (const [source, code] of sources) {
    const result = compileSource(source);
    assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === code), source);
  }
});

test("rejects later-parameter defaults, function assignment, values, and unknown calls", () => {
  const result = compileSource([
    "function greet(name = title, title = \"pet\") { return name }",
    "greet = 1",
    "let stored = greet",
    "missing()",
  ].join("\n"));

  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV025"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV026"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV028"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV018"));
});

test("function scopes access globals but keep parameters and locals isolated", () => {
  const valid = compileSource([
    "let total = 0",
    "function add(value) {",
    "  let local = value",
    "  total = total + local",
    "}",
    "add(2)",
  ].join("\n"));
  assert.deepEqual(valid.diagnostics, []);

  const escaped = compileSource([
    "function define(value) { let local = value }",
    "say local",
  ].join("\n"));
  assert.ok(escaped.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV002"));
});

test("rejects calls to non-callable variables", () => {
  const result = compileSource("let value = 1\nvalue()");

  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV019"));
});
