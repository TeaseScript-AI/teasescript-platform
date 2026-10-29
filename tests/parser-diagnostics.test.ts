import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSourceWithBackend } from "../src/compiler.js";
import { compileSource } from "../src/index.js";
import { parse } from "../src/parser.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";

test("reports a missing speaker identifier and parses the next statement", () => {
  const source = "speaker\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP003", "error", [7, 0, 7, 7, 0, 7]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing say-as identifier without consuming the next line", () => {
  const source = 'say as "wrong"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP029", "error", [7, 0, 7, 7, 0, 7]]]);
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

/**
 * Typing mistakes and the blocks they are in: `@` holds the mistake. Each gives its errors on its own line, and every
 * other statement stays. A statement's own skip stops at the `}` of its block (`Parser.atBraceCloser`), in every block;
 * a group left open ends where a statement starts its line (`Parser.atGroupEnd`), so those mistakes are tested where
 * one follows. Inside a value a `}` does not end a group: which group it closes cannot be told while recovering (#1147).
 * The places are: top level, a multi-line block, a one-line block, a one-line block in a block, and the one-line blocks
 * of a permanent button, media, and a media cue.
 */
const RECOVERY_MISTAKES: readonly (readonly [string, number, "every place" | "statement after"])[] =
  [
    ["goto", 1, "every place"],
    ["let m = (1 + 2", 1, "every place"],
    ["if (true", 1, "every place"],
    ["let m = [1, 2", 1, "every place"],
    ["let m = (", 1, "every place"],
    ["let m = before[", 1, "every place"],
    ["let m = [", 1, "statement after"],
    ["let m = set[", 1, "statement after"],
    ["let m = max(1,", 1, "statement after"],
    // An element that fails where its list must end also misses the list's `]`.
    ["let m = [2, (1", 2, "statement after"],
  ];
const RECOVERY_BLOCKS = [
  "@",
  "if true {\n  let a = 1\n  @\n  let b = 2\n}",
  "if true { @ }",
  "if true {\n  if true { @ }\n  let b = 2\n}",
  'showPermanentButton "Go" { @ }',
  'playAudio "a.mp3" { @ }',
  'playAudio "a.mp3" { at 1 s { @ } }',
];

test("recovery from a typing mistake keeps the closers and statements around it", () => {
  const kept = (node: unknown, names: string[] = []): string[] => {
    if (Array.isArray(node)) for (const item of node) kept(item, names);
    else if (typeof node === "object" && node !== null) {
      // EVIDENCE: invariant: the parser builds every node as an object with its `kind`, and a `let` with its `name`.
      const { kind, name } = node as { kind?: string; name?: { name?: string } };
      if (kind === "letStatement") names.push(name?.name ?? "");
      if (kind === "exitStatement") names.push("exit");
      for (const [key, child] of Object.entries(node)) if (key !== "span") kept(child, names);
    }
    return names;
  };
  for (const [mistake, errors, places] of RECOVERY_MISTAKES)
    for (const block of places === "every place" ? RECOVERY_BLOCKS : RECOVERY_BLOCKS.slice(0, 2)) {
      const source = `let before = 0\n${block.replace("@", () => mistake)}\nlet after = 3\nexit\n`;
      const result = parse(source);
      const line = source.split("\n").findIndex((text) => text.includes(mistake));
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => diagnostic.span.start.line),
        Array.from({ length: errors }, () => line),
        source,
      );
      // Every statement as written but the one with the mistake.
      const written = [...source.matchAll(/let (\w+)/gu)].map((match) => match[1]);
      assert.deepEqual(
        kept(result.program).filter((name) => name !== "m"),
        [...written.filter((name) => name !== "m"), "exit"],
        source,
      );
    }
  // Closers that recovery must leave as main does: one that the mistake's own group opened, also after a line break or
  // a returned group; a stray or mistyped one followed by its group's closer, also on the next line. Each keeps main's
  // errors, the later elements, and the statements.
  const numbers = (node: unknown, found: number[] = []): number[] => {
    if (Array.isArray(node)) for (const item of node) numbers(item, found);
    else if (typeof node === "object" && node !== null) {
      // EVIDENCE: invariant: the parser builds every node as an object with its `kind`, and a number with its `value`.
      const { kind, value } = node as { kind?: string; value?: number };
      if (kind === "numberLiteral") found.push(value!);
      for (const [key, child] of Object.entries(node)) if (key !== "span") numbers(child, found);
    }
    return found;
  };
  for (const [source, codes, kept, statements] of [
    ["let v = [(1 +\n)\n, 3]", ["TSP012"], [3], ["let", "exit"]],
    ["let v = [(1\n]", ["TSP017"], [], ["let", "exit"]],
    ["let v = [(1 +, 3]", ["TSP012"], [3], ["let", "exit"]],
    ["let v = dict{[1\n}", ["TSP017"], [], ["let", "exit"]],
    ["let v = [{a [1,\n2]\n}, 3]", ["TSP005", "TSP017", "TSP001"], [2], ["let", "exit"]],
    ["if true { let v = { a: 1) }", ["TSP017", "TSP002"], [1], ["if", "exit"]],
    ["let v = [dict{[1]]:3}, 4]", ["TSP005"], [4], ["let", "exit"]],
    [
      'let v = [showPermanentButton "A" { save f(1] as "key" }, 3]',
      ["TSP017", "TSP036"],
      [3],
      ["let", "exit"],
    ],
    ["let v = f([(1 +\n)\n, 3], 4)", ["TSP012"], [3, 4], ["let", "exit"]],
    ["let v = [dict{[1]]:3\n}, 4]", ["TSP005"], [4], ["let", "exit"]],
    [
      'let v = [showPermanentButton "A" { save f(1] as "key"\n}, 3]',
      ["TSP017", "TSP036"],
      [3],
      ["let", "exit"],
    ],
    ["if true { let v = [(1+2}, 3] }", ["TSP017"], [3], ["if", "exit"]],
    ["if true { let v = [(1}\n, 3]\n}", ["TSP017"], [3], ["if", "exit"]],
    // A command's skip inside an object or dict stops at its `}`, as on main.
    ["let v = [{a: playAudio }, 4]", ["TSP012"], [4], ["let", "exit"]],
    ["let v = [dict{a: playAudio }, 4]", ["TSP012"], [4], ["let", "exit"]],
    // Commands whose skip stops at any `}`, also outside a counted brace, as on main.
    ["let v = [playAudio }, 4]", ["TSP012"], [4], ["let", "exit"]],
    [
      'let v: (media | integer)[] = [playVideo(async: true, file: "v"}, 4]',
      ["TSP017"],
      [4],
      ["let", "exit"],
    ],
    ["let v = [playAudio(file: }, 4]", ["TSP012", "TSP017"], [4], ["let", "exit"]],
    ["let v = [[playAudio }, 4], 5]", ["TSP012"], [4, 5], ["let", "exit"]],
    ["switch 1 { case playAudio }", ["TSP012"], [1], ["switch", "exit"]],
    [
      "speaker actor { textColor: playAudio }",
      ["TSP012", "TSP006"],
      [],
      ["speakerDeclaration", "exit"],
    ],
  ] as const) {
    const result = parse(`${source}\nexit`);
    assert.deepEqual(
      [
        result.diagnostics.map((diagnostic) => diagnostic.code),
        numbers(result.program),
        statementKinds(result).map((kind) => kind.replace("Statement", "")),
      ],
      [codes, kept, statements],
      source,
    );
  }
});

