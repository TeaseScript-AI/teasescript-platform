import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { lex } from "../src/lexer.js";
import { parse } from "../src/parser.js";
import { createFreshRuntimeSnapshot, run, type RuntimeBuiltinFunction } from "../src/index.js";
import type { RandomSource } from "../src/runtime/random.js";
import { TokenKind, type Token } from "../src/token.js";

const random: RandomSource = { next: () => 0 };

const multilineNestedCases = [
  {
    name: "LF",
    source: ["say `Outer: ${`", "  Inner", "`}`"].join("\n"),
    textSpan: [15, 24, 0, 15, 2, 0],
    textLexeme: "\n  Inner\n",
    textValue: " Inner ",
  },
  {
    name: "CRLF",
    source: ["say `Outer: ${`", "  Inner", "`}`"].join("\r\n"),
    textSpan: [15, 26, 0, 15, 2, 0],
    textLexeme: "\r\n  Inner\r\n",
    textValue: " Inner ",
  },
  {
    name: "horizontal whitespace followed by LF",
    source: ["say `Outer: ${` \t", "  Inner", "`}`"].join("\n"),
    textSpan: [15, 26, 0, 15, 2, 0],
    textLexeme: " \t\n  Inner\n",
    textValue: " Inner ",
  },
  {
    name: "horizontal whitespace followed by CRLF",
    source: ["say `Outer: ${`\t ", "  Inner", "`}`"].join("\r\n"),
    textSpan: [15, 28, 0, 15, 2, 0],
    textLexeme: "\t \r\n  Inner\r\n",
    textValue: " Inner ",
  },
  {
    name: "empty first inner physical line",
    source: ["say `Outer: ${`", "", "  Inner", "`}`"].join("\n"),
    textSpan: [15, 25, 0, 15, 3, 0],
    textLexeme: "\n\n  Inner\n",
    textValue: "  Inner ",
  },
] as const;

for (const nestedCase of multilineNestedCases) {
  test(`lexes a multiline nested template opened before ${nestedCase.name}`, () => {
    const result = lex(nestedCase.source);
    const innerText = result.tokens.find(
      (token, index) =>
        token.kind === TokenKind.TemplateText &&
        result.tokens[index - 1]?.kind === TokenKind.TemplateStart &&
        index > 4,
    );

    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.tokens.map((token) => token.kind),
      [
        TokenKind.KeywordSay,
        TokenKind.TemplateStart,
        TokenKind.TemplateText,
        TokenKind.InterpolationStart,
        TokenKind.TemplateStart,
        TokenKind.TemplateText,
        TokenKind.TemplateEnd,
        TokenKind.InterpolationEnd,
        TokenKind.TemplateEnd,
        TokenKind.EndOfFile,
      ],
    );
    assert.equal(innerText?.lexeme, nestedCase.textLexeme);
    assert.equal(tokenValue(innerText), nestedCase.textValue);
    assert.deepEqual(
      innerText === undefined ? null : compactSpan(innerText),
      nestedCase.textSpan,
    );
  });
}

test("parses, compiles, and executes multiline nested interpolation", () => {
  const source = [
    "let value = 1",
    "say `Outer: ${`",
    "  Inner ${value + 2}",
    "`}`",
  ].join("\n");
  const parsed = parse(source);
  const compiled = compileSource(source);
  const statement = parsed.program.statements[1];

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  assert.equal(statement?.kind, "sayStatement");
  if (
    statement?.kind !== "sayStatement" ||
    statement.value.kind !== "templateLiteral"
  ) {
    assert.fail("Expected an outer template say statement.");
  }
  const outerInterpolation = statement.value.parts[1];
  assert.equal(outerInterpolation?.kind, "templateInterpolation");
  if (outerInterpolation?.kind !== "templateInterpolation") {
    assert.fail("Expected an outer interpolation.");
  }
  assert.equal(outerInterpolation.expression.kind, "templateLiteral");
  if (outerInterpolation.expression.kind !== "templateLiteral") {
    assert.fail("Expected a nested multiline template expression.");
  }
  assert.ok(
    outerInterpolation.expression.parts.some(
      (part) => part.kind === "templateInterpolation",
    ),
  );

  const execution = executeSource(source);
  assert.deepEqual(
    execution.events
      .filter((event) => event.kind === "say")
      .map((event) => event.text),
    ["Outer:  Inner 3 "],
  );
});

