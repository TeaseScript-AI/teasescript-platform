import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/index.js";
import {
  createTeaseScriptProviders,
  registerTeaseScriptProviders,
  type MonacoProviderModel,
  type TeaseScriptProviders,
} from "../src/editor/monaco-providers.js";
import type { MonacoPosition, MonacoRange } from "../src/editor/monaco-mapping.js";

test("Monaco registers usable completion, hover, signature, and formatting providers", () => {
  const registered: Partial<TeaseScriptProviders> = {};
  registerTeaseScriptProviders(
    {
      completion: (provider) => (registered.completion = provider),
      hover: (provider) => (registered.hover = provider),
      signature: (provider) => (registered.signature = provider),
      formatting: (provider) => (registered.formatting = provider),
    },
    createTeaseScriptProviders(
      (startLineNumber, startColumn, endLineNumber, endColumn) => ({
        startLineNumber,
        startColumn,
        endLineNumber,
        endColumn,
      }),
      { Keyword: 1, Function: 2, Variable: 3, Value: 4 },
    ),
  );
  const { completion, hover, signature, formatting } = registered;
  assert.ok(completion && hover && signature && formatting);

  const completions = completion.provideCompletionItems(model(""), position(1));
  assert.ok(completions.suggestions.some((item) => item.label === "say" && item.kind === 2));

  assert.deepEqual(hover.provideHover(model('say "Hello"'), position(2))?.range, {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 4,
  });

  const help = signature.provideSignatureHelp(
    model("askText as mistress "),
    position("askText as mistress ".length + 1),
  );
  assert.equal(help?.value.activeParameter, 1);
  assert.equal(help?.value.signatures[0]?.parameters[1]?.label, "hint");

  const source = 'say    "Hello",instant';
  const formatted = applyEdits(source, formatting.provideDocumentFormattingEdits(model(source)));
  assert.equal(formatted, 'say "Hello", instant');
  assert.deepEqual(compileSource(formatted).diagnostics, []);
  assert.deepEqual(formatting.provideDocumentFormattingEdits(model(formatted)), []);
});

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

/** Applies Monaco edits through the model's offset mapping, as the editor does. */
function applyEdits(
  text: string,
  edits: readonly { readonly range: MonacoRange; readonly text: string }[],
): string {
  const offsets = edits.map((edit) => ({
    start: model(text).getOffsetAt({
      lineNumber: edit.range.startLineNumber,
      column: edit.range.startColumn,
    }),
    end: model(text).getOffsetAt({
      lineNumber: edit.range.endLineNumber,
      column: edit.range.endColumn,
    }),
    text: edit.text,
  }));
  return offsets
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      text,
    );
}
