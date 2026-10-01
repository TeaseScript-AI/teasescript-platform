import assert from "node:assert/strict";
import test from "node:test";

import type { Statement } from "../src/ast.js";
import { parse } from "../src/parser.js";

// A newline after a value-requiring ':' continues only into a line that can hold the value. A line that starts a
// statement, a property or key, or a closing delimiter, or the end of the file, leaves the value missing and keeps
// that token for the enclosing construct's recovery.
const nextLines = {
  value: '"Value"',
  statement: 'say "recovered"',
  speakerDeclaration: "speaker bob {}",
  speakerExpression: "speaker.displayName",
  key: 'title: "Captain"',
  closeBrace: "}",
  closeParenthesis: ")",
  end: null,
} as const;

const sites = {
  speaker: (line: string | null) =>
    `speaker vera {\n    displayName:\n${line === null ? "" : `${line}\n}`}`,
  choice: (line: string | null) => `let r = choose coast:\n${line ?? ""}`,
  presentation: (line: string | null) =>
    `say prose(background:\n${line === null ? "" : `${line}) "Text"`}`,
  call: (line: string | null) => `let x = f(a:\n${line === null ? "" : `${line})`}`,
  media: (line: string | null) => `playAudio(file:\n${line === null ? "" : `${line})`}`,
  object: (line: string | null) => `let o = { a:\n${line === null ? "" : `${line} }`}`,
  showButton: (line: string | null) => `showButton "Continue", background:\n${line ?? ""}`,
} as const;

// [site, next line, top-level result, result nested in an if block]
const matrix: ReadonlyArray<
  readonly [keyof typeof sites, keyof typeof nextLines, string, string | null]