test("preserves source order and escapes in a deeper multiline nested template", () => {
  let nextValue = 0;
  const next: RuntimeBuiltinFunction = () => {
    nextValue += 1;
    return nextValue;
  };
  const source = [
    "say `A${`",
    "  B ${next()} ${`",
    "    C \\` \\${literal} ${next()}",
    "  `}",
    "`}`",
  ].join("\n");
  const compiled = compileSource(source, { builtins: ["next"] });
  const parsed = parse(source);

  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  assert.deepEqual(parsed.diagnostics, []);
  const execution = executeSource(source, { next });
  assert.equal(nextValue, 2);
  assert.deepEqual(
    execution.events
      .filter((event) => event.kind === "say")
      .map((event) => event.text),
    ["A B 1  C ` ${literal} 2  "],
  );
});

test("keeps structured diagnostics for malformed nested templates", () => {
  const cases = [
    {
      name: "unterminated inner template",
      source: "say `Outer: ${`Inner",
      diagnostics: [
        ["TSL004", 14, 20],
        ["TSL005", 12, 20],
      ],
    },
    {
      name: "EOF immediately after nested opening",
      source: "say `Outer: ${`",
      diagnostics: [
        ["TSL004", 14, 15],
        ["TSL005", 12, 15],
      ],
    },
    {
      name: "unterminated inner interpolation",
      source: "say `Outer: ${`Inner ${1",
      diagnostics: [
        ["TSL005", 21, 24],
        ["TSL005", 12, 24],
      ],
    },
    {
      name: "unterminated outer interpolation",
      source: "say `Outer: ${value",
      diagnostics: [["TSL005", 12, 19]],
    },
  ] as const;

  for (const malformed of cases) {
    const result = lex(malformed.source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      malformed.diagnostics,
      malformed.name,
    );
  }
});

test("keeps a non-expression-start backtick as outer recovery boundary", () => {
  const source = "say `Outer: ${value`\nexit";
  const result = lex(source);

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [["TSL005", 12, 19]],
  );
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      TokenKind.KeywordSay,
      TokenKind.TemplateStart,
      TokenKind.TemplateText,
      TokenKind.InterpolationStart,
      TokenKind.Identifier,
      TokenKind.TemplateEnd,
      TokenKind.Newline,
      TokenKind.KeywordExit,
      TokenKind.EndOfFile,
    ],
  );
});

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
  const source = "let say function return true false null and or not";
  const result = lex(source);

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

test("parses, compiles, and executes prototype-sensitive declarations and properties", () => {
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

  const execution = executeSource(source);
  assert.deepEqual(
    execution.events
      .filter((event) => event.kind === "say")
      .map((event) => event.text),
    ["5"],
  );
});

test("accepts prototype-sensitive configured globals and builtins", () => {
  const globalSource = "say constructor";
  const globalCompilation = compileSource(globalSource, {
    globals: ["constructor"],
  });

  assert.deepEqual(globalCompilation.diagnostics, []);
  assert.notEqual(globalCompilation.plan, null);
  const globalExecution = executeSource(globalSource, undefined, { constructor: "global value" });
  assert.deepEqual(
    globalExecution.events
      .filter((event) => event.kind === "say")
      .map((event) => event.text),
    ["global value"],
  );

  const builtinSource = "say valueOf()";
  const builtinCompilation = compileSource(builtinSource, {
    builtins: ["valueOf"],
  });
  const valueOf: RuntimeBuiltinFunction = () => "builtin value";

  assert.deepEqual(builtinCompilation.diagnostics, []);
  assert.notEqual(builtinCompilation.plan, null);
  const builtinExecution = executeSource(builtinSource, { valueOf });
  assert.deepEqual(
    builtinExecution.events
      .filter((event) => event.kind === "say")
      .map((event) => event.text),
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

function tokenValue(token: Token | undefined): string | undefined {
  return token !== undefined && "value" in token ? token.value : undefined;
}

function executeSource(
  source: string,
  builtins?: Readonly<Record<string, RuntimeBuiltinFunction>>,
  globals?: Readonly<Record<string, string>>,
) {
  const compiled = compileSource(source, {
    builtins: builtins === undefined ? [] : Object.keys(builtins),
    globals: globals === undefined ? [] : Object.keys(globals),
  });
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return run(
    compiled.plan!,
    createFreshRuntimeSnapshot(
      compiled.plan!,
      globals === undefined ? {} : { globals },
    ),
    { random, ...(builtins === undefined ? {} : { builtins }) },
  );
}

function compactSpan(
  token: Token,
): [number, number, number, number, number, number] {
  return [
    token.span.start.offset,
    token.span.end.offset,
    token.span.start.line,
    token.span.start.column,
    token.span.end.line,
    token.span.end.column,
  ];
}
