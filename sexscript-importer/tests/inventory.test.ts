import assert from "node:assert/strict";
import test from "node:test";
import { inventoryFiles } from "../src/inventory.ts";
import type { ParsedGroovyFile, SourceSpan } from "../src/ast.ts";

const span: SourceSpan = { line: 1, column: 1, endLine: 1, endColumn: 5 };
const constant = (value: string) => ({ kind: "constant", span, value });
const variable = (name: string) => ({ kind: "variable", span, name, type: "java.lang.Object" });

test("classifies inherited and helper-receiver SexScript API calls", () => {
  const file: ParsedGroovyFile = {
    formatVersion: 1,
    sourceName: "fixture.groovy",
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
          {
            kind: "expressionStatement",
            span,
            expression: {
              kind: "methodCall",
              span,
              object: variable("this"),
              method: constant("show"),
              arguments: { kind: "arguments", span, items: [constant("Hello")] },
              implicitThis: true,
            },
          },
          {
            kind: "expressionStatement",
            span,
            expression: {
              kind: "methodCall",
              span,
              object: variable("main"),
              method: constant("getRandom"),
              arguments: { kind: "arguments", span, items: [] },
              implicitThis: false,
            },
          },
          {
            kind: "expressionStatement",
            span,
            expression: {
              kind: "methodCall",
              span,
              object: variable("helper"),
              method: constant("show"),
              arguments: { kind: "arguments", span, items: [] },
              implicitThis: false,
            },
          },
        ],
      },
    },
  };

  const report = inventoryFiles([file]);
  assert.equal(report.fileCount, 1);
  assert.deepEqual(report.methodCalls, { show: 2, getRandom: 1 });
  assert.deepEqual(report.sexScriptApiCalls, { getRandom: 1, show: 1 });
  assert.deepEqual(report.mainReceiverCalls, { getRandom: 1 });
});

test("reports parser failures and unsupported Groovy nodes", () => {
  const parsed: ParsedGroovyFile = {
    formatVersion: 1,
    sourceName: "unsupported.groovy",
    groovyVersion: "2.5.21",
    mode: "script-body",
    diagnostics: [],
    root: {
      kind: "scriptBody",
      span: null,
      body: {
        kind: "unsupportedExpression",
        span,
        groovyType: "org.example.UnknownExpression",
      },
    },
  };
  const failed: ParsedGroovyFile = {
    ...parsed,
    sourceName: "failed.groovy",
    root: null,
    diagnostics: [{ code: "GROOVY_PARSE_ERROR", message: "bad source" }],
  };

  const report = inventoryFiles([parsed, failed]);
  assert.equal(report.parseErrorCount, 1);
  assert.deepEqual(report.unsupportedNodeTypes, { "org.example.UnknownExpression": 1 });
});


test("counts method names that collide with Object.prototype safely", () => {
  const file: ParsedGroovyFile = {
    formatVersion: 1,
    sourceName: "prototype-name.groovy",
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
          {
            kind: "expressionStatement",
            span,
            expression: {
              kind: "methodCall",
              span,
              object: variable("helper"),
              method: constant("valueOf"),
              arguments: { kind: "arguments", span, items: [] },
              implicitThis: false,
            },
          },
        ],
      },
    },
  };

  const report = inventoryFiles([file]);
  assert.deepEqual(report.methodCalls, { valueOf: 1 });
});
