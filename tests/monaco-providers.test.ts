import assert from "node:assert/strict";
import test from "node:test";
import {
  createTeaseScriptProviders,
  registerTeaseScriptProviders,
  type MonacoProviderModel,
  type TeaseScriptProviders,
} from "../src/editor/monaco-providers.js";
import type { MonacoPosition, MonacoRange } from "../src/editor/monaco-mapping.js";
import { compileSource } from "../src/index.js";

const providers = createTeaseScriptProviders(
  (startLineNumber, startColumn, endLineNumber, endColumn) => ({
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
  }),
  { Keyword: 1, Function: 2, Variable: 3, Value: 4 },
);

test("Monaco registers usable completion, hover, signature, and formatting providers", () => {
  const registered: Partial<TeaseScriptProviders> = {};
  registerTeaseScriptProviders(
    {
      completion: (provider) => (registered.completion = provider),
      hover: (provider) => (registered.hover = provider),
      signature: (provider) => (registered.signature = provider),
      formatting: (provider) => (registered.formatting = provider),
    },
    providers,
  );
  assert.deepEqual(Object.keys(registered).sort(), [
    "completion",
    "formatting",
    "hover",
    "signature",
  ]);
  assert.equal(registered.completion, providers.completion);
  const { completion, hover, signature, formatting } = registered;
  assert.ok(completion && hover && signature && formatting);
  const suggestions = completion.provideCompletionItems(model(""), position(1)).suggestions;
  assert.ok(suggestions.some((item) => item.label === "say" && item.kind === 2));

  const hoverResult = hover.provideHover(model('say "Hello"\nexit'), position(2));
  assert.match(hoverResult?.contents[0]?.value ?? "", /say/u);
  assert.deepEqual(hoverResult?.range, {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 4,
  });

  const signatureResult = signature.provideSignatureHelp(
    model("askText as mistress "),
    position("askText as mistress ".length + 1),
  );
  assert.equal(signatureResult?.value.activeParameter, 1);
  assert.equal(signatureResult?.value.signatures[0]?.parameters[1]?.label, "question");

  const source = 'say    "Hello",instant\nexit';
  const edits = formatting.provideDocumentFormattingEdits(model(source));
  assert.notEqual(edits.length, 0);
  const formatted = applyEdits(source, edits);
  assert.equal(formatted, 'say "Hello", instant\nexit');
  const compiled = compileSource(formatted);
  assert.notEqual(compiled.plan, null);
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(formatting.provideDocumentFormattingEdits(model(formatted)), []);
});

/** Applies Monaco edits through the model offset mapping, last edit first. */
function applyEdits(text: string, edits: readonly { range: MonacoRange; text: string }[]): string {
  const textModel = model(text);
  const offsets = edits.map((edit) => ({
    start: textModel.getOffsetAt({
      lineNumber: edit.range.startLineNumber,
      column: edit.range.startColumn,
    }),
    end: textModel.getOffsetAt({
      lineNumber: edit.range.endLineNumber,
      column: edit.range.endColumn,
    }),
    text: edit.text,
  }));
  offsets.sort((left, right) => right.start - left.start);
  return offsets.reduce(
    (current, edit) => current.slice(0, edit.start) + edit.text + current.slice(edit.end),
    text,
  );
}

function model(text: string): MonacoProviderModel {
  return {
    uri: { toString: () => "file:///main.tease" },
    getValue: () => text,
    getOffsetAt: ({ lineNumber, column }) => {
      assert.equal(lineNumber, 1);
      return column - 1;
    },
  };
}

function position(column: number): MonacoPosition {
  return { lineNumber: 1, column };
}
