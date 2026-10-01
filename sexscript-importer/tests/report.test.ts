import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFeasibility, rootDiagnostics } from "../src/report.ts";
import type { MigrationDiagnostic } from "../src/ir.ts";
import type { ParsedGroovyFile, SourceSpan } from "../src/ast.ts";

const child: SourceSpan = { line: 2, column: 5, endLine: 2, endColumn: 15 };
const parent: SourceSpan = { line: 2, column: 1, endLine: 4, endColumn: 2 };

test("keeps the innermost diagnostic and removes wrapper cascades", () => {
  const diagnostics: MigrationDiagnostic[] = [
    { code: "SX_ROOT", severity: "error", message: "root", span: child },
    { code: "SX_UNSUPPORTED_IF", severity: "error", message: "wrapper", span: parent },
    { code: "SX_UNSUPPORTED_WHILE", severity: "error", message: "duplicate wrapper", span: parent },
  ];

  assert.deepEqual(rootDiagnostics(diagnostics), [diagnostics[0]]);
});

test("reports source and IR counts separately instead of inventing a conversion percentage", () => {
  const file: ParsedGroovyFile = {
    formatVersion: 1,
    sourceName: "report-fixture.groovy",
    groovyVersion: "2.5.21",
    mode: "script-body",
    diagnostics: [],
    root: {
      kind: "scriptBody",
      span: null,
      body: {
        kind: "block",
        span: parent,
        statements: [{
          kind: "if",
          span: parent,
          condition: {
            kind: "methodCall",
            span: child,
            object: { kind: "variable", span: null, name: "helper", type: "java.lang.Object" },
            method: { kind: "constant", span: child, value: "mystery" },
            arguments: { kind: "arguments", span: child, items: [] },
            implicitThis: false,
            safe: false,
            spreadSafe: false,
          },
          then: { kind: "block", span: parent, statements: [] },
          else: { kind: "empty", span: parent },
        }],
      },
    },
  };

  const report = analyzeFeasibility([file]);
  assert.equal(report.fileCount, 1);
  assert.equal(report.sourceStatementNodes, 1);
  assert.equal(report.migrationErrors, 2);
  assert.equal(report.rootMigrationErrors, 1);
  assert.deepEqual(report.rootDiagnosticsByCode, { SX_DYNAMIC_OR_OBJECT_CALL: 1 });
  assert.equal(report.unsupportedPlaceholders, 1);
});


test("keeps independent semantic parent diagnostics when a child also fails", () => {
  const diagnostics: MigrationDiagnostic[] = [
    { code: "SX_DYNAMIC_OR_OBJECT_CALL", severity: "error", message: "child", span: child },
    { code: "SX_SWITCH_FALLTHROUGH", severity: "error", message: "independent parent", span: parent },
  ];

  assert.deepEqual(rootDiagnostics(diagnostics), diagnostics);
});

test("prefers a concrete diagnostic over a wrapper at the same source span", () => {
  const diagnostics: MigrationDiagnostic[] = [
    { code: "SX_UNSUPPORTED_CALL", severity: "error", message: "wrapper", span: child },
    { code: "SX_DYNAMIC_OR_OBJECT_CALL", severity: "error", message: "concrete", span: child },
  ];

  assert.deepEqual(rootDiagnostics(diagnostics), [diagnostics[1]]);
});
