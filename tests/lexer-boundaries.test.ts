import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { lex } from "../src/lexer.js";
import { parse } from "../src/parser.js";
import { createFreshRuntimeSnapshot, run, type RuntimeBuiltinFunction } from "../src/index.js";
import { TokenKind, type Token } from "../src/token.js";

const prototypeSensitiveNames = [
  "valueOf",
  "constructor",
  "toString",
  "hasOwnProperty",
  "prototype",
  "__proto__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
] as const;

test("lexes prototype-sensitive names as ordinary identifiers with exact spans", () => {
  const source = prototypeSensitiveNames.join(" ");
  const result = lex(source);
  let offset = 0;
  assert.deepEqual(result.diagnostics, []);
  for (const [index, name] of prototypeSensitiveNames.entries()) {
    const token = result.tokens[index];
    assert.equal(token?.kind, TokenKind.Identifier, name);
    assert.equal(token?.lexeme, name, name);
    assert.equal(tokenValue(token), name, name);
    assert.deepEqual(
      token === undefined ? null : compactSpan(token),
      [offset, offset + name.length, 0, offset, 0, offset + name.length],
      name,
    );
    offset += name.length + 1;
  }
  assert.equal(result.tokens.at(-1)?.kind, TokenKind.EndOfFile);
});

test("preserves explicit keyword classification", () => {
  const result = lex("let say function return true false null and or not");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      TokenKind.KeywordLet,
      TokenKind.KeywordSay,
      TokenKind.KeywordFunction,
      TokenKind.KeywordReturn,
      TokenKind.KeywordTrue,
      TokenKind.KeywordFalse,
      TokenKind.KeywordNull,
      TokenKind.KeywordAnd,
      TokenKind.KeywordOr,
      TokenKind.KeywordNot,
      TokenKind.EndOfFile,
    ],
  );
});

test("parses and executes prototype-sensitive declarations and properties", () => {
  const source = [
    "let constructor = 1",
    "let valueOf = constructor + 1",
    "function hasOwnProperty(toLocaleString) {",
    "  return toLocaleString + valueOf",
    "}",
    "let result = hasOwnProperty(3)",
    "let object = { __proto__: result }",
    "say object.__proto__",
  ].join("\n");
  const parsed = parse(source);
  const compiled = compileSource(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  assert.deepEqual(
    parsed.program.statements.map((statement) => statement.kind),
    [
      "letStatement",
      "letStatement",
      "functionDeclaration",
      "letStatement",
      "letStatement",
      "sayStatement",
    ],
  );
  const execution = run(compiled.plan!, createFreshRuntimeSnapshot(compiled.plan!));
  assert.deepEqual(
    execution.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["5"],
  );
});

test("accepts prototype-sensitive configured globals and builtins", () => {
  const source = 'say "${constructor}:${valueOf()}"';
  const compiled = compileSource(source, { globals: ["constructor"], builtins: ["valueOf"] });
  const valueOf: RuntimeBuiltinFunction = () => "builtin";
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const execution = run(
    compiled.plan!,
    createFreshRuntimeSnapshot(compiled.plan!, { globals: { constructor: "global" } }),
    { builtins: { valueOf } },
  );
  assert.deepEqual(
    execution.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["global:builtin"],
  );
});

test("accepts direct prototype-sensitive configured global and builtin paths", () => {
  const globalSource = "say constructor";
  const globalCompilation = compileSource(globalSource, { globals: ["constructor"] });
  assert.deepEqual(globalCompilation.diagnostics, []);
  assert.notEqual(globalCompilation.plan, null);
  const globalExecution = run(
    globalCompilation.plan!,
    createFreshRuntimeSnapshot(globalCompilation.plan!, {
      globals: { constructor: "global value" },
    }),
  );
  assert.deepEqual(
    globalExecution.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["global value"],
  );

  const builtinSource = "say valueOf()";
  const builtinCompilation = compileSource(builtinSource, { builtins: ["valueOf"] });
  const valueOf: RuntimeBuiltinFunction = () => "builtin value";
  assert.deepEqual(builtinCompilation.diagnostics, []);
  assert.notEqual(builtinCompilation.plan, null);
  const builtinExecution = run(
    builtinCompilation.plan!,
    createFreshRuntimeSnapshot(builtinCompilation.plan!),
    { builtins: { valueOf } },
  );
  assert.deepEqual(
    builtinExecution.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["builtin value"],
  );
});

test("preserves unknown-name and protected-name semantic diagnostics", () => {
  const unknown = compileSource("say missingPrototypeName");
  assert.deepEqual(unknown.parserDiagnostics, []);
  assert.deepEqual(
    unknown.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV002"],
  );

  const protectedName = compileSource("let toString = 1");
  assert.deepEqual(protectedName.parserDiagnostics, []);
  assert.deepEqual(
    protectedName.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV001"],
  );
});

test("scans a wide dedented block without text amplification", () => {
  const line = `    ${"x".repeat(100_000)}`;
  const source = ['"""', line, line, '"""'].join("\n");
  const result = lex(source);
  assert.deepEqual(result.diagnostics, []);
  const value = result.tokens.find((token) => token.kind === TokenKind.StringText);
  assert.equal(tokenValue(value)?.length, 200_001);
});

function tokenValue(token: Token | undefined): string | undefined {
  return token !== undefined && "value" in token ? token.value : undefined;
}

function compactSpan(token: Token): [number, number, number, number, number, number] {
  return [
    token.span.start.offset,
    token.span.end.offset,
    token.span.start.line,
    token.span.start.column,
    token.span.end.line,
    token.span.end.column,
  ];
}