test("a missing closing delimiter is reported where its line ends, and the next line still parses", () => {
  for (const line of [
    'f("a"',
    'let v = load("k"',
    "let v = (1 + 2",
    "let v = [1, 2",
    "let v = [",
    "let v = set[",
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
      'let pick = askChoice "${name nickname}", "Later"\nexit',
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
    ['call tagged "punishment", from: "modules/${x z}"\nexit', "TSP009"],
    ['let pool = findScripts(from: "modules/${}")\nexit', "TSP008"],
  ] as const) {
    assert.deepEqual(
      compileSource(source).diagnostics.map((diagnostic) => diagnostic.code),
      [code],
      source,
    );
  }
});

test("a string or regex without its closing delimiter reports only that", () => {
  for (const [source, expected] of [
    ['let text = "unfinished', ["TSL003 11-22"]],
    ['let text = "a"\ntext = "unfinished', ["TSL003 22-33"]],
    ['global text = "unfinished', ["TSL003 14-25"]],
    ['let text = """\nunfinished', ["TSL004 11-25"]],
    ['say "unfinished', ["TSL003 4-15"]],
    ['let text = "a ${1', ["TSL005 14-17", "TSL003 11-17"]],
    ["let pattern = /ab\nexit", ["TSL009 14-17"]],
    // Other errors stay: a value missing before or inside the string, and brackets that its delimiter does not close.
    ['let a = ()\nlet b = "unfinished', ["TSL003 19-30", "TSP012 9-9"]],
    ['let text = "a ${1 +', ["TSL005 14-19", "TSL003 11-19", "TSP012 19-19"]],
    ['let n = f(g("unfinished', ["TSL003 12-23", "TSP017 23-23", "TSP017 23-23"]],
    ["let n = length(/ab", ["TSL009 15-18", "TSP017 18-18"]],
    // A `/` after a mode word stays a division where main read one: the ask's question is what misses its quote.
    ['say prose / askText "x', ["TSL003 20-22"]],
    ['let q = askNumber prose / askText "x', ["TSL003 34-36"]],
  ] as const) {
    for (const compilation of [
      compileSource(source),
      compileSourceWithBackend(source, {}, CORE_BACKEND),
    ]) {
      assert.deepEqual(
        compilation.diagnostics.map(
          ({ code, span }) => `${code} ${span.start.offset}-${span.end.offset}`,
        ),
        expected,
        source,
      );
      assert.equal(compilation.plan, null, source);
    }
  }
  // Where the lexer took a `/` for division, a string that the regex holds still makes the parse try a regex there.
  for (const source of ['say prose /"abc/\nexit', 'let answer = askText prose /"abc/\nexit']) {
    assert.deepEqual(compileSource(source).diagnostics, [], source);
  }
});

