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
} from "../editor/monaco-mapping.js";

const start = createSourcePosition(2, 1, 3);
const end = createSourcePosition(5, 2, 1);
const range = createSourceSpan(start, end);

test("Monaco mapping translates zero-based positions and half-open ranges to one-based shapes", () => {
  assert.deepEqual(toMonacoPosition(start), { lineNumber: 2, column: 4 });
  assert.deepEqual(toMonacoRange(range), { startLineNumber: 2, startColumn: 4, endLineNumber: 3, endColumn: 2 });
});

test("Monaco markers preserve canonical diagnostic code, message, severity, and range", () => {
  const diagnostic = createDiagnostic(DiagnosticSeverity.Error, "TST001", "bad", range);
  assert.deepEqual(toMonacoMarkers([diagnostic], { Error: 8, Warning: 4 }), [{
    startLineNumber: 2,
    startColumn: 4,
    endLineNumber: 3,
    endColumn: 2,
    severity: 8,
    code: "TST001",
    message: "bad",
    source: "TeaseScript",
  }]);
});

test("Monaco completion, hover, signature, and formatting mapping stays presentation-only", () => {
  assert.equal(toMonacoCompletions([{ label: "say", kind: "command", detail: "command", insertText: "say" }], range, {
    Keyword: 1,
    Function: 2,
    Variable: 3,
    Value: 4,
  })[0]?.kind, 2);
  assert.deepEqual(toMonacoHover({ range, contents: ["one", "two"] }).contents, [{ value: "one" }, { value: "two" }]);
  const signature = toMonacoSignatureHelp({ label: "askText [hint]", documentation: "help", activeParameter: 1, parameters: ["speaker", "hint"] });
  assert.equal(signature.value.activeSignature, 0);
  assert.equal(signature.value.activeParameter, 1);
  assert.deepEqual(toMonacoTextEdits([{ range, newText: " " }]), [{ range: toMonacoRange(range), text: " " }]);
});
