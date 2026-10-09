import assert from "node:assert/strict";
import test from "node:test";

import type { Statement } from "../src/ast.js";
import { parse } from "../src/parser.js";

test("parses an empty immutable program", () => {
  const result = parse("");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program, { kind: "program", statements: [], span: sourceSpan("", 0, 0) });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.program), true);
  assert.equal(Object.isFrozen(result.program.statements), true);
});

test("parses a speaker declaration with exact nested spans", () => {
  const source = 'speaker mistressVera {\n    displayName: "Mistress Vera"\n}';
  const result = parse(source);
  const statement = result.program.statements[0];

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(statement, {
    kind: "speakerDeclaration",
    name: { kind: "identifier", name: "mistressVera", span: sourceSpan(source, 8, 20) },
    properties: [
      {
        kind: "speakerProperty",
        name: { kind: "identifier", name: "displayName", span: sourceSpan(source, 27, 38) },
        value: stringNode(source, 40, 55, "Mistress Vera"),
        span: sourceSpan(source, 27, 55),
      },
    ],
    span: sourceSpan(source, 0, source.length),
  });
  assert.equal(Object.isFrozen(statement), true);
  assert.equal(
    statement?.kind === "speakerDeclaration" && Object.isFrozen(statement.properties),
    true,
  );
});

test("continues a speaker property across a newline after ':'", () => {
  const source = 'speaker vera {\n    displayName:\n\n        // continued\n        "Vera"\n}';
  const result = parse(source);
  const valueStart = source.indexOf('"Vera"');

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program.statements[0], {
    kind: "speakerDeclaration",
    name: { kind: "identifier", name: "vera", span: sourceSpan(source, 8, 12) },
    properties: [
      {
        kind: "speakerProperty",
        name: { kind: "identifier", name: "displayName", span: sourceSpan(source, 19, 30) },
        value: stringNode(source, valueStart, valueStart + 6, "Vera"),
        span: sourceSpan(source, 19, valueStart + 6),
      },
    ],
    span: sourceSpan(source, 0, source.length),
  });
});

test("distinguishes a speaker setter from a declaration using lookahead", () => {
  const source = "speaker mistressVera\nspeaker cashier {}";
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) => statement.kind),
    ["speakerSetterStatement", "speakerDeclaration"],
  );
  assert.deepEqual(result.program.statements[0], {
    kind: "speakerSetterStatement",
    speaker: { kind: "identifier", name: "mistressVera", span: sourceSpan(source, 8, 20) },
    span: sourceSpan(source, 0, 20),
  });
  assert.deepEqual(result.program.statements[1]?.span, sourceSpan(source, 21, 39));
});

test("parses say, say as, and exit statements", () => {
  const source = 'say "Kneel."\nsay as cashier "Your total is five euros."\nexit';
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program.statements.map(projectSayStatement), [
    {
      kind: "sayStatement",
      speaker: null,
      value: stringNode(source, 4, 12, "Kneel."),
      span: sourceSpan(source, 0, 12),
    },
    {
      kind: "sayStatement",
      speaker: { kind: "identifier", name: "cashier", span: sourceSpan(source, 20, 27) },
      value: stringNode(source, 28, 55, "Your total is five euros."),
      span: sourceSpan(source, 13, 55),
    },
    { kind: "exitStatement", span: sourceSpan(source, 56, 60) },
  ]);
});

test("parses say pacing and skip syntax with pacing spans", () => {
  const source = 'say as vera unskippable "Read this", 1.5 s\nsay "Now", instant';
  const result = parse(source);
  const first = result.program.statements[0];
  const second = result.program.statements[1];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(first?.kind, "sayStatement");
  assert.equal(first?.kind === "sayStatement" ? first.skipPolicy : null, "unskippable");
  assert.deepEqual(
    first?.kind === "sayStatement" && first.pacing !== null && first.pacing !== "instant"
      ? first.pacing.span
      : null,
    sourceSpan(source, source.indexOf("1.5 s"), source.indexOf("1.5 s") + 5),
  );
  assert.deepEqual(first?.span, sourceSpan(source, 0, source.indexOf("\n")));
  assert.equal(second?.kind === "sayStatement" ? second.pacing : null, "instant");
  assert.deepEqual(second?.span, sourceSpan(source, source.indexOf('say "Now"'), source.length));
});

