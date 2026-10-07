import assert from "node:assert/strict";
import test from "node:test";

import type { Program, Statement } from "../src/ast.js";
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
  // A protected statement-only command never holds a value; an expression command such as `timer` does.
  statementCommand: 'showButton "Next"',
  expressionCommand: "timer 5 seconds",
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

// Next lines that can hold the value; every other next line leaves the value missing.
const valueLines: ReadonlySet<string> = new Set([
  "value",
  "speakerExpression",
  "expressionCommand",
]);

// The diagnostic each site reports for a missing value. A site whose value sits inside an open delimiter cannot
// return the next line to the enclosing statement list; the others must keep it as its own statement.
const missingValueCode: Readonly<Record<string, string>> = {
  speaker: "TSP006",
  choice: "TSP030",
  presentation: "TSP012",
  call: "TSP012",
  media: "TSP012",
  object: "TSP012",
  showButton: "TSP028",
};
const delimitedSites: ReadonlySet<string> = new Set(["presentation", "call", "media", "object"]);
const statementLines: ReadonlySet<string> = new Set([
  "statement",
  "speakerDeclaration",
  "statementCommand",
]);

// The missing value is reported where the continued line starts. That position is the current choice; the rule only
// requires that the value is missing and that the next line stays with the enclosing construct.
function continuedLineStart(source: string): number {
  return source.indexOf(":\n") + 2;
}

// The parsed program without source positions.
function shape(source: string): string {
  return JSON.stringify(parse(source).program, (key, value: unknown) =>
    /span$/iu.test(key) ? undefined : value,
  );
}

function assertCell(
  site: string,
  kind: string,
  source: string,
  statementsOf: (program: Program) => readonly Statement[] | undefined,
  cell: string,
): void {
  const result = parse(source);
  if (valueLines.has(kind)) {
    // A continued value parses exactly like the same value on the colon's line.
    assert.deepEqual(result.diagnostics, [], cell);
    assert.equal(shape(source), shape(source.replace(":\n", ": ")), cell);
    return;
  }
  const root = result.diagnostics[0];
  assert.deepEqual(
    [root?.code, root?.span.start.offset],
    [missingValueCode[site], continuedLineStart(source)],
    cell,
  );
  if (kind !== "end") {
    assert.equal(result.program.statements.at(-1)?.kind, "exitStatement", cell);
  }
  if (!delimitedSites.has(site) && statementLines.has(kind)) {
    assert.ok(
      statementsOf(result.program)?.some(
        (statement) => statement.span.start.offset === continuedLineStart(source),
      ),
      cell,
    );
  }
}

test("each continued colon leaves a non-value next line to the enclosing recovery", () => {
  // Root diagnostics and surviving constructs are fixed; secondary diagnostics after the root may improve.
  for (const [site, build] of Object.entries(sites)) {
    for (const [kind, line] of Object.entries(nextLines)) {
      const source = build(line) + (line === null ? "" : "\nexit");
      assertCell(site, kind, source, (program) => program.statements, `${site}/${kind}`);
      // Inside a block, the next line and a closing brace must still reach the enclosing block.
      if (kind === "statement" || kind === "closeBrace") {
        assertCell(
          site,
          kind,
          `if true {\n${source}\n}\nexit`,
          (program) => {
            const block = program.statements[0];
            return block?.kind === "ifStatement" ? block.thenBlock.statements : undefined;
          },
          `${site}/${kind} nested`,
        );
      }
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
  // Without a newline after ':' nothing continues, so the first diagnostic stays on the colon's line.
  for (const source of [
    "speaker vera {\n    displayName: exit\n}\nexit",
    'speaker vera {\n    displayName: title: "C"\n}',
    "let r = choose coast: exit\nexit",
    'let r = choose coast: b: "B"',
    'say prose(background: align: "left") "T"',
    "let o = { a: b: 1 }",
    "let r = choose coast:",
  ]) {
    const colonLine = source.slice(0, source.indexOf(":")).split("\n").length - 1;
    assert.equal(parse(source).diagnostics[0]?.span.start.line, colonLine, source);
  }

  // A statement after the colon is where the value is missing; the choice keeps it as the next statement.
  const speaker = parse("speaker vera {\n    displayName: exit\n}\nexit");
  assert.deepEqual(root(speaker), ["TSP006", 1, 17]);
  assert.deepEqual(kinds(speaker), ["speakerDeclaration", "exitStatement"]);
  const choice = parse("let r = choose coast: exit\nexit");
  assert.deepEqual(root(choice), ["TSP030", 0, 22]);
  assert.deepEqual(kinds(choice), ["letStatement", "exitStatement", "exitStatement"]);

  // The end of the file directly after the colon reports the missing option, not a missing option list.
  const atEnd = parse("let r = choose coast:");
  assert.deepEqual(root(atEnd), ["TSP030", 0, 21]);
  assert.match(atEnd.diagnostics[0]?.message ?? "", /after ':'/u);
  assert.deepEqual(kinds(atEnd), ["letStatement"]);
});

function root(result: ReturnType<typeof parse>) {
  const first = result.diagnostics[0];
  return [first?.code, first?.span.start.line, first?.span.start.column];
}

function kinds(result: ReturnType<typeof parse>): string[] {
  return result.program.statements.map((statement) => statement.kind);
}
