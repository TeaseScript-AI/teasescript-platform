import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../src/parser.js";

test("parses an empty immutable program", () => {
  const result = parse("");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program, {
    kind: "program",
    statements: [],
    span: sourceSpan("", 0, 0),
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.program), true);
  assert.equal(Object.isFrozen(result.program.statements), true);
});

test("parses a speaker declaration with exact nested spans", () => {
  const source =
    'speaker mistressVera {\n    displayName: "Mistress Vera"\n}';
  const result = parse(source);
  const statement = result.program.statements[0];

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(statement, {
    kind: "speakerDeclaration",
    name: {
      kind: "identifier",
      name: "mistressVera",
      span: sourceSpan(source, 8, 20),
    },
    properties: [
      {
        kind: "speakerProperty",
        name: {
          kind: "identifier",
          name: "displayName",
          span: sourceSpan(source, 27, 38),
        },
        value: {
          kind: "stringLiteral",
          raw: '"Mistress Vera"',
          value: "Mistress Vera",
          span: sourceSpan(source, 40, 55),
        },
        span: sourceSpan(source, 27, 55),
      },
    ],
    span: sourceSpan(source, 0, source.length),
  });
  assert.equal(Object.isFrozen(statement), true);
  assert.equal(
    statement?.kind === "speakerDeclaration" &&
      Object.isFrozen(statement.properties),
    true,
  );
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
    speaker: {
      kind: "identifier",
      name: "mistressVera",
      span: sourceSpan(source, 8, 20),
    },
    span: sourceSpan(source, 0, 20),
  });
  assert.deepEqual(result.program.statements[1]?.span, sourceSpan(source, 21, 39));
});

test("parses say, say as, and exit statements", () => {
  const source =
    'say "Kneel."\nsay as cashier "Your total is five euros."\nexit';
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program.statements, [
    {
      kind: "sayStatement",
      speaker: null,
      value: {
        kind: "stringLiteral",
        raw: '"Kneel."',
        value: "Kneel.",
        span: sourceSpan(source, 4, 12),
      },
      span: sourceSpan(source, 0, 12),
    },
    {
      kind: "sayStatement",
      speaker: {
        kind: "identifier",
        name: "cashier",
        span: sourceSpan(source, 20, 27),
      },
      value: {
        kind: "stringLiteral",
        raw: '"Your total is five euros."',
        value: "Your total is five euros.",
        span: sourceSpan(source, 28, 55),
      },
      span: sourceSpan(source, 13, 55),
    },
    {
      kind: "exitStatement",
      span: sourceSpan(source, 56, 60),
    },
  ]);
});

test("preserves template text and identifier interpolation", () => {
  const source = "say `Hello ${player}!`";
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program.statements[0], {
    kind: "sayStatement",
    speaker: null,
    value: {
      kind: "templateLiteral",
      parts: [
        {
          kind: "templateText",
          raw: "Hello ",
          value: "Hello ",
          span: sourceSpan(source, 5, 11),
        },
        {
          kind: "templateInterpolation",
          expression: {
            kind: "identifier",
            name: "player",
            span: sourceSpan(source, 13, 19),
          },
          span: sourceSpan(source, 11, 20),
        },
        {
          kind: "templateText",
          raw: "!",
          value: "!",
          span: sourceSpan(source, 20, 21),
        },
      ],
      span: sourceSpan(source, 4, 22),
    },
    span: sourceSpan(source, 0, 22),
  });
});

test("builds left-associated chained property access in interpolation", () => {
  const source = "say `Hello ${player.profile.name}`";
  const result = parse(source);
  const statement = result.program.statements[0];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(statement?.kind, "sayStatement");
  if (
    statement?.kind !== "sayStatement" ||
    statement.value.kind !== "templateLiteral"
  ) {
    assert.fail("Expected a template say statement.");
  }

  const interpolation = statement.value.parts[1];
  assert.deepEqual(interpolation, {
    kind: "templateInterpolation",
    expression: {
      kind: "propertyAccessExpression",
      object: {
        kind: "propertyAccessExpression",
        object: {
          kind: "identifier",
          name: "player",
          span: sourceSpan(source, 13, 19),
        },
        property: {
          kind: "identifier",
          name: "profile",
          span: sourceSpan(source, 20, 27),
        },
        span: sourceSpan(source, 13, 27),
      },
      property: {
        kind: "identifier",
        name: "name",
        span: sourceSpan(source, 28, 32),
      },
      span: sourceSpan(source, 13, 32),
    },
    span: sourceSpan(source, 11, 33),
  });
});

test("parses the contextual speaker reference in interpolation", () => {
  const source =
    "say as mistressVera `You will obey your ${speaker.title}.`";
  const result = parse(source);
  const statement = result.program.statements[0];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(statement?.kind, "sayStatement");
  if (
    statement?.kind !== "sayStatement" ||
    statement.value.kind !== "templateLiteral"
  ) {
    assert.fail("Expected a template say statement.");
  }

  assert.deepEqual(statement.value.parts[1], {
    kind: "templateInterpolation",
    expression: {
      kind: "propertyAccessExpression",
      object: {
        kind: "identifier",
        name: "speaker",
        span: sourceSpan(source, 42, 49),
      },
      property: {
        kind: "identifier",
        name: "title",
        span: sourceSpan(source, 50, 55),
      },
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

test("preserves decoded multiline string and template values", () => {
  const source = 'say "one\n  two"\nsay `three\r\n  four`';
  const result = parse(source);
  const first = result.program.statements[0];
  const second = result.program.statements[1];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    first?.kind === "sayStatement" && first.value.kind === "stringLiteral"
      ? first.value.value
      : undefined,
    "one two",
  );
  assert.equal(
    second?.kind === "sayStatement" &&
      second.value.kind === "templateLiteral" &&
      second.value.parts[0]?.kind === "templateText"
      ? second.value.parts[0].value
      : undefined,
    "three four",
  );
});

function sourceSpan(source: string, start: number, end: number): object {
  return {
    start: sourcePosition(source, start),
    end: sourcePosition(source, end),
  };
}

function sourcePosition(source: string, offset: number): object {
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
