import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../src/compiler.js";
import { compileSource } from "../src/index.js";
import { parse } from "../src/parser.js";

test("reports a missing speaker identifier and parses the next statement", () => {
  const source = "speaker\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP003", "error", [7, 0, 7, 7, 0, 7]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing say-as identifier without consuming the next line", () => {
  const source = 'say as "wrong"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP003", "error", [7, 0, 7, 7, 0, 7]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing say string and recovers at LF", () => {
  const source = "say\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP006", "error", [3, 0, 3, 3, 0, 3]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports missing property names, colons, and strings at bounded lines", () => {
  const source = [
    "speaker vera {",
    ': "no name"',
    'displayName "no colon"',
    "title:",
    "}",
    "exit",
  ].join("\n");
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    ["TSP004", "error", [15, 1, 0, 15, 1, 0]],
    ["TSP005", "error", [39, 2, 12, 39, 2, 12]],
    ["TSP006", "error", [57, 4, 0, 57, 4, 0]],
  ]);
  assert.deepEqual(statementKinds(result), ["speakerDeclaration", "exitStatement"]);
});

test("recovers a missing closing brace before a valid statement", () => {
  const source = ["speaker vera {", 'displayName: "Vera"', 'say "Still parsed"', "exit"].join("\n");
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP007", "error", [35, 2, 0, 35, 2, 0]]]);
  assert.deepEqual(statementKinds(result), ["speakerDeclaration", "sayStatement", "exitStatement"]);
  assert.deepEqual(result.program.statements[0]?.span, {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: 34, line: 1, column: 19 },
  });
});

test("a missing closing delimiter is reported where its line ends, and the next line still parses", () => {
  for (const line of [
    'f("a"',
    'let v = load("k"',
    "let v = (1 + 2",
    "let v = [1, 2",
    'let v = dict{ "a": 1',
    'say("a", instant',
    "function g(a, b",
    // An object or dict left open at the end of its line.
    "let v = { a: 1,",
    "let v = dict{",
  ]) {
    const result = parse(`${line}\nlet = 5\nexit`);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.line,
        diagnostic.span.start.column,
      ]),
      [
        ["TSP017", 0, line.length],
        ["TSP013", 1, 4],
      ],
      line,
    );
    assert.equal(statementKinds(result).at(-1), "exitStatement", line);
  }
  // A list left open also misses its first element, which the next line's statement cannot be.
  for (const line of ["let v = [", "let v = set["])
    assert.deepEqual(
      parse(`${line}\nlet = 5\nexit`).diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.line,
        diagnostic.span.start.column,
      ]),
      [
        ["TSP012", 1, 0],
        ["TSP017", 0, line.length],
        ["TSP013", 1, 4],
      ],
      line,
    );
  // A list left open in a block leaves the block's closing brace to the block, which keeps its statements.
  for (const open of ["[", "set[", "[1,"]) {
    const result = parse(`if true {\n    let v = ${open}\n}\nexit`);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.line,
        diagnostic.span.start.column,
      ]),
      [
        ["TSP012", 2, 0],
        ["TSP017", 1, "    let v = ".length + open.length],
      ],
      open,
    );
    assert.deepEqual(statementKinds(result), ["ifStatement", "exitStatement"], open);
  }
  // A stray closer within the line stays part of the malformed element, and so does a closer on a line of its own that
  // a bracket the element opened before it failed is waiting for. The elements after it still parse.
  for (const [source, codes, elements] of [
    ["let v = [1, }, 2]\nexit", ["TSP012"], 2],
    ["let v = [(1 +\n)\n, 3]\nexit", ["TSP012"], 1],
    ["let v = [dict{[(1\n2\n)]:3}, 4]\nexit", ["TSP017"], 2],
  ] as const) {
    const result = parse(source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      codes,
      source,
    );
    const declaration = result.program.statements[0];
    assert.equal(declaration?.kind, "letStatement", source);
    if (declaration?.kind !== "letStatement") continue;
    assert.equal(declaration.initializer.kind, "listLiteral", source);
    if (declaration.initializer.kind !== "listLiteral") continue;
    assert.equal(declaration.initializer.elements.length, elements, source);
  }
  // A line that starts with a value or a property named like a statement keyword stays in the literal.
  for (const source of ['let v = [\n    say "x"\n]\nexit', "let v = {\n    let: 1\n}\nexit"])
    assert.deepEqual(parse(source).diagnostics, [], source);
});

test("reports a missing closing brace at EOF once", () => {
  const source = 'speaker vera {\r\n  displayName: "Vera"';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP007", "error", [37, 1, 21, 37, 1, 21]]]);
  assert.deepEqual(statementKinds(result), ["speakerDeclaration"]);
});

test("reports an empty string interpolation and parses a later statement", () => {
  const source = 'say "Hello ${}"\r\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP008", "error", [13, 0, 13, 13, 0, 13]]]);
  assert.deepEqual(statementKinds(result), ["sayStatement", "exitStatement"]);
});

test("rejects invalid interpolation punctuation deterministically", () => {
  const source = 'say "${player: other}"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP009", "error", [13, 0, 13, 14, 0, 14]]]);
  assert.deepEqual(statementKinds(result), ["sayStatement", "exitStatement"]);
});

test("reports a missing property after dot without cascading", () => {
  const source = 'say "${player.}"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP010", "error", [14, 0, 14, 14, 0, 14]]]);
  assert.deepEqual(statementKinds(result), ["sayStatement", "exitStatement"]);
});

