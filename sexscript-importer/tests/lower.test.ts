import assert from "node:assert/strict";
import test from "node:test";
import { emitTease } from "../src/emit-tease.ts";
import { rootDiagnostics } from "../src/diagnostics.ts";
import { lowerParsedFile } from "../src/lower.ts";
import type { AstNode, ParsedGroovyFile, SourceSpan } from "../src/ast.ts";

const span: SourceSpan = { line: 1, column: 1, endLine: 1, endColumn: 2 };
const constant = (value: string | number | boolean | null): AstNode => ({
  kind: "constant",
  span,
  value,
});
const variable = (name: string): AstNode => ({
  kind: "variable",
  span,
  name,
  type: "java.lang.Object",
});
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
const statement = (expression: AstNode): AstNode => ({
  kind: "expressionStatement",
  span,
  expression,
});

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
  const range: AstNode = {
    kind: "range",
    span,
    from: constant(0),
    to: constant(3),
    inclusive: true,
  };
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
    ["switch value {", "  case 0..=3 {", '    say "small"', "  }", "}", ""].join("\n"),
  );
});

test("lowers nullable legacy scalar storage reads to read-only TeaseScript load", () => {
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("enabled"),
      right: call("loadBoolean", constant("feature.enabled")),
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("raw"),
      right: call("load", constant("legacy.raw")),
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    ['let enabled = load "feature.enabled"', 'let raw = load "legacy.raw"', ""].join("\n"),
  );
});

test("keeps legacy loadMap filtering semantics explicit", () => {
  const mapProgram = lowerParsedFile(
    file([
      statement({
        kind: "declaration",
        span,
        multipleAssignment: false,
        left: variable("map"),
        right: call("loadMap", constant("legacy.map")),
      }),
    ]),
  );
  assert.ok(
    mapProgram.diagnostics.some((diagnostic) => diagnostic.code === "SX_STORAGE_MAP_SEMANTICS"),
  );
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
  // No runtime setInfos code; the metadata survives as a header, and the final `return null` adds nothing.
  assert.equal(
    emitTease(program),
    [
      "// Legacy SexScript metadata",
      "// Title: Example",
      "// Author: Author",
      "// Summary: Summary",
      "// Language: en",
      "// Tags: tag-a, tag-b",
      "",
    ].join("\n"),
  );
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
  // Legacy returned the seconds until the click; the accepted result is a duration (V30 §21).
  assert.equal(emitTease(assignedProgram), 'let elapsed = showButton("Continue") / 1 s\n');
});