test("treats say skip words as modifiers only when the existing expression cannot finish", () => {
  const source = [
    'say skippable "Read this."',
    'say as vera unskippable "Read this."',
    "say skippable",
    "say unskippable",
    "say skippable + suffix",
    "say skippable, instant",
    "say as vera skippable",
    "say skippable[0]",
    "say unskippable(index)",
    "say skippable.member",
    "say unskippable.member[0]",
    "say as vera skippable[0], instant",
  ].join("\n");
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  const statements = result.program.statements.filter(
    (statement): statement is Extract<typeof statement, { kind: "sayStatement" }> =>
      statement.kind === "sayStatement",
  );
  assert.deepEqual(
    statements.map((statement) => statement.skipPolicy),
    ["skippable", "unskippable", null, null, null, null, null, null, null, null, null, null],
  );
  assert.deepEqual(
    statements.slice(2).map((statement) => statement.value.kind),
    [
      "identifier",
      "identifier",
      "binaryExpression",
      "identifier",
      "identifier",
      "indexExpression",
      "callExpression",
      "propertyAccessExpression",
      "indexExpression",
      "indexExpression",
    ],
  );
  assert.equal(statements[5]?.pacing, "instant");
  assert.equal(statements[11]?.pacing, "instant");
  assert.deepEqual(
    statements[4]?.value.span,
    sourceSpan(
      source,
      source.indexOf("skippable + suffix"),
      source.indexOf("skippable + suffix") + "skippable + suffix".length,
    ),
  );
  const indexedStart = source.lastIndexOf("skippable[0]");
  assert.deepEqual(
    statements[11]?.value.span,
    sourceSpan(source, indexedStart, indexedStart + "skippable[0]".length),
  );
});

test("rejects missing say pacing expressions", () => {
  const result = parse('say "later",');
  assert.equal(result.program.statements.length, 0);
  const missingPacing = result.diagnostics.find((diagnostic) => diagnostic.code === "TSP012");
  assert.deepEqual(missingPacing?.span, sourceSpan('say "later",', 12, 12));
});

test("preserves template text and identifier interpolation", () => {
  const source = 'say "Hello ${player}!"';
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(projectSayStatement(result.program.statements[0]), {
    kind: "sayStatement",
    speaker: null,
    value: {
      kind: "stringLiteral",
      form: "singleLine",
      parts: [
        { kind: "stringText", raw: "Hello ", value: "Hello ", span: sourceSpan(source, 5, 11) },
        {
          kind: "stringInterpolation",
          expression: { kind: "identifier", name: "player", span: sourceSpan(source, 13, 19) },
          span: sourceSpan(source, 11, 20),
        },
        { kind: "stringText", raw: "!", value: "!", span: sourceSpan(source, 20, 21) },
      ],
      span: sourceSpan(source, 4, 22),
    },
    span: sourceSpan(source, 0, 22),
  });
});

test("builds left-associated chained property access in interpolation", () => {
  const source = 'say "Hello ${player.profile.name}"';
  const result = parse(source);
  const statement = result.program.statements[0];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(statement?.kind, "sayStatement");
  if (statement?.kind !== "sayStatement" || statement.value.kind !== "stringLiteral") {
    assert.fail("Expected a template say statement.");
  }

  const interpolation = statement.value.parts[1];
  assert.deepEqual(interpolation, {
    kind: "stringInterpolation",
    expression: {
      kind: "propertyAccessExpression",
      object: {
        kind: "propertyAccessExpression",
        object: { kind: "identifier", name: "player", span: sourceSpan(source, 13, 19) },
        property: { kind: "identifier", name: "profile", span: sourceSpan(source, 20, 27) },
        span: sourceSpan(source, 13, 27),
      },
      property: { kind: "identifier", name: "name", span: sourceSpan(source, 28, 32) },
      span: sourceSpan(source, 13, 32),
    },
    span: sourceSpan(source, 11, 33),
  });
});

