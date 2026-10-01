import assert from "node:assert/strict";
import test from "node:test";
import { emitTease } from "../src/emit-tease.ts";
import { lowerParsedFile } from "../src/lower.ts";
import type { AstNode, ParsedGroovyFile, SourceSpan } from "../src/ast.ts";

const span: SourceSpan = { line: 1, column: 1, endLine: 1, endColumn: 2 };
const constant = (value: string | number | boolean | null): AstNode => ({ kind: "constant", span, value });
const variable = (name: string): AstNode => ({ kind: "variable", span, name, type: "java.lang.Object" });
const args = (...items: AstNode[]): AstNode => ({ kind: "arguments", span, items });
const call = (name: string, ...items: AstNode[]): AstNode => ({
  kind: "methodCall",
  span,
  object: variable("this"),
  method: constant(name),
  arguments: args(...items),
  implicitThis: true,
  safe: false,
  spreadSafe: false,
});
const statement = (expression: AstNode): AstNode => ({ kind: "expressionStatement", span, expression });

function file(statements: AstNode[]): ParsedGroovyFile {
  return {
    formatVersion: 1,
    sourceName: "fixture.groovy",
    groovyVersion: "2.5.21",
    mode: "script-body",
    diagnostics: [],
    root: { kind: "scriptBody", span: null, body: { kind: "block", span, statements } },
  };
}

test("lowers common SexScript flow to accepted TeaseScript forms", () => {
  const source = file([
    statement(call("show", constant("Hello"))),
    statement(call("wait", constant(2))),
    statement(call("waitWithGauge", constant(3))),
    statement(call("setImage", constant("scene/one.jpg"))),
    statement(call("setImage", constant(null))),
    statement(call("playSound", constant("bell.mp3"))),
    statement(call("playBackgroundSound", constant("beat.mp3"), constant(3))),
    statement(call("showButton", constant("Continue"))),
    { kind: "return", span, value: constant("next") },
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    [
      'say "Hello"',
      "wait 2",
      "timer 3",
      'showImage "scene/one.jpg"',
      "hideImage",
      'playAudio "bell.mp3"',
      'playAudio(file: "beat.mp3", async: true, repeat: 3 times)',
      'showButton "Continue"',
      'run "next.tease"',
      "",
    ].join("\n"),
  );
});

test("maps Groovy inclusive ranges and removes terminal switch breaks", () => {
  const range: AstNode = { kind: "range", span, from: constant(0), to: constant(3), inclusive: true };
  const source = file([
    {
      kind: "switch",
      span,
      expression: variable("value"),
      cases: [
        {
          kind: "case",
          span,
          expression: range,
          body: {
            kind: "block",
            span,
            statements: [statement(call("show", constant("small"))), { kind: "break", span }],
          },
        },
      ],
      default: { kind: "empty", span },
    },
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    ['switch value {', '  case 0..=3 {', '    say "small"', "  }", "}", ""].join("\n"),
  );
});

test("does not invent a TeaseScript default for nullable legacy storage", () => {
  const condition: AstNode = {
    kind: "binary",
    span,
    operator: "==",
    left: call("loadBoolean", constant("feature.enabled")),
    right: constant(false),
  };
  const source = file([
    {
      kind: "if",
      span,
      condition,
      then: { kind: "block", span, statements: [statement(call("show", constant("off")))] },
      else: { kind: "empty", span },
    },
  ]);

  const program = lowerParsedFile(source);
  assert.ok(program.diagnostics.some((diagnostic) => diagnostic.code === "SX_STORAGE_MISSING_KEY_SEMANTICS"));
  assert.match(emitTease(program), /MIGRATION INCOMPLETE/);
  assert.match(emitTease(program), /TODO SX_UNSUPPORTED_IF/);
});

test("extracts static setInfos metadata instead of emitting runtime code", () => {
  const source = file([
    statement(
      call(
        "setInfos",
        constant(9),
        constant("Example"),
        constant("Summary"),
        constant("Author"),
        constant("complete"),
        constant(0xffffff),
        constant("en"),
        { kind: "list", span, items: [constant("tag-a"), constant("tag-b")] },
      ),
    ),
    { kind: "return", span, value: constant(null) },
  ]);

  const program = lowerParsedFile(source);
  assert.equal(program.metadata?.title, "Example");
  assert.deepEqual(program.metadata?.tags, ["tag-a", "tag-b"]);
  assert.equal(emitTease(program), "end\n");
});


test("does not silently discard legacy showButton timeout/result semantics", () => {
  const timeoutSource = file([statement(call("showButton", constant("Quick"), constant(3)))]);
  const timeoutProgram = lowerParsedFile(timeoutSource);
  assert.ok(timeoutProgram.diagnostics.some((diagnostic) => diagnostic.code === "SX_BUTTON_TIMEOUT_SEMANTICS"));
  assert.match(emitTease(timeoutProgram), /MIGRATION INCOMPLETE/);

  const assignedSource = file([
    {
      kind: "expressionStatement",
      span,
      expression: {
        kind: "declaration",
        span,
        multipleAssignment: false,
        left: variable("elapsed"),
        right: call("showButton", constant("Continue")),
      },
    },
  ]);
  const assignedProgram = lowerParsedFile(assignedSource);
  assert.ok(assignedProgram.diagnostics.some((diagnostic) => diagnostic.code === "SX_BUTTON_RESULT_SEMANTICS"));
  assert.match(emitTease(assignedProgram), /MIGRATION INCOMPLETE/);
});
