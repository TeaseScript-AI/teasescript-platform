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


test("preserves accepted showButton timeout and elapsed-result semantics", () => {
  const timeoutSource = file([statement(call("showButton", constant("Quick"), constant(3)))]);
  const timeoutProgram = lowerParsedFile(timeoutSource);
  assert.deepEqual(timeoutProgram.diagnostics, []);
  assert.equal(emitTease(timeoutProgram), 'showButton("Quick", 3)\n');

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
  assert.deepEqual(assignedProgram.diagnostics, []);
  assert.equal(emitTease(assignedProgram), 'let elapsed = showButton("Continue")\n');
});

test("maps legacy save(key, null) deletion semantics to delete", () => {
  const program = lowerParsedFile(file([statement(call("save", constant("intro.running"), constant(null)))]));
  assert.deepEqual(program.diagnostics, []);
  assert.equal(emitTease(program), 'delete "intro.running"\n');
});


test("lowers top-level Groovy closure helpers to TeaseScript functions with defaults and returns", () => {
  const helperClosure: AstNode = {
    kind: "closure",
    span,
    parameterSpecified: true,
    parameters: [
      { name: "count", type: "java.lang.Object", default: null },
      { name: "record", type: "java.lang.Object", default: constant(true) },
    ],
    body: {
      kind: "block",
      span,
      statements: [{ kind: "return", span, value: variable("count") }],
    },
  };
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("helper"),
      right: helperClosure,
    }),
    statement(call("helper", constant(4))),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    [
      "function helper(count, record = true) {",
      "  return count",
      "}",
      "helper(4)",
      "",
    ].join("\n"),
  );
});

test("synthesizes optional it only when an implicit Groovy closure is called with one argument", () => {
  const implicitClosure: AstNode = {
    kind: "closure",
    span,
    parameterSpecified: false,
    parameters: [],
    body: { kind: "block", span, statements: [statement(call("show", constant("ok")))] },
  };
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("helper"),
      right: implicitClosure,
    }),
    statement(call("helper", constant("ignored"))),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    [
      "function helper(it = null) {",
      '  say "ok"',
      "}",
      'helper("ignored")',
      "",
    ].join("\n"),
  );
});

test("lowers indexing, primitive casts, and compound multiplication assignments", () => {
  const indexed: AstNode = {
    kind: "binary",
    span,
    operator: "[",
    left: variable("items"),
    right: constant(1),
  };
  const cast: AstNode = { kind: "cast", span, type: "int", value: indexed };
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("value"),
      right: cast,
    }),
    statement({
      kind: "binary",
      span,
      operator: "*=",
      left: variable("value"),
      right: constant(2),
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(emitTease(program), "let value = toInteger(items[1])\nvalue = value * 2\n");
});


test("maps list-only Groovy size property and size() method to TeaseScript length", () => {
  const sizeProperty: AstNode = {
    kind: "property",
    span,
    object: variable("items"),
    property: constant("size"),
    safe: false,
    spreadSafe: false,
  };
  const sizeCall: AstNode = {
    kind: "methodCall",
    span,
    object: variable("items"),
    method: constant("size"),
    arguments: args(),
    implicitThis: false,
    safe: false,
    spreadSafe: false,
  };
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("items"),
      right: { kind: "list", span, items: [constant("a"), constant("b")] },
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("a"),
      right: sizeProperty,
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("b"),
      right: sizeCall,
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    ['let items = ["a", "b"]', "let a = items.length", "let b = items.length", ""].join("\n"),
  );
});

test("keeps mixed-type Groovy size access as a migration error", () => {
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("items"),
      right: constant("text"),
    }),
    statement({
      kind: "binary",
      span,
      operator: "=",
      left: variable("items"),
      right: { kind: "list", span, items: [constant(1)] },
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("count"),
      right: {
        kind: "property",
        span,
        object: variable("items"),
        property: constant("size"),
        safe: false,
        spreadSafe: false,
      },
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.ok(program.diagnostics.some((diagnostic) => diagnostic.code === "SX_UNSUPPORTED_PROPERTY"));
});

test("lowers direct indexed assignment targets", () => {
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("items"),
      right: { kind: "list", span, items: [constant(1), constant(2)] },
    }),
    statement({
      kind: "binary",
      span,
      operator: "=",
      left: { kind: "binary", span, operator: "[", left: variable("items"), right: constant(1) },
      right: constant(9),
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(emitTease(program), "let items = [1, 2]\nitems[1] = 9\n");
});
