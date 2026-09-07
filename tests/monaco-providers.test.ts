import assert from "node:assert/strict";
import test from "node:test";
import {
  createTeaseScriptProviders,
  registerTeaseScriptProviders,
  type MonacoProviderModel,
} from "../src/editor/monaco-providers.js";
import type { MonacoPosition, MonacoRange } from "../src/editor/monaco-mapping.js";

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
  const registered: Record<string, unknown> = {};
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
  const completion = providers.completion.provideCompletionItems(model(""), position(1));
  assert.ok(completion.suggestions.some((item) => item.label === "say" && item.kind === 2));

  const hover = providers.hover.provideHover(model('say "Hello"'), position(2));
  assert.match(hover?.contents[0]?.value ?? "", /say/u);

  const signature = providers.signature.provideSignatureHelp(
    model("askText as mistress "),
    position("askText as mistress ".length + 1),
  );
  assert.equal(signature?.value.activeParameter, 1);
  assert.equal(signature?.value.signatures[0]?.parameters[1]?.label, "hint");

  const formatting = providers.formatting.provideDocumentFormattingEdits(
    model('say    "Hello",instant'),
  );
  assert.ok(formatting.length > 0);
  assert.ok(formatting.every((edit) => isRange(edit.range)));
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

function isRange(value: MonacoRange): boolean {
  return value.startLineNumber >= 1 && value.endLineNumber >= value.startLineNumber;
}