test("parses the contextual speaker reference in interpolation", () => {
  const source = 'say as mistressVera "You will obey your ${speaker.title}."';
  const result = parse(source);
  const statement = result.program.statements[0];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(statement?.kind, "sayStatement");
  if (statement?.kind !== "sayStatement" || statement.value.kind !== "stringLiteral") {
    assert.fail("Expected a template say statement.");
  }

  assert.deepEqual(statement.value.parts[1], {
    kind: "stringInterpolation",
    expression: {
      kind: "propertyAccessExpression",
      object: { kind: "identifier", name: "speaker", span: sourceSpan(source, 42, 49) },
      property: { kind: "identifier", name: "title", span: sourceSpan(source, 50, 55) },
      span: sourceSpan(source, 42, 55),
    },
    span: sourceSpan(source, 40, 56),
  });
});

test("accepts multiple statements separated by LF or CRLF", () => {
  const source = 'speaker vera\r\nsay "Hi"\nexit\r\n';
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) => statement.kind),
    ["speakerSetterStatement", "sayStatement", "exitStatement"],
  );
  assert.deepEqual(result.program.statements[1]?.span, sourceSpan(source, 14, 22));
  assert.deepEqual(result.program.span, sourceSpan(source, 0, source.length));
});

test("preserves decoded block values and forms", () => {
  const source = 'say """\n  one\n    two\n"""\nsay "three\\nfour"';
  const result = parse(source);
  const first = result.program.statements[0];
  const second = result.program.statements[1];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    first?.kind === "sayStatement" && first.value.kind === "stringLiteral"
      ? first.value.form
      : undefined,
    "block",
  );
  assert.equal(
    first?.kind === "sayStatement" && first.value.kind === "stringLiteral"
      ? first.value.parts[0]?.kind === "stringText"
        ? first.value.parts[0].value
        : ""
      : undefined,
    "one\n  two",
  );
  assert.equal(
    second?.kind === "sayStatement" &&
      second.value.kind === "stringLiteral" &&
      second.value.parts[0]?.kind === "stringText"
      ? second.value.parts[0].value
      : undefined,
    "three\nfour",
  );
});

function projectSayStatement(statement: Statement | undefined) {
  if (statement?.kind !== "sayStatement") {
    return statement;
  }
  return {
    kind: statement.kind,
    speaker: statement.speaker,
    value: statement.value,
    span: statement.span,
  };
}

function stringNode(source: string, start: number, end: number, value: string) {
  return {
    kind: "stringLiteral",
    form: "singleLine",
    parts: [
      {
        kind: "stringText",
        raw: source.slice(start + 1, end - 1),
        value,
        span: sourceSpan(source, start + 1, end - 1),
      },
    ],
    span: sourceSpan(source, start, end),
  };
}

function sourceSpan(source: string, start: number, end: number) {
  return { start: sourcePosition(source, start), end: sourcePosition(source, end) };
}

function sourcePosition(source: string, offset: number) {
  let line = 0;
  let column = 0;

  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\r" && source[index + 1] === "\n") {
      line += 1;
      column = 0;
      index += 1;
    } else if (source[index] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }

  return { offset, line, column };
}

