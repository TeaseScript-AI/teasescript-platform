import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiagnostic,
  createSourcePosition,
  createSourceSpan,
  DiagnosticSeverity,
} from "../src/index.js";
import {
  toMonacoCompletions,
  toMonacoHover,
  toMonacoMarkers,
  toMonacoPosition,
  toMonacoRange,
  toMonacoSignatureHelp,
  toMonacoTextEdits,
} from "../src/editor/monaco-mapping.js";

test("Monaco mapping preserves canonical multiline half-open ranges exactly", () => {
  assert.deepEqual(toMonacoPosition(createSourcePosition(2, 1, 8)), { lineNumber: 2, column: 9 });
  const range = createSourceSpan(createSourcePosition(2, 1, 8), createSourcePosition(6, 2, 1));
  assert.deepEqual(toMonacoRange(range), {
    startLineNumber: 2,
    startColumn: 9,
    endLineNumber: 3,
    endColumn: 2,
  });
  assert.deepEqual(toMonacoTextEdits([{ range, newText: " " }]), [
    { range: toMonacoRange(range), text: " " },
  ]);
});

test("Monaco markers retain canonical diagnostic code, severity, and range", () => {
  const range = createSourceSpan(createSourcePosition(0, 0, 0), createSourcePosition(0, 0, 0));
  const markers = toMonacoMarkers(
    [createDiagnostic(DiagnosticSeverity.Error, "TST001", "bad", range)],
    { Error: 8, Warning: 4 },
  );
  assert.deepEqual(markers[0], {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
    severity: 8,
    code: "TST001",
    message: "bad",
    source: "TeaseScript",
  });
});

test("Monaco providers receive presentation-only completion, hover, and signature shapes", () => {
  const sourceRange = createSourceSpan(
    createSourcePosition(4, 1, 2),
    createSourcePosition(9, 2, 3),
  );
  const range = { startLineNumber: 2, startColumn: 3, endLineNumber: 3, endColumn: 4 };
  assert.deepEqual(
    toMonacoCompletions(
      [{ label: "label-a", kind: "command", detail: "detail-b", insertText: "insert-c" }],
      range,
      { Keyword: 1, Function: 2, Variable: 3, Value: 4 },
    ),
    [{ label: "label-a", kind: 2, detail: "detail-b", insertText: "insert-c", range }],
  );
  assert.deepEqual(toMonacoHover({ range: sourceRange, contents: ["one", "two"] }), {
    range,
    contents: [{ value: "one" }, { value: "two" }],
  });
  const signature = toMonacoSignatureHelp({
    label: "signature-label",
    documentation: "signature-docs",
    activeParameter: 1,
    parameters: ["first-slot", "second-slot"],
  });
  assert.deepEqual(signature.value, {
    signatures: [
      {
        label: "signature-label",
        documentation: "signature-docs",
        parameters: [{ label: "first-slot" }, { label: "second-slot" }],
      },
    ],
    activeSignature: 0,
    activeParameter: 1,
  });
});