test("does not duplicate lexer diagnostics for an unterminated interpolation", () => {
  const source = 'say "Hello ${player"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSL005", "error", [11, 0, 11, 19, 0, 19]]]);
  assert.deepEqual(statementKinds(result), ["sayStatement", "exitStatement"]);
  // Where only a path written out in quotes is allowed, the string counts as failed without another error.
  assert.deepEqual(
    compactDiagnostics(parse('goto "rooms/${room"\nexit')).map(([code]) => code),
    ["TSL005"],
  );
});

test("an error inside an interpolation where a value is required is reported only once", () => {
  for (const [source, expected] of [
    ['let value = "${1 < 2 < 3}"\nexit', ["TSP020", "error", [21, 0, 21, 22, 0, 22]]],
    // The failed inner expression reported its own error: no generic TSP009 inside the string either.
    ['let value = "${1 +}"\nexit', ["TSP012", "error", [18, 0, 18, 18, 0, 18]]],
    // Nothing reported the failed expression, so the interpolation does.
    ['let value = "${)}"\nexit', ["TSP009", "error", [15, 0, 15, 16, 0, 16]]],
  ] as const) {
    const compilation = compileSource(source);
    assert.deepEqual(compactDiagnostics(compilation), [expected], source);
    assert.equal(compilation.plan, null, source);
    assert.deepEqual(statementKinds(parse(source)), ["letStatement", "exitStatement"], source);
  }
});

test("a statement keeps a string whose interpolation failed, so nothing around it reports another error", () => {
  for (const [source, code, kinds] of [
    [
      'let value = "${askText "Q", default: "Ada"}"\nlet after = 1\nexit',
      "TSP032",
      ["letStatement", "letStatement", "exitStatement"],
    ],
    // A dropped string would add an error for its missing value to each of these.
    ['let value = 1 + "${1 < 2 < 3}"\nexit', "TSP020", ["letStatement", "exitStatement"]],
    [
      'let pick = choose "${name nickname}", "Later"\nexit',
      "TSP009",
      ["letStatement", "exitStatement"],
    ],
    ['if "${}" == "x" {\n  say "y"\n}\nexit', "TSP008", ["ifStatement", "exitStatement"]],
    ['showButton "${player.}"\nexit', "TSP010", ["showButtonStatement", "exitStatement"]],
    ['save "key ${1 +}" as 1\nexit', "TSP012", ["saveStatement", "exitStatement"]],
    // The bounded say form is told by the comma after its text, also when the text recovered from an error.
    ['say("Hi ${player.}", instant)\nexit', "TSP010", ["sayStatement", "exitStatement"]],
    // A say of a call to a function named bubble, whose argument recovered from an error.
    [
      'function bubble(text) {\n  return text\n}\nsay bubble ("Hi ${player.}")\nexit',
      "TSP010",
      ["functionDeclaration", "sayStatement", "exitStatement"],
    ],
    // What follows an expression that already reported its error is skipped without another one.
    ['let value = "${1 < 2 < 3 x}"\nexit', "TSP020", ["letStatement", "exitStatement"]],
  ] as const) {
    const compilation = compileSource(source);
    assert.deepEqual(
      compilation.diagnostics.map((diagnostic) => diagnostic.code),
      [code],
      source,
    );
    assert.deepEqual(statementKinds(parse(source)), kinds, source);
  }
  // Another file still finds the global.
  const project = compileProject([
    { path: "main.tease", source: 'global greeting = "${1 < 2 < 3}"\ngoto "other.tease"\n' },
    { path: "other.tease", source: "say greeting\nexit\n" },
  ]);
  assert.deepEqual(
    project.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
    [["main.tease", "TSP020"]],
  );
});

test("where only text written out in quotes is allowed, a failed interpolation reports nothing more", () => {
  for (const [source, code] of [
    ['goto "rooms/${room name}.tease"\nexit', "TSP009"],
    ['goto "rooms/${}.tease"\nexit', "TSP008"],
    ['call tagged "punishment ${1 < 2 < 3}"\nexit', "TSP020"],
    ['call tagged "a ${}"\nexit', "TSP008"],
    ['call tagged "punishment", from: "modules/${x y}"\nexit', "TSP009"],
    ['let pool = findScripts(from: "modules/${}")\nexit', "TSP008"],
  ] as const) {
    assert.deepEqual(
      compileSource(source).diagnostics.map((diagnostic) => diagnostic.code),
      [code],
      source,
    );
  }
});

test("accepts physical continuation lines inside block-string interpolation", () => {
  const source = ['say """', "  ${", "    1 + 2", "  }", '"""', "exit"].join("\n");
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), []);
  assert.deepEqual(statementKinds(result), ["sayStatement", "exitStatement"]);
});

test("rejects an invalid statement shape and recovers at the next CRLF line", () => {
  const source = "unknown thing\r\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP001", "error", [0, 0, 0, 7, 0, 7]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

function compactDiagnostics(
  result: Pick<ReturnType<typeof parse>, "diagnostics">,
): Array<[string, string, [number, number, number, number, number, number]]> {
  return result.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    [
      diagnostic.span.start.offset,
      diagnostic.span.start.line,
      diagnostic.span.start.column,
      diagnostic.span.end.offset,
      diagnostic.span.end.line,
      diagnostic.span.end.column,
    ],
  ]);
}

function statementKinds(result: ReturnType<typeof parse>): string[] {
  return result.program.statements.map((statement) => statement.kind);
}