> = [
  ["speaker", "value", "speaker exit |", "if[speaker exit] exit |"],
  [
    "speaker",
    "statement",
    "speaker say exit | TSP006@2:0 TSP007@2:0 TSP001@3:0",
    "if[speaker say] exit exit | TSP006@3:0 TSP007@3:0 TSP001@6:0",
  ],
  [
    "speaker",
    "speakerDeclaration",
    "speaker speaker exit | TSP006@2:0 TSP007@2:0 TSP001@3:0",
    "if[speaker speaker] exit exit | TSP006@3:0 TSP007@3:0 TSP001@6:0",
  ],
  ["speaker", "speakerExpression", "speaker exit |", "if[speaker exit] exit |"],
  ["speaker", "key", "speaker exit | TSP006@2:0", "if[speaker exit] exit | TSP006@3:0"],
  [
    "speaker",
    "closeBrace",
    "speaker exit | TSP006@2:0 TSP001@3:0",
    "if[speaker] exit exit | TSP006@3:0 TSP001@6:0",
  ],
  [
    "speaker",
    "closeParenthesis",
    "speaker exit | TSP006@2:0 TSP004@2:0",
    "if[speaker exit] exit | TSP006@3:0 TSP004@3:0",
  ],
  ["speaker", "end", "speaker | TSP006@2:0 TSP007@2:0", null],
  ["choice", "value", "let exit |", "if[let exit] exit |"],
  ["choice", "statement", "let say exit | TSP030@1:0", "if[let say exit] exit | TSP030@2:0"],
  [
    "choice",
    "speakerDeclaration",
    "let speaker exit | TSP030@1:0",
    "if[let speaker exit] exit | TSP030@2:0",
  ],
  ["choice", "speakerExpression", "let exit |", "if[let exit] exit |"],
  [
    "choice",
    "key",
    "let exit | TSP030@1:0 TSP002@1:0",
    "if[let exit] exit | TSP030@2:0 TSP002@2:0",
  ],
  [
    "choice",
    "closeBrace",
    "let exit | TSP030@1:0 TSP002@1:0",
    "if[let] exit exit | TSP030@2:0 TSP001@4:0",
  ],
  [
    "choice",
    "closeParenthesis",
    "let exit | TSP030@1:0 TSP002@1:0",
    "if[let exit] exit | TSP030@2:0 TSP002@2:0",
  ],
  ["choice", "end", "let | TSP030@1:0", null],
  ["presentation", "value", "say exit |", "if[say exit] exit |"],
  [
    "presentation",
    "statement",
    "exit | TSP012@1:0 TSP012@1:0 TSP006@1:0",
    "if[exit] exit | TSP012@2:0 TSP012@2:0 TSP006@2:0",
  ],
  [
    "presentation",
    "speakerDeclaration",
    "say exit | TSP012@1:0 TSP012@1:0 TSP002@1:8",
    "if[say] exit exit | TSP012@2:0 TSP012@2:0 TSP002@2:8 TSP002@2:14 TSP001@4:0",
  ],
  ["presentation", "speakerExpression", "say exit |", "if[say exit] exit |"],
  [
    "presentation",
    "key",
    "say exit | TSP012@1:0 TSP012@1:0 TSP002@1:5",
    "if[say exit] exit | TSP012@2:0 TSP012@2:0 TSP002@2:5",
  ],
  [
    "presentation",
    "closeBrace",
    "exit | TSP012@1:0 TSP012@1:0 TSP006@1:0",
    "if[exit] exit | TSP012@2:0 TSP012@2:0 TSP006@2:0",
  ],
  [
    "presentation",
    "closeParenthesis",
    "exit | TSP012@1:0 TSP006@1:1",
    "if[exit] exit | TSP012@2:0 TSP006@2:1",
  ],
  ["presentation", "end", "| TSP012@1:0 TSP012@1:0 TSP006@1:0", null],
  ["call", "value", "let exit |", "if[let exit] exit |"],
  [
    "call",
    "statement",
    "let exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[let exit] exit | TSP012@2:0 TSP017@2:0 TSP002@2:0",
  ],
  [
    "call",
    "speakerDeclaration",
    "let exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[let] exit exit | TSP012@2:0 TSP017@2:0 TSP002@2:0 TSP002@2:14 TSP001@4:0",
  ],
  ["call", "speakerExpression", "let exit |", "if[let exit] exit |"],
  [
    "call",
    "key",
    "let exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[let exit] exit | TSP012@2:0 TSP017@2:0 TSP002@2:0",
  ],
  [
    "call",
    "closeBrace",
    "let exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[let] exit exit | TSP012@2:0 TSP017@2:0 TSP002@2:1 TSP001@4:0",
  ],
  [
    "call",
    "closeParenthesis",
    "let exit | TSP012@1:0 TSP002@1:1",
    "if[let exit] exit | TSP012@2:0 TSP002@2:1",
  ],
  ["call", "end", "let | TSP012@1:0 TSP017@1:0", null],
  ["media", "value", "playMedia exit |", "if[playMedia exit] exit |"],
  ["media", "statement", "exit | TSP012@1:0 TSP017@1:0", "if[exit] exit | TSP012@2:0 TSP017@2:0"],
  [
    "media",
    "speakerDeclaration",
    "exit | TSP012@1:0 TSP017@1:0 TSP002@1:13",
    "if[] exit exit | TSP012@2:0 TSP017@2:0 TSP002@2:14 TSP001@4:0",
  ],
  ["media", "speakerExpression", "playMedia exit |", "if[playMedia exit] exit |"],
  ["media", "key", "exit | TSP012@1:0 TSP017@1:0", "if[exit] exit | TSP012@2:0 TSP017@2:0"],
  [
    "media",
    "closeBrace",
    "exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[] exit exit | TSP012@2:0 TSP017@2:0 TSP002@2:1 TSP001@4:0",
  ],
  [
    "media",
    "closeParenthesis",
    "exit | TSP012@1:0 TSP002@1:1",
    "if[exit] exit | TSP012@2:0 TSP002@2:1",
  ],
  ["media", "end", "| TSP012@1:0 TSP017@1:0", null],
  ["object", "value", "let exit |", "if[let exit] exit |"],
  [
    "object",
    "statement",
    "let exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[let] exit exit | TSP012@2:0 TSP017@2:0 TSP002@2:0 TSP001@4:0",
  ],
  [
    "object",
    "speakerDeclaration",
    "let exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[let] exit exit | TSP012@2:0 TSP017@2:0 TSP002@2:0 TSP002@2:15 TSP001@4:0",
  ],
  ["object", "speakerExpression", "let exit |", "if[let exit] exit |"],
  [
    "object",
    "key",
    "let exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[let] exit exit | TSP012@2:0 TSP017@2:0 TSP002@2:0 TSP001@4:0",
  ],
  [
    "object",
    "closeBrace",
    "let exit | TSP012@1:0 TSP002@1:2",
    "if[let] exit exit | TSP012@2:0 TSP001@4:0",
  ],
  [
    "object",
    "closeParenthesis",
    "let exit | TSP012@1:0 TSP017@1:0 TSP002@1:0",
    "if[let] exit exit | TSP012@2:0 TSP017@2:0 TSP002@2:0 TSP001@4:0",
  ],
  ["object", "end", "let | TSP012@1:0 TSP017@1:0", null],
  ["showButton", "value", "showButton exit |", "if[showButton exit] exit |"],
  ["showButton", "statement", "say exit | TSP028@1:0", "if[say exit] exit | TSP028@2:0"],
  [
    "showButton",
    "speakerDeclaration",
    "speaker exit | TSP028@1:0",
    "if[speaker exit] exit | TSP028@2:0",
  ],
  ["showButton", "speakerExpression", "showButton exit |", "if[showButton exit] exit |"],
  ["showButton", "key", "exit | TSP028@1:0 TSP002@1:0", "if[exit] exit | TSP028@2:0 TSP002@2:0"],
  [
    "showButton",
    "closeBrace",
    "exit | TSP028@1:0 TSP002@1:0",
    "if[] exit exit | TSP028@2:0 TSP001@4:0",
  ],
  [
    "showButton",
    "closeParenthesis",
    "exit | TSP028@1:0 TSP002@1:0",
    "if[exit] exit | TSP028@2:0 TSP002@2:0",
  ],
  ["showButton", "end", "| TSP028@1:0", null],
];

