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

test("rejects core and injected builtin identifiers in ordinary value positions", () => {
  const cases = [
    ["declaration initializer", "let value = BUILTIN"],
    ["list literal", "let values = [BUILTIN]"],
    ["object property value", "let value = { callback: BUILTIN }"],
    ["template interpolation", "say `${BUILTIN}`"],
    [
      "function parameter default",
      "function sample(value = BUILTIN) { return value }",
    ],
    ["return expression", "function sample { return BUILTIN }"],
    ["parenthesized expression", "let value = (BUILTIN)"],
    ["parenthesized call callee", "let value = (BUILTIN)()"],
    [
      "call argument",
      "function consume(value) { return value }\nlet result = consume(BUILTIN)",
    ],
    ["binary expression", "let value = BUILTIN + 1"],
    ["property receiver", "let value = BUILTIN.length"],
    ["index receiver", "let value = BUILTIN[0]"],
  ] as const;

  for (const [label, template] of cases) {
    for (const builtin of ["random", "customBuiltin"] as const) {
      const source = template.replace("BUILTIN", builtin);
      const result = compileSource(source, {
        ...(builtin === "customBuiltin" ? { builtins: [builtin] } : {}),
      });
      const start = source.indexOf(builtin);

      assert.deepEqual(result.parserDiagnostics, [], `${label}: ${source}`);
      assert.equal(result.plan, null, `${label}: ${source}`);
      assert.deepEqual(
        result.semanticDiagnostics.map((diagnostic) => [
          diagnostic.code,
          diagnostic.message,
          diagnostic.span.start.offset,
          diagnostic.span.end.offset,
        ]),
        [[
          "TSV028",
          `Builtin '${builtin}' is not a first-class runtime value.`,
          start,
          start + builtin.length,
        ]],
        `${label}: ${source}`,
      );
    }
  }
});

test("reports each invalid builtin value once in deterministic source order", () => {
  const source = "let values = [random, customBuiltin, random]";
  const result = compileSource(source, { builtins: ["customBuiltin"] });
  const names = ["random", "customBuiltin", "random"] as const;
  let offset = 0;
  const expected = names.map((name) => {
    const start = source.indexOf(name, offset);
    offset = start + name.length;
    return [
      "TSV028",
      `Builtin '${name}' is not a first-class runtime value.`,
      start,
      start + name.length,
    ];
  });

  assert.deepEqual(result.parserDiagnostics, []);
  assert.equal(result.plan, null);
  assert.deepEqual(
    result.semanticDiagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    expected,
  );
});

test("preserves direct builtin calls in every supported nested context", () => {
  const result = compileSource([
    "let values = [random(), chance(50), randomInteger(1..=6), customBuiltin()]",
    "let objectValue = { core: random(), injected: customBuiltin() }",
    "say `${random()}:${customBuiltin()}`",
    "function sample(core = random(), injected = customBuiltin()) {",
    "  return core",
    "}",
    "let result = sample()",
    "values.remove(1)",
  ].join("\n"), { builtins: ["customBuiltin"] });

  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
});

test("preserves existing function, unknown-name, callable, and protected-name diagnostics", () => {
  const functionValue = compileSource([
    "function sample { return 1 }",
    "let stored = sample",
  ].join("\n"));
  assert.deepEqual(
    functionValue.semanticDiagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
    ]),
    [["TSV028", "Function 'sample' is not a first-class runtime value."]],
  );

  const unknownVariable = compileSource("let value = missing");
  assert.deepEqual(
    unknownVariable.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV002"],
  );

  const unknownFunction = compileSource("missing()");
  assert.deepEqual(
    unknownFunction.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV018"],
  );

  const nonCallable = compileSource("let value = 1\nvalue()");
  assert.deepEqual(
    nonCallable.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV019"],
  );

  const protectedCore = compileSource("let random = 1");
  assert.deepEqual(
    protectedCore.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV001"],
  );

  const protectedInjected = compileSource("let customBuiltin = 1", {
    builtins: ["customBuiltin"],
  });
  assert.deepEqual(
    protectedInjected.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV001"],
  );
});