test("maps legacy save(key, null) deletion semantics to delete", () => {
  const program = lowerParsedFile(
    file([statement(call("save", constant("intro.running"), constant(null)))]),
  );
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
    body: { kind: "block", span, statements: [{ kind: "return", span, value: variable("count") }] },
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
    ["function helper(count, record = true) {", "  return count", "}", "helper(4)", ""].join("\n"),
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
    ["function helper(it = null) {", '  say "ok"', "}", 'helper("ignored")', ""].join("\n"),
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
  assert.ok(
    program.diagnostics.some((diagnostic) => diagnostic.code === "SX_UNSUPPORTED_PROPERTY"),
  );
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

test("maps literal getSelectedValue options to zero-based numeric choice labels", () => {
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("selected"),
      right: call("getSelectedValue", constant("Choose one"), {
        kind: "list",
        span,
        items: [constant("First"), constant("Second"), constant("Third")],
      }),
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    ['say "Choose one"', 'let selected = choose 0: "First", 1: "Second", 2: "Third"', ""].join(
      "\n",
    ),
  );
});

test("keeps dynamic getSelectedValue option lists explicit", () => {
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("selected"),
      right: call("getSelectedValue", constant("Choose one"), variable("options")),
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.ok(
    program.diagnostics.some((diagnostic) => diagnostic.code === "SX_DYNAMIC_CHOICE_OPTIONS"),
  );
});

test("lowers simple C-style for loops through an equivalent while loop", () => {
  const source = file([
    {
      kind: "for",
      span,
      variable: "forLoopDummyParameter",
      collection: {
        kind: "list",
        span,
        items: [
          {
            kind: "declaration",
            span,
            multipleAssignment: false,
            left: variable("i"),
            right: constant(0),
          },
          { kind: "binary", span, operator: "<", left: variable("i"), right: constant(3) },
          { kind: "postfix", span, operator: "++", value: variable("i") },
        ],
      },
      body: { kind: "block", span, statements: [statement(call("show", variable("i")))] },
    },
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    ["let i = 0", "while i < 3 {", "  say i", "  i += 1", "}", ""].join("\n"),
  );
});

test("runs the update step of a C-style for loop before continue", () => {
  const skipOne: AstNode = {
    kind: "if",
    span,
    condition: { kind: "binary", span, operator: "==", left: variable("i"), right: constant(1) },
    then: { kind: "continue", span },
    else: { kind: "empty", span },
  };
  const source = file([
    {
      kind: "for",
      span,
      variable: "forLoopDummyParameter",
      collection: {
        kind: "list",
        span,
        items: [
          {
            kind: "declaration",
            span,
            multipleAssignment: false,
            left: variable("i"),
            right: constant(0),
          },
          { kind: "binary", span, operator: "<", left: variable("i"), right: constant(3) },
          { kind: "postfix", span, operator: "++", value: variable("i") },
        ],
      },
      body: {
        kind: "block",
        span,
        statements: [skipOne, statement(call("show", variable("i"))), { kind: "continue", span }],
      },
    },
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    [
      "let i = 0",
      "while i < 3 {",
      "  if i == 1 {",
      "    i += 1",
      "    continue",
      "  }",
      "  say i",
      "  i += 1",
      "}",
      "",
    ].join("\n"),
  );
});

test("lowers Groovy each() on ranges and proven lists to TeaseScript for loops", () => {
  const rangeEach: AstNode = {
    kind: "methodCall",
    span,
    object: { kind: "range", span, from: constant(1), to: constant(3), inclusive: true },
    method: constant("each"),
    arguments: {
      kind: "arguments",
      span,
      items: [
        {
          kind: "closure",
          span,
          parameters: [],
          parameterSpecified: false,
          body: { kind: "block", span, statements: [statement(call("show", variable("it")))] },
        },
      ],
    },
    implicitThis: false,
    safe: false,
    spreadSafe: false,
  };
  const listEach: AstNode = {
    kind: "methodCall",
    span,
    object: variable("items"),
    method: constant("each"),
    arguments: {
      kind: "arguments",
      span,
      items: [
        {
          kind: "closure",
          span,
          parameters: [],
          parameterSpecified: false,
          body: { kind: "block", span, statements: [statement(call("show", variable("it")))] },
        },
      ],
    },
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
    statement(rangeEach),
    statement(listEach),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    [
      'let items = ["a", "b"]',
      "for it in 1..=3 {",
      "  say it",
      "}",
      "for it in items {",
      "  say it",
      "}",
      "",
    ].join("\n"),
  );
});

test("turns return inside Groovy each() into continue", () => {
  const eachWith = (body: AstNode[]): AstNode =>
    statement({
      kind: "methodCall",
      span,
      object: { kind: "range", span, from: constant(1), to: constant(3), inclusive: true },
      method: constant("each"),
      arguments: {
        kind: "arguments",
        span,
        items: [
          {
            kind: "closure",
            span,
            parameters: [],
            parameterSpecified: false,
            body: { kind: "block", span, statements: body },
          },
        ],
      },
      implicitThis: false,
      safe: false,
      spreadSafe: false,
    });
  const skipTwo: AstNode = {
    kind: "if",
    span,
    condition: { kind: "binary", span, operator: "==", left: variable("it"), right: constant(2) },
    then: { kind: "return", span, value: constant("ignored") },
    else: { kind: "empty", span },
  };
  const program = lowerParsedFile(
    file([eachWith([skipTwo, statement(call("show", variable("it")))])]),
  );
  assert.deepEqual(
    program.diagnostics.map((diagnostic) => diagnostic.code),
    ["SX_EACH_RETURN_CONTINUE"],
  );
  assert.equal(
    emitTease(program),
    [
      "// NOTE SX_EACH_RETURN_CONTINUE line 1: Groovy return inside each() ended only the current iteration and each() discarded its value; it becomes continue. Check whether leaving the enclosing function was intended.",
      "for it in 1..=3 {",
      "  if it == 2 {",
      "    continue",
      "  }",
      "  say it",
      "}",
      "",
    ].join("\n"),
  );

  // Inside a nested loop, continue would continue the wrong loop.
  const nested = lowerParsedFile(
    file([
      eachWith([
        {
          kind: "while",
          span,
          condition: constant(true),
          body: { kind: "block", span, statements: [{ kind: "return", span, value: null }] },
        },
      ]),
    ]),
  );
  assert.ok(nested.diagnostics.some((diagnostic) => diagnostic.code === "SX_EACH_RETURN"));
});

test("lowers single-statement if, else, and else-if bodies", () => {
  const source = file([
    {
      kind: "if",
      span,
      condition: variable("first"),
      then: statement({
        kind: "binary",
        span,
        operator: "=",
        left: variable("value"),
        right: constant(1),
      }),
      else: {
        kind: "if",
        span,
        condition: variable("second"),
        then: { kind: "return", span, value: constant(null) },
        else: statement({
          kind: "binary",
          span,
          operator: "=",
          left: variable("value"),
          right: constant(2),
        }),
      },
    },
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(
    program.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  assert.equal(
    emitTease(program),
    [
      "// NOTE SX_CONDITION_TYPE line 1: Condition is not proven boolean; TeaseScript conditions must be boolean, unlike Groovy truthiness. Verify or compare explicitly.",
      "if first {",
      "  value = 1",
      "} else if second {",
      "  end",
      "} else {",
      "  value = 2",
      "}",
      "",
    ].join("\n"),
  );
});

test("recognizes GroovyClassLoader boilerplate as legacy helper setup", () => {
  const classLoader: AstNode = {
    kind: "constructorCall",
    span,
    type: "groovy.lang.GroovyClassLoader",
    arguments: args(),
  };
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("cl"),
      right: classLoader,
    }),
    statement({
      kind: "methodCall",
      span,
      object: variable("cl"),
      method: constant("addClasspath"),
      arguments: args(constant("scripts/Domme3/")),
      implicitThis: false,
      safe: false,
      spreadSafe: false,
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("Domme3"),
      right: {
        kind: "methodCall",
        span,
        object: variable("cl"),
        method: constant("loadClass"),
        arguments: args(constant("Domme3Class")),
        implicitThis: false,
        safe: false,
        spreadSafe: false,
      },
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("chance"),
      right: {
        kind: "methodCall",
        span,
        object: variable("Domme3"),
        method: constant("percentChance"),
        arguments: args(variable("this"), constant(50)),
        implicitThis: false,
        safe: false,
        spreadSafe: false,
      },
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.equal(
    program.diagnostics.filter((diagnostic) => diagnostic.severity === "info").length,
    3,
  );
  assert.ok(program.diagnostics.some((diagnostic) => diagnostic.code === "SX_LEGACY_HELPER_CALL"));
  assert.ok(
    !program.diagnostics.some((diagnostic) => diagnostic.code === "SX_DYNAMIC_OR_OBJECT_CALL"),
  );
});

test("expands Groovy switch fallthrough into explicit TeaseScript case bodies", () => {
  const source = file([
    {
      kind: "switch",
      span,
      expression: variable("value"),
      cases: [
        {
          kind: "case",
          span,
          expression: constant(0),
          body: { kind: "block", span, statements: [statement(call("show", constant("zero")))] },
        },
        {
          kind: "case",
          span,
          expression: constant(1),
          body: {
            kind: "block",
            span,
            statements: [statement(call("show", constant("one"))), { kind: "break", span }],
          },
        },
        {
          kind: "case",
          span,
          expression: constant(2),
          body: { kind: "block", span, statements: [statement(call("show", constant("two")))] },
        },
      ],
      default: {
        kind: "block",
        span,
        statements: [statement(call("show", constant("default"))), { kind: "break", span }],
      },
    },
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(
    program.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  assert.equal(
    emitTease(program),
    [
      "switch value {",
      "  case 0 {",
      '    say "zero"',
      '    say "one"',
      "  }",
      "  case 1 {",
      '    say "one"',
      "  }",
      "  case 2 {",
      '    say "two"',
      '    say "default"',
      "  }",
      "  default {",
      '    say "default"',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("maps proven Math ceil/floor and list add to accepted TeaseScript operations", () => {
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("items"),
      right: { kind: "list", span, items: [constant(1)] },
    }),
    statement({
      kind: "methodCall",
      span,
      object: variable("items"),
      method: constant("add"),
      arguments: args(constant(2)),
      implicitThis: false,
      safe: false,
      spreadSafe: false,
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("high"),
      right: {
        kind: "methodCall",
        span,
        object: variable("Math"),
        method: constant("ceil"),
        arguments: args(constant(2.1)),
        implicitThis: false,
        safe: false,
        spreadSafe: false,
      },
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("low"),
      right: {
        kind: "methodCall",
        span,
        object: variable("Math"),
        method: constant("floor"),
        arguments: args(constant(2.9)),
        implicitThis: false,
        safe: false,
        spreadSafe: false,
      },
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(
    program.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  assert.equal(
    emitTease(program),
    ["let items = [1]", "items.add(2)", "let high = ceil(2.1)", "let low = floor(2.9)", ""].join(
      "\n",
    ),
  );
});

test("maps System.exit and Math.round with notes but keeps Java reflection manual", () => {
  const source = file([
    statement({
      kind: "methodCall",
      span,
      object: variable("System"),
      method: constant("exit"),
      arguments: args(constant(0)),
      implicitThis: false,
      safe: false,
      spreadSafe: false,
    }),
    statement({
      kind: "methodCall",
      span,
      object: variable("Math"),
      method: constant("round"),
      arguments: args(constant(2.5)),
      implicitThis: false,
      safe: false,
      spreadSafe: false,
    }),
    statement({
      kind: "methodCall",
      span,
      object: {
        kind: "methodCall",
        span,
        object: variable("clazz"),
        method: constant("getMethod"),
        arguments: args(constant("x")),
        implicitThis: false,
        safe: false,
        spreadSafe: false,
      },
      method: constant("get"),
      arguments: args(),
      implicitThis: false,
      safe: false,
      spreadSafe: false,
    }),
  ]);

  const program = lowerParsedFile(source);
  const severities = new Map(
    program.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity]),
  );
  assert.equal(severities.get("SX_SYSTEM_EXIT"), "warning");
  assert.equal(severities.get("SX_ROUNDING_TIES"), "warning");
  assert.equal(severities.get("SX_JAVA_REFLECTION"), "error");
  const output = emitTease(program);
  assert.match(output, /^exit$/m);
  assert.match(output, /^round\(2\.5\)$/m);
});

test("lowers static Groovy maps and string-key access to TeaseScript objects", () => {
  const exercise: AstNode = {
    kind: "map",
    span,
    entries: [
      { kind: "mapEntry", span, key: constant("name"), value: constant("Squats") },
      {
        kind: "mapEntry",
        span,
        key: constant("pictures"),
        value: { kind: "list", span, items: [constant("a.jpg")] },
      },
    ],
  };
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("exercise"),
      right: exercise,
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("name"),
      right: {
        kind: "binary",
        span,
        operator: "[",
        left: variable("exercise"),
        right: constant("name"),
      },
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    'let exercise = { name: "Squats", pictures: ["a.jpg"] }\nlet name = exercise.name\n',
  );
});

test("generates ordinary TeaseScript helpers for legacy loadFirstTrue and list indexOf", () => {
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
      left: variable("index"),
      right: {
        kind: "methodCall",
        span,
        object: variable("items"),
        method: constant("indexOf"),
        arguments: args(constant("b")),
        implicitThis: false,
        safe: false,
        spreadSafe: false,
      },
    }),
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("key"),
      right: call("loadFirstTrue", constant("a"), constant("b")),
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  const output = emitTease(program);
  assert.match(output, /function sexscriptLegacyLoadFirstTrue\(keys\)/);
  // Helper parameters may not shadow the script's globals `items`, `index`, and `key`.
  assert.match(output, /function sexscriptLegacyIndexOf\(itemsValue, value\)/);
  assert.match(output, /for keyValue in keys \{/);
  assert.match(output, /let index = sexscriptLegacyIndexOf\(items, "b"\)/);
  assert.match(output, /let key = sexscriptLegacyLoadFirstTrue\(\["a", "b"\]\)/);
});

test("maps legacy getBooleans to accepted askBooleans", () => {
  const source = file([
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable("selected"),
      right: call(
        "getBooleans",
        constant("Choose"),
        { kind: "list", span, items: [constant("A"), constant("B")] },
        { kind: "list", span, items: [constant(true), constant(false)] },
      ),
    }),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(program.diagnostics, []);
  assert.equal(
    emitTease(program),
    'let selected = askBooleans(message: "Choose", texts: ["A", "B"], defaults: [true, false])\n',
  );
});

test("reports a lookup with a text key as map access instead of list indexing", () => {
  const declaration = (name: string, right: AstNode): AstNode =>
    statement({
      kind: "declaration",
      span,
      multipleAssignment: false,
      left: variable(name),
      right,
    });
  const program = lowerParsedFile(
    file([
      declaration("key", constant("collar")),
      declaration("found", {
        kind: "binary",
        span,
        operator: "[",
        left: variable("registry"),
        right: variable("key"),
      }),
    ]),
  );
  assert.deepEqual(
    program.diagnostics.map(({ code }) => code),
    ["SX_DYNAMIC_MAP_ACCESS", "SX_UNSUPPORTED_DECLARATION_VALUE"],
  );
});

test("counts an unsupported map key write once, at its root cause", () => {
  const position = (column: number, endColumn: number): SourceSpan => ({
    line: 1,
    column,
    endLine: 1,
    endColumn,
  });
  const lookup = {
    code: "SX_DYNAMIC_MAP_ACCESS",
    severity: "error" as const,
    message: "runtime key",
    span: position(1, 5),
  };
  const target = {
    code: "SX_UNSUPPORTED_ASSIGNMENT_TARGET",
    severity: "error" as const,
    message: "target",
    span: position(1, 9),
  };
  assert.deepEqual(rootDiagnostics([lookup, target]), [lookup]);
});
