import assert from "node:assert/strict";
import test from "node:test";

import type { Expression } from "../src/ast.js";
import { parse, Parser, type ParseResult, type StatementRange } from "../src/parser.js";
import { DiagnosticLog } from "../src/parser/diagnostic-log.js";
import { lex } from "../src/lexer.js";
import { readScriptHeader } from "../src/script-header.js";

test("deep malformed nesting reports the missing closer at EOF with structured recovery", () => {
  const collections = Array.from({ length: 2_000 }, (_, index) =>
    index % 2 === 0 ? "[" : "set[",
  ).join("");
  for (const source of [`${"(".repeat(2_000)}1`, `let value = ${collections}1`]) {
    // Returning at all, rather than throwing a native RangeError, is the termination evidence.
    const first = parse(source);
    const second = parse(source);
    assert.deepEqual(first.diagnostics, second.diagnostics);
    const [root] = first.diagnostics;
    assert.deepEqual(
      [root?.code, root?.span.start.offset, root?.span.end.offset],
      ["TSP017", source.length, source.length],
    );
    // Secondary unwinding may improve, but must stay structured and source-associated.
    for (const diagnostic of first.diagnostics) {
      assert.match(diagnostic.code, /^TSP\d{3}$/u);
      assert.ok(diagnostic.span.start.offset <= diagnostic.span.end.offset);
      assert.ok(diagnostic.span.end.offset <= source.length);
    }
  }
});

test("parenthesis-chain parsing preserves grouping spans and statement boundaries", () => {
  const source = "let value = ((1))\n+2";
  const parsed = parse(source);
  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP016"],
  );
  const statement = parsed.program.statements[0];
  assert.equal(statement?.kind, "letStatement");
  if (statement?.kind !== "letStatement") return;
  assert.equal(statement.initializer.kind, "parenthesizedExpression");
  assert.deepEqual(
    [statement.initializer.span.start.offset, statement.initializer.span.end.offset],
    [12, 17],
  );
  if (statement.initializer.kind !== "parenthesizedExpression") return;
  assert.equal(statement.initializer.expression.kind, "parenthesizedExpression");
  assert.deepEqual(
    [
      statement.initializer.expression.span.start.offset,
      statement.initializer.expression.span.end.offset,
    ],
    [13, 16],
  );
});

test("mixed collection chains preserve kinds, spans, and the following statement", () => {
  const source = "let value = [set[[1]]]\nexit";
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    parsed.program.statements.map((statement) => statement.kind),
    ["letStatement", "exitStatement"],
  );
  const statement = parsed.program.statements[0];
  assert.equal(statement?.kind, "letStatement");
  if (statement?.kind !== "letStatement") return;
  const outer = statement.initializer;
  assert.equal(outer.kind, "listLiteral");
  if (outer.kind !== "listLiteral") return;
  const set = outer.elements[0];
  assert.equal(set?.kind, "setLiteral");
  if (set?.kind !== "setLiteral") return;
  const inner = set.elements[0];
  assert.equal(inner?.kind, "listLiteral");
  assert.deepEqual(
    [outer, set, inner].map((expression) =>
      expression === undefined ? null : [expression.span.start.offset, expression.span.end.offset],
    ),
    [
      [12, 22],
      [13, 21],
      [17, 20],
    ],
  );
});

test("deep collection chains retain ordinary innermost expressions", () => {
  const depth = 1_024;
  // Innermost siblings and an object frame inside the list frames.
  const rows: readonly (readonly [string, readonly ExpressionShape[]])[] = [
    ["{ value: 1 }", [["object", ["value", 1]]]],
    ["1, 2", [1, 2]],
  ];
  for (const [inner, innermostElements] of rows) {
    const expression = `${"[".repeat(depth)}${inner}${"]".repeat(depth)}`;
    const source = `let value = ${expression}\nexit`;
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, [], expression);
    assert.deepEqual(
      parsed.program.statements.map((statement) => statement.kind),
      ["letStatement", "exitStatement"],
      expression,
    );
    const statement = parsed.program.statements[0];
    if (statement?.kind !== "letStatement") continue;
    let current = statement.initializer;
    let lists = 1;
    while (
      current.kind === "listLiteral" &&
      current.elements.length === 1 &&
      current.elements[0]!.kind === "listLiteral"
    ) {
      current = current.elements[0]!;
      lists += 1;
    }
    assert.equal(lists, depth, inner);
    assert.deepEqual(
      current.kind === "listLiteral" ? current.elements.map(expressionShape) : current.kind,
      innermostElements,
      inner,
    );
  }
});

