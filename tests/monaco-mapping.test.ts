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
import type { LanguageCompletionKind } from "../src/language-tooling.js";

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
  const suppliedRange = { startLineNumber: 7, startColumn: 3, endLineNumber: 7, endColumn: 3 };
  assert.deepEqual(
    toMonacoCompletions(
      [{ label: "label-a", kind: "command", detail: "detail-a", insertText: "insert-a" }],
      suppliedRange,
      { Keyword: 1, Function: 2, Variable: 3, Value: 4 },
    ),
    [
      {
        label: "label-a",
        kind: 2,
        detail: "detail-a",
        insertText: "insert-a",
        range: suppliedRange,
      },
    ],
  );
  const hoverRange = createSourceSpan(
    createSourcePosition(4, 0, 4),
    createSourcePosition(13, 1, 2),
  );
  assert.deepEqual(toMonacoHover({ range: hoverRange, contents: ["one", "two"] }), {
    range: { startLineNumber: 1, startColumn: 5, endLineNumber: 2, endColumn: 3 },
    contents: [{ value: "one" }, { value: "two" }],
  });
  assert.deepEqual(
    toMonacoSignatureHelp({
      label: "signature-label",
      documentation: "signature-documentation",
      activeParameter: 1,
      parameters: ["first-slot", "second-slot"],
    }).value,
    {
      signatures: [
        {
          label: "signature-label",
          documentation: "signature-documentation",
          parameters: [{ label: "first-slot" }, { label: "second-slot" }],
        },
      ],
      activeSignature: 0,
      activeParameter: 1,
    },
  );
});

test("Monaco completion kinds map every canonical kind to the supplied enum", () => {
  const kinds = { Keyword: 17, Function: 1, Variable: 4, Value: 13 };
  const table: readonly (readonly [LanguageCompletionKind, number])[] = [
    ["command", kinds.Function],
    ["keyword", kinds.Keyword],
    ["modifier", kinds.Keyword],
    ["speaker", kinds.Variable],
    ["value", kinds.Value],
  ];
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  assert.deepEqual(
    toMonacoCompletions(
      table.map(([kind]) => ({ label: kind, kind, detail: kind, insertText: kind })),
      range,
      kinds,
    ).map((item) => item.kind),
    table.map(([, monacoKind]) => monacoKind),
  );
});