function summary(source: string): string {
  const result = parse(source);
  const diagnostics = result.diagnostics.map(
    (diagnostic) =>
      `${diagnostic.code}@${diagnostic.span.start.line}:${diagnostic.span.start.column}`,
  );
  return `${kinds(result.program.statements)} | ${diagnostics.join(" ")}`.trim();
}

function kinds(statements: readonly Statement[]): string {
  return statements
    .map((statement) =>
      statement.kind === "ifStatement"
        ? `if[${kinds(statement.thenBlock.statements)}]`
        : statement.kind.replace(/Statement$|Declaration$/, ""),
    )
    .join(" ");
}

test("each continued colon leaves a non-value next line to the enclosing recovery", () => {
  assert.equal(matrix.length, Object.keys(sites).length * Object.keys(nextLines).length);
  for (const [site, kind, topLevel, nested] of matrix) {
    const line = nextLines[kind];
    const source = sites[site](line) + (line === null ? "" : "\nexit");
    assert.equal(summary(source), topLevel, `${site}/${kind}`);
    if (nested !== null) {
      assert.equal(summary(`if true {\n${source}\n}\nexit`), nested, `${site}/${kind} nested`);
    }
  }
});

test("a speaker property without a continued value keeps the following declaration or property", () => {
  const declarations = parse("speaker vera {\n    displayName:\nspeaker bob {}\nexit");
  assert.deepEqual(
    declarations.program.statements.map((statement) =>
      statement.kind === "speakerDeclaration" ? statement.name.name : statement.kind,
    ),
    ["vera", "bob", "exitStatement"],
  );

  const nested = parse(
    "if true {\n    speaker vera {\n        displayName:\n    speaker bob {}\n}\nexit",
  );
  const block = nested.program.statements[0];
  assert.equal(block?.kind, "ifStatement");
  assert.deepEqual(
    block?.thenBlock.statements.map((statement) =>
      statement.kind === "speakerDeclaration" ? statement.name.name : statement.kind,
    ),
    ["vera", "bob"],
  );

  const property = parse('speaker vera {\n    displayName:\n    title: "Captain"\n}\nexit');
  assert.deepEqual(
    property.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP006"],
  );
  const vera = property.program.statements[0];
  assert.equal(vera?.kind, "speakerDeclaration");
  assert.deepEqual(
    vera?.properties.map((entry) => entry.name.name),
    ["title"],
  );
});

test("a missing value on the colon's own line keeps its single-line recovery", () => {
  for (const [source, expected] of [
    ['speaker vera {\n    displayName: say "x"\n}\nexit', "speaker exit | TSP006@1:17"],
    ['speaker vera {\n    displayName: title: "C"\n}', "speaker | TSP011@1:22"],
    ['let r = choose coast: say "x"\nexit', "let say exit | TSP030@0:22"],
    ['let r = choose coast: b: "B"', "let | TSP031@0:23"],
    ['say prose(background: align: "left") "T"', "| TSP012@0:27 TSP006@0:27"],
    ["let o = { a: b: 1 }", "let | TSP017@0:14 TSP002@0:14"],
  ] as const) {
    assert.equal(summary(source), expected, source);
  }
});
