import assert from "node:assert/strict";
import test from "node:test";
import { emitTease } from "../src/emit-tease.ts";
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
const call = (
  object: AstNode,
  name: string,
  implicitThis: boolean,
  ...items: AstNode[]
): AstNode => ({
  kind: "methodCall",
  span,
  object,
  method: constant(name),
  arguments: args(...items),
  implicitThis,
  safe: false,
  spreadSafe: false,
});
const statement = (expression: AstNode): AstNode => ({
  kind: "expressionStatement",
  span,
  expression,
});
const parameter = (name: string, initialExpression: AstNode | null = null) => ({
  name,
  type: "java.lang.Object",
  hasInitialExpression: initialExpression !== null,
  initialExpression,
});

function method(
  name: string,
  parameters: ReturnType<typeof parameter>[],
  statements: AstNode[],
): AstNode {
  return {
    kind: "method",
    span,
    name,
    returnType: "java.lang.Object",
    modifiers: 9,
    parameters,
    body: { kind: "block", span, statements },
  };
}

function unit(methods: AstNode[], fields: AstNode[] = []): ParsedGroovyFile {
  return {
    formatVersion: 1,
    sourceName: "Helper.groovy",
    groovyVersion: "2.5.21",
    mode: "unit",
    diagnostics: [],
    root: {
      kind: "compilationUnit",
      span: null,
      topLevel: { kind: "block", span: null, statements: [] },
      classes: [{ kind: "class", span, name: "Helper", modifiers: 1, fields, methods }],
    },
  };
}

test("lowers an auxiliary Groovy helper class to ordinary TeaseScript functions", () => {
  const source = unit([
    method(
      "helper",
      [parameter("main"), parameter("count")],
      [
        statement(call(variable("main"), "show", false, constant("Working"))),
        statement(call(variable("this"), "sleep", true, constant(15000))),
        { kind: "return", span, value: variable("count") },
      ],
    ),
    method(
      "wrapper",
      [parameter("main"), parameter("value")],
      [
        {
          kind: "return",
          span,
          value: call(variable("this"), "helper", true, variable("main"), variable("value")),
        },
      ],
    ),
  ]);

  const program = lowerParsedFile(source);
  assert.deepEqual(
    program.diagnostics.map((diagnostic) => diagnostic.code),
    ["SX_WAIT_KEPT", "SX_WAIT_KEPT_PACED"],
  );
  assert.equal(
    emitTease(program),
    [
      "function helper(count) {",
      '  say "Working"',
      "  wait 15000 ms",
      "  return count",
      "}",
      "function wrapper(value) {",
      "  return helper(value)",
      "}",
      "",
    ].join("\n"),
  );
});

test("preserves helper parameter defaults while removing the legacy main parameter", () => {
  const program = lowerParsedFile(
    unit([
      method(
        "helper",
        [parameter("main"), parameter("popup", constant(null))],
        [{ kind: "return", span, value: variable("popup") }],
      ),
    ]),
  );

  assert.deepEqual(program.diagnostics, []);
  assert.equal(emitTease(program), "function helper(popup = null) {\n  return popup\n}\n");
});

test("does not leak the legacy main host object into TeaseScript values", () => {
  const program = lowerParsedFile(
    unit([method("bad", [parameter("main")], [{ kind: "return", span, value: variable("main") }])]),
  );

  assert.ok(program.diagnostics.some((diagnostic) => diagnostic.code === "SX_HELPER_MAIN_VALUE"));
  assert.match(emitTease(program), /MIGRATION INCOMPLETE/);
});

test("package-aware lowering reconnects proven legacy helper calls without choosing module syntax", async () => {
  const helper = unit([
    method(
      "helper",
      [parameter("main"), parameter("count")],
      [{ kind: "return", span, value: variable("count") }],
    ),
  ]);
  const script: ParsedGroovyFile = {
    formatVersion: 1,
    sourceName: "script.groovy",
    groovyVersion: "2.5.21",
    mode: "script-body",
    diagnostics: [],
    root: {
      kind: "scriptBody",
      span: null,
      body: {
        kind: "block",
        span,
        statements: [
          statement({
            kind: "declaration",
            span,
            multipleAssignment: false,
            left: variable("loader"),
            right: {
              kind: "constructorCall",
              span,
              type: "groovy.lang.GroovyClassLoader",
              arguments: args(),
            },
          }),
          statement(call(variable("loader"), "addClasspath", false, constant("Domme3"))),
          statement({
            kind: "declaration",
            span,
            multipleAssignment: false,
            left: variable("Domme3"),
            right: call(variable("loader"), "loadClass", false, constant("Helper")),
          }),
          statement(call(variable("Domme3"), "helper", false, variable("this"), constant(3))),
        ],
      },
    },
  };

  const { buildHelperRegistry } = await import("../src/lower.ts");
  const helperRegistry = buildHelperRegistry([helper, script]);
  const program = lowerParsedFile(script, { helperRegistry });
  assert.equal(
    program.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    0,
  );
  assert.equal(emitTease(program), "helper(3)\nexit\n");
});

test("keeps static helper fields as package variables and flags instance fields", () => {
  const field = (isStatic: boolean) => ({
    kind: "field",
    span,
    name: "counter",
    type: "java.lang.Integer",
    modifiers: isStatic ? 9 : 1,
    static: isStatic,
    final: false,
    initialExpression: constant(0),
  });
  const helper = [
    method("helper", [parameter("main")], [{ kind: "return", span, value: constant(1) }]),
  ];

  const shared = lowerParsedFile(unit(helper, [field(true)]));
  assert.ok(!shared.diagnostics.some((diagnostic) => diagnostic.code === "SX_HELPER_SHARED_STATE"));
  assert.match(emitTease(shared), /^let counter = 0$/mu);
  // A method updates the field that no method assigns; the class declares it.
  const update = method(
    "count",
    [parameter("main")],
    [
      statement({
        kind: "binary",
        span,
        operator: "+=",
        left: variable("counter"),
        right: constant(1),
      }),
    ],
  );
  const updated = lowerParsedFile(unit([update], [field(true)]), { packageFunctions: new Set() });
  assert.ok(!updated.diagnostics.some((diagnostic) => diagnostic.code === "SX_UNDEFINED_VARIABLE"));
  assert.match(emitTease(updated), /^ {2}counter \+= 1$/mu);

  const instance = lowerParsedFile(unit(helper, [field(false)]));
  assert.ok(
    instance.diagnostics.some((diagnostic) => diagnostic.code === "SX_HELPER_SHARED_STATE"),
  );
  assert.deepEqual(instance.statements, []);
});