test("say used as a value takes its text and pacing compact or in parentheses, while statements keep grouped values", () => {
  const parts = (source: string) => {
    const result = parse(source);
    assert.deepEqual(result.diagnostics, [], source);
    const statement = result.program.statements[0]!;
    const say =
      statement.kind === "sayStatement"
        ? statement
        : statement.kind === "letStatement" && statement.initializer.kind === "sayExpression"
          ? statement.initializer
          : null;
    assert.ok(say !== null, source);
    return [
      statement.kind,
      say.speaker?.name ?? null,
      say.presentation === null ? null : say.presentation.properties.length,
      say.skipPolicy,
      say.value.kind,
      say.pacing === null || say.pacing === "instant" ? say.pacing : say.pacing.kind,
    ];
  };
  const value = (rest: string) => [
    "letStatement",
    ...rest.split(" ").map((part) => (part === "-" ? null : part)),
  ];
  assert.deepEqual(
    parts('let line = say "Waiting.", instant'),
    value("- - - stringLiteral instant"),
  );
  assert.deepEqual(
    parts('let line = say("Strokes: 0", instant)'),
    value("- - - stringLiteral instant"),
  );
  assert.deepEqual(parts('let line = say ("x")'), value("- - - stringLiteral -"));
  // A mode with its options, then the parentheses; a skip word before parentheses is the modifier.
  assert.deepEqual(
    parts('let line = say as vera prose(color: "white") unskippable ("Waiting.", instant)'),
    ["letStatement", "vera", 2, "unskippable", "stringLiteral", "instant"],
  );
  assert.deepEqual(parts('let line = say bubble() ("Plain", 2)'), [
    "letStatement",
    null,
    1,
    null,
    "stringLiteral",
    "numberLiteral",
  ]);
  // A call of a function named like a mode keeps its meaning.
  assert.deepEqual(parts('let line = say bubble("x")'), value("- - - callExpression -"));
  assert.deepEqual(parts("let line = say skippable"), value("- - - identifier -"));
  // A statement reads parentheses as the bounded form only when a comma follows their first value.
  assert.deepEqual(parts('say("text")'), [
    "sayStatement",
    null,
    null,
    null,
    "parenthesizedExpression",
    null,
  ]);
  assert.deepEqual(parts("say (a + b), instant"), [
    "sayStatement",
    null,
    null,
    null,
    "parenthesizedExpression",
    "instant",
  ]);
  assert.deepEqual(parts("say (a) + b"), [
    "sayStatement",
    null,
    null,
    null,
    "binaryExpression",
    null,
  ]);
  assert.deepEqual(parts('say("Hi", instant)'), [
    "sayStatement",
    null,
    null,
    null,
    "stringLiteral",
    "instant",
  ]);
  assert.deepEqual(parts("say unskippable(index)"), [
    "sayStatement",
    null,
    null,
    null,
    "callExpression",
    null,
  ]);
  assert.deepEqual(parts('say bubble() ("Plain", instant)'), [
    "sayStatement",
    null,
    1,
    null,
    "stringLiteral",
    "instant",
  ]);

  // Other parentheses group a value as before, also where that value is malformed.
  const grouped = (source: string) => {
    const result = parse(source);
    return [
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.span.start.offset]),
      result.program.statements.map((statement) => [
        statement.kind,
        statement.span.start.offset,
        statement.span.end.offset,
      ]),
    ];
  };
  assert.deepEqual(grouped('say ("x") +\nexit'), [
    [
      ["TSP012", 12],
      ["TSP006", 12],
    ],
    [],
  ]);
  assert.deepEqual(grouped('say ("x"), instant, foo\nexit'), [
    [["TSP002", 18]],
    [
      ["sayStatement", 0, 18],
      ["exitStatement", 24, 28],
    ],
  ]);

  // The parentheses end the say, so commas and operators after them belong to the enclosing expression.
  const source = 'let lines = [say("A", instant), say(\n    "B",\n    instant\n).text]';
  const result = parse(source);
  assert.deepEqual(result.diagnostics, []);
  const list = result.program.statements[0];
  assert.ok(list?.kind === "letStatement" && list.initializer.kind === "listLiteral");
  const [first, second] = list.initializer.elements;
  assert.equal(first?.kind, "sayExpression");
  assert.deepEqual(
    first?.span,
    sourceSpan(source, source.indexOf("say"), source.indexOf("),") + 1),
  );
  assert.equal(second?.kind, "propertyAccessExpression");
  assert.deepEqual(
    parse('let line = say("Hi", instant').diagnostics.map((diagnostic) => diagnostic.message),
    ["Expected ')' after the text and pacing of 'say'."],
  );
});
