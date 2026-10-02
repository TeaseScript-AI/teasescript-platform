import assert from "node:assert/strict";
import test from "node:test";
import type { AstNode, ParsedGroovyFile, SourceSpan } from "../src/ast.ts";
import { emitTease } from "../src/emit-tease.ts";
import { lowerSelfContainedPackage } from "../src/package.ts";

const span: SourceSpan = { line: 1, column: 1, endLine: 1, endColumn: 40 };
const span2: SourceSpan = { line: 2, column: 1, endLine: 2, endColumn: 40 };
const span3: SourceSpan = { line: 3, column: 1, endLine: 3, endColumn: 40 };
const constant = (value: string | number | boolean | null): AstNode => ({ kind: "constant", span, value });
const variable = (name: string): AstNode => ({ kind: "variable", span, name, type: "java.lang.Object" });
const args = (...items: AstNode[]): AstNode => ({ kind: "arguments", span, items });
const call = (object: AstNode, name: string, implicitThis: boolean, ...items: AstNode[]): AstNode => ({
  kind: "methodCall",
  span,
  object,
  method: constant(name),
  arguments: args(...items),
  implicitThis,
  safe: false,
  spreadSafe: false,
});
const statement = (expression: AstNode): AstNode => ({ kind: "expressionStatement", span, expression });
const parameter = (name: string) => ({ name, type: "java.lang.Object", hasInitialExpression: false, initialExpression: null });

function method(name: string, methodSpan: SourceSpan, parameters: ReturnType<typeof parameter>[], statements: AstNode[]): AstNode {
  return {
    kind: "method",
    span: methodSpan,
    name,
    returnType: "java.lang.Object",
    modifiers: 9,
    parameters,
    body: { kind: "block", span: methodSpan, statements },
  };
}

function helperUnit(): ParsedGroovyFile {
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
      classes: [{
        kind: "class",
        span,
        name: "Helper",
        modifiers: 1,
        methods: [
          method("used", span, [parameter("main"), parameter("value")], [
            { kind: "return", span, value: call(variable("this"), "nested", true, variable("main"), variable("value")) },
          ]),
          method("nested", span2, [parameter("main"), parameter("value")], [
            { kind: "return", span: span2, value: { kind: "variable", span: span2, name: "value", type: "java.lang.Object" } },
          ]),
          method("unusedBroken", span3, [parameter("main")], [
            {
              kind: "expressionStatement",
              span: span3,
              expression: { kind: "constructorCall", span: span3, type: "java.io.File", arguments: args(constant("x")) },
            },
          ]),
        ],
      }],
    },
  };
}

function scriptBody(): ParsedGroovyFile {
  return {
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
            right: { kind: "constructorCall", span, type: "groovy.lang.GroovyClassLoader", arguments: args() },
          }),
          statement(call(variable("loader"), "addClasspath", false, constant("helpers"))),
          statement({
            kind: "declaration",
            span,
            multipleAssignment: false,
            left: variable("HelperApi"),
            right: call(variable("loader"), "loadClass", false, constant("Helper")),
          }),
          statement(call(variable("HelperApi"), "used", false, variable("this"), constant(3))),
        ],
      },
    },
  };
}

test("self-contained package output includes only transitively required helper functions", () => {
  const [helper, script] = lowerSelfContainedPackage([helperUnit(), scriptBody()]);
  assert.ok(helper.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
  assert.deepEqual(script.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  assert.equal(
    emitTease(script),
    [
      "function used(value) {",
      "  return nested(value)",
      "}",
      "function nested(value) {",
      "  return value",
      "}",
      "used(3)",
      "",
    ].join("\n"),
  );
});


test("flags package calls whose helper implementation cannot be emitted", () => {
  const helper = helperUnit();
  if (helper.root?.kind !== "compilationUnit") throw new Error("fixture has no helper class");
  const helperClass = (helper.root.classes as AstNode[])[0]!;
  helperClass.fields = [{
    kind: "field",
    span,
    name: "counter",
    type: "java.lang.Integer",
    modifiers: 9,
    static: true,
    final: false,
    initialExpression: constant(0),
  }];

  const [, script] = lowerSelfContainedPackage([helper, scriptBody()]);
  assert.ok(script.diagnostics.some((diagnostic) => diagnostic.code === "SX_UNRESOLVED_PACKAGE_CALL"));
});