test("a command reports its missing operand only when the operand reported nothing", () => {
  for (const [source, expected] of [
    ["wait 1 +", ["TSP012 8-8"]],
    ['wait "unfinished', ["TSL003 5-16"]],
    ['showButton "unfinished', ["TSL003 11-22"]],
    ['save "unfinished', ["TSL003 5-16"]],
    ['let v = load("unfinished', ["TSL003 13-24", "TSP017 24-24"]],
    ["say 1 +", ["TSP012 7-7"]],
    ['say "a", 1 +', ["TSP012 12-12"]],
    ['showButton "ok", timeout: "unfinished', ["TSL003 26-37"]],
    ['let x = askText prefill: "unfinished', ["TSL003 25-36"]],
    ['let c = askChoice "a", prefill: "unfinished', ["TSL003 32-43"]],
    // An operand that is not there at all is still reported.
    ["wait", ["TSP012 4-4"]],
    ["showButton", ["TSP028 10-10"]],
    ['showButton "ok", timeout:', ["TSP028 25-25"]],
    ["let v = load(default: 1)", ["TSP036 8-24"]],
    ["say", ["TSP006 3-3"]],
  ] as const) {
    assert.deepEqual(
      compileSource(source).diagnostics.map(
        ({ code, span }) => `${code} ${span.start.offset}-${span.end.offset}`,
      ),
      expected,
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
