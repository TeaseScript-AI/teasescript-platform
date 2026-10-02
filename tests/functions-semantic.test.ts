import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { createFreshRuntimeSnapshot, run } from "../src/index.js";
import { TEASESCRIPT_PROTECTED_NAMES } from "../src/protected-names.js";

test("collects top-level functions before validating calls and mutual recursion", () => {
  const result = compileSource(
    [
      "let result = first(3)",
      "function first(input) {",
      "  if input == 0 { return 0 }",
      "  return second(input - 1)",
      "}",
      "function second(input) {",
      "  if input == 0 { return 0 }",
      "  return first(input - 1)",
      "}",
    ].join("\n"),
  );

  assert.deepEqual(result.diagnostics, []);
});

test("rejects duplicate functions, parameters, and nested declarations", () => {
  const result = compileSource(
    [
      "function same(value, value) {",
      "  function nested { return }",
      "}",
      "function same { return }",
    ].join("\n"),
  );

  assert.equal(result.plan, null);
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV013"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV014"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV016"));
});

test("rejects return outside functions and required parameters after defaults", () => {
  const result = compileSource(
    ["return 1", "function invalid(first = 1, second) { return second }"].join("\n"),
  );

  assert.deepEqual(
    result.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV017", "TSV015"],
  );
});

test("validates positional and named user-function arguments", () => {
  const sources = [
    ['function greet(name, title = "pet") {}\ngreet()', "TSV020"],
    ['function greet(name) {}\ngreet("A", "B")', "TSV020"],
    ['function greet(name) {}\ngreet(other: "A")', "TSV022"],
    ['function greet(name) {}\ngreet(name: "A", name: "B")', "TSV023"],
    ['function greet(name, title = "pet") {}\ngreet(title: "pet")', "TSV024"],
  ] as const;
  for (const [source, code] of sources) {
    const result = compileSource(source);
    assert.ok(
      result.semanticDiagnostics.some((diagnostic) => diagnostic.code === code),
      source,
    );
  }
});

test("rejects later-parameter defaults, function assignment, values, and unknown calls", () => {
  const result = compileSource(
    [
      'function greet(name = title, title = "pet") { return name }',
      "greet = 1",
      "let stored = greet",
      "missing()",
    ].join("\n"),
  );

  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV025"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV026"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV028"));
  assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV018"));
});

test("keeps repeated parameter names in later-default reference tracking until their last occurrence", () => {
  const result = compileSource(
    "function repeated(value = value, value = final, final = 1) { return value }",
  );

  assert.deepEqual(
    result.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV014", "TSV025", "TSV002", "TSV025", "TSV002"],
  );
});

test("function scopes access globals but keep parameters and locals isolated", () => {
  const valid = compileSource(
    [
      "let total = 0",
      "function add(value) {",
      "  let local = value",
      "  total = total + local",
      "}",
      "add(2)",
    ].join("\n"),
  );
  assert.deepEqual(valid.diagnostics, []);

  const escaped = compileSource(
    ["function define(value) { let local = value }", "say local"].join("\n"),
  );
  assert.ok(escaped.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV002"));
});

test("rejects representative protected names across function, parameter and local declarations", () => {
  const protectedFunction = compileSource("function wait { return 1 }");
  assert.equal(protectedFunction.plan, null);
  assert.ok(
    protectedFunction.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV001"),
  );

  const protectedConversion = compileSource("function toString { return 2 }");
  assert.equal(protectedConversion.plan, null);
  assert.deepEqual(protectedConversion.parserDiagnostics, []);
  assert.ok(
    protectedConversion.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV001"),
  );

  const protectedParameter = compileSource("function sample(player) { return player }");
  assert.equal(protectedParameter.plan, null);
  assert.ok(
    protectedParameter.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV001"),
  );

  const protectedLocal = compileSource("function sample { let getDate = 1\nreturn getDate }");
  assert.equal(protectedLocal.plan, null);
  assert.ok(protectedLocal.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV001"));

  const protectedType = compileSource("function string { return 1 }");
  assert.equal(protectedType.plan, null);
  assert.ok(protectedType.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV001"));
});

test("allows timer spellings that are not TeaseScript syntax as ordinary identifiers", () => {
  for (const name of ["mysteryTimer", "startTimer", "stopTimer"]) {
    const result = compileSource(`let ${name} = 1`);
    assert.deepEqual(result.diagnostics, []);
    assert.notEqual(result.plan, null);
  }
});

test("a call to a protected name is rejected with located diagnostics or never fails as an unknown built-in", () => {
  for (const name of TEASESCRIPT_PROTECTED_NAMES) {
    const source = `${name}()`;
    const result = compileSource(source);
    if (result.plan === null) {
      assert.ok(result.diagnostics.length > 0, source);
      for (const diagnostic of result.diagnostics) {
        assert.match(diagnostic.code, /^TS[PV]\d{3}$/, source);
        const { start, end } = diagnostic.span;
        assert.ok(
          0 <= start.offset && start.offset <= end.offset && end.offset <= source.length,
          source,
        );
      }
      continue;
    }
    // A compiled call must not fail as an unknown built-in (TSR011); other structured runtime failures are allowed.
    const outcome = run(result.plan, createFreshRuntimeSnapshot(result.plan));
    assert.notEqual(outcome.snapshot.failure?.code, "TSR011", source);
  }
});

test("long unary defaults preserve validation without native semantic recursion", () => {
  const valid = compileSource(`function stable(value = ${"-".repeat(5_000)}1) { return value }`);
  assert.deepEqual(valid.diagnostics, []);

  const invalid = compileSource(
    `function later(value = ${"+".repeat(5_000)}other, other = 1) { return value }`,
  );
  assert.deepEqual(
    invalid.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV025", "TSV002"],
  );
});