type ExpressionShape = string | number | readonly ExpressionShape[];

// Compact projection: number literals by value, objects with their properties, other nodes by kind.
function expressionShape(expression: Expression): ExpressionShape {
  switch (expression.kind) {
    case "numberLiteral":
      return expression.value;
    case "objectLiteral":
      return [
        "object",
        ...expression.properties.map((property): ExpressionShape => [
          property.name.name,
          expressionShape(property.value),
        ]),
      ];
    default:
      return expression.kind;
  }
}

/**
 * The parts of a `say` that parse ahead over a value before reading it for good, each around the value `@` that holds
 * the next level, and the containers that hold that level as a statement of each form of block. `§` marks where a
 * statement or media cue starts.
 */
const PARSING_AHEAD: Readonly<Record<string, string>> = {
  "mode word": '§say bubble(color: toString(@)) "x"',
  "call named like a mode": "§say bubble(toString(@))",
  "skip word": "§say skippable (toString(@))",
  "bounded text": "§say (toString(@), instant)",
  "grouped value": '§say (toString(@)) + "x"',
  "say value": '§let m = say bubble(color: toString(@)) "x"',
};
const BLOCK_FORMS: Readonly<Record<string, string>> = {
  statement: "(timer async 1 s {@}).elapsed",
  "permanent button": 'showPermanentButton "b" {@}',
  media: 'playAudio async "a.mp3" {@}',
  "media cue": 'playAudio async "a.mp3" { §at 1 s {@} }',
};
/** Every part that parses ahead around a statement block, and every form of block under a mode word. */
const NESTINGS: readonly (readonly [string, string, string])[] = [
  ...Object.entries(PARSING_AHEAD).map(
    ([name, site]) => [`${name} around a statement block`, site, BLOCK_FORMS.statement!] as const,
  ),
  ...Object.entries(BLOCK_FORMS)
    .filter(([name]) => name !== "statement")
    .map(
      ([name, container]) =>
        [`mode word around a ${name} block`, PARSING_AHEAD["mode word"]!, container] as const,
    ),
];

/**
 * `depth` levels of `site` around `container`, around a regex the lexer reads as division until the parse asks for it,
 * with the offsets where statements and cues start. With `errors`, each block also holds an `otherwise` whose fix is
 * offered.
 */
function nested(
  site: string,
  container: string,
  depth: number,
  errors: boolean,
): { readonly source: string; readonly statements: readonly number[] } {
  let inner = "§say prose /a/";
  for (let level = 0; level < depth; level += 1) {
    const block = errors ? `\n§let v = a otherwise 1 + 2\n${inner}\n` : ` ${inner} `;
    inner = site.replace("@", () => container.replace("@", () => block));
  }
  const marked = `§let a: integer? = null\n${inner}\n`;
  const statements: number[] = [];
  let source = "";
  for (const character of marked) {
    if (character === "§") statements.push(source.length);
    else source += character;
  }
  return { source, statements };
}

/** Where the listed statements and cues start, in source order. */
function statementStarts(ranges: readonly StatementRange[]): number[] {
  return ranges
    .filter((range) => range.kind === "statement")
    .map((range) => range.start)
    .sort((left, right) => left - right);
}

/** Parses `source`, counting the tokens that the parse reads, also those that a parse ahead reads again. */
function parseCountingReads(source: string): {
  readonly parsed: ParseResult;
  readonly reads: number;
} {
  const advance = Parser.prototype.advance;
  let reads = 0;
  Parser.prototype.advance = function (this: Parser) {
    reads += 1;
    return advance.call(this);
  };
  try {
    return { parsed: parse(source), reads };
  } finally {
    Parser.prototype.advance = advance;
  }
}

test("a value that a say parses ahead over is read once, however deeply such values nest", () => {
  for (const [name, site, container] of NESTINGS) {
    const reads = [6, 12].map((depth) => {
      const { source, statements } = nested(site, container, depth, false);
      const counted = parseCountingReads(source);
      assert.deepEqual(counted.parsed.diagnostics, [], `${name}: ${source}`);
      // Each statement is listed once, also one inside a block that a parse ahead read first.
      assert.deepEqual(statementStarts(counted.parsed.statementRanges), statements, name);
      return counted.reads;
    });
    // Linear work doubles with the levels; reading each nested value again doubles it with every level.
    const ratio = reads[1]! / reads[0]!;
    assert.ok(ratio < 2.5, `${name}: ${ratio.toFixed(2)} times the work for twice the levels`);
  }
  // A `say` value inside another without a block between them, also as the key of a compact `load`, which reads it with
  // storage delimiters of its own.
  const nestings = {
    "say values": ["let m = ", "say bubble(color: toString(", '"x"', ')) "x"'],
    "say values in loads": [
      "let m = ",
      "load say bubble(color: toString(",
      '"red"',
      ')) skippable ("red", instant).text, default: "red"',
    ],
  };
  for (const [name, [start, open, inner, close]] of Object.entries(nestings)) {
    const values = (depth: number) =>
      parseCountingReads(`${start}${open!.repeat(depth)}${inner}${close!.repeat(depth)}\n`);
    const [small, large] = [values(6), values(12)];
    assert.deepEqual(large.parsed.diagnostics, [], name);
    const ratio = large.reads / small.reads;
    assert.ok(ratio < 2.5, `${name}: ${ratio.toFixed(2)} times the work for twice the levels`);
  }
});

test("the errors in a value that a say parses ahead over are reported once, with their fixes", () => {
  const readings = "'(a otherwise 1) + 2' uses 1 when 'a' is null.";
  // The diagnostics each parser adds itself: a part taken over joins its log as one segment, not as a copy.
  const added = (source: string) => {
    const push = DiagnosticLog.prototype.push;
    let pushes = 0;
    DiagnosticLog.prototype.push = function (this: DiagnosticLog, ...diagnostic) {
      pushes += 1;
      return push.apply(this, diagnostic);
    };
    try {
      parse(source);
    } finally {
      DiagnosticLog.prototype.push = push;
    }
    return pushes;
  };
  for (const [name, site, container] of NESTINGS) {
    // Copying each part's errors into every part around it adds them once per enclosing level.
    const ratio =
      added(nested(site, container, 12, true).source) /
      added(nested(site, container, 6, true).source);
    assert.ok(
      ratio < 2.5,
      `${name}: ${ratio.toFixed(2)} times the errors added for twice the levels`,
    );
    const { source, statements } = nested(site, container, 4, true);
    const parsed = parse(source);
    assert.deepEqual(
      parsed.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.span.start.offset]),
      [...source.matchAll(/otherwise/gu)].map((match) => ["TSP041", match.index]),
      `${name}: ${source}`,
    );
    for (const diagnostic of parsed.diagnostics)
      assert.ok(diagnostic.message.includes(readings), name);
    assert.deepEqual(statementStarts(parsed.statementRanges), statements, name);
  }
  // A fix for a cue position, which does not parse on its own, waits for the statement that holds the media block.
  const cue = PARSING_AHEAD["mode word"]!.replace("§", "let a: integer? = null\n").replace(
    "@",
    'playAudio async "a.mp3" { at (a otherwise 1 + 2) * 1 s { say "x" } }',
  );
  const parsed = parse(cue);
  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP041"],
  );
  assert.ok(parsed.diagnostics[0]!.message.includes(readings));
});

test("an error deep in a value that a say parses ahead over costs the same at any depth", () => {
  // One error at the bottom: each expression around it may look it up, which must not grow with the nesting.
  const lookups = (depth: number) => {
    let source = "wait 1 month";
    for (let level = 0; level < depth; level += 1)
      source = `say bubble(color: toString((timer async 1 s {\n${source}\n}).elapsed)) "x"`;
    const get = DiagnosticLog.prototype.get;
    let reads = 0;
    DiagnosticLog.prototype.get = function (this: DiagnosticLog, ...index) {
      reads += 1;
      return get.apply(this, index);
    };
    try {
      parse(`${source}\nexit\n`);
    } finally {
      DiagnosticLog.prototype.get = get;
    }
    return reads;
  };
  assert.ok(lookups(12) <= lookups(6), "lookups grow with the nesting");
  // An error in every level, each with a fix that waits for the declaration: a part with more than one error keeps none,
  // since the declaration proves a fix only as its one error.
  const keptOffers = (depth: number) => {
    let value = '"red"';
    for (let level = 0; level < depth; level += 1)
      value = `say bubble(color: toString(${value})) "x", 1 m`;
    const source = `let value = ${value}\nexit\n`;
    const parser = new Parser(readScriptHeader(lex(source)).programTokens);
    parser.shared.source = source;
    parser.parseProgram();
    let offers = 0;
    for (const parts of parser.shared.parsedParts.values())
      for (const part of parts) offers += part.fixOffers.length;
    return offers;
  };
  assert.ok(keptOffers(12) <= 2.5 * keptOffers(6), "kept fix offers grow faster than the nesting");
});
