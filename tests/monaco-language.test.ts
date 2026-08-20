import assert from "node:assert/strict";
import test from "node:test";

import {
  languageDocumentFromMonacoModel,
  monacoCompletions,
  monacoDiagnostics,
  monacoFormattingEdits,
  monacoHover,
  monacoSignatureHelp,
  type MonacoModelView,
} from "../editor/monaco-language.js";

class FakeModel implements MonacoModelView {
  readonly uri = { toString: () => "file:///main.tease" };
  constructor(public text: string) {}
  getValue() { return this.text; }
  getOffsetAt(position: { lineNumber: number; column: number }) {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let index = 1; index < position.lineNumber; index += 1) offset += (lines[index - 1]?.length ?? 0) + 1;
    return offset + position.column - 1;
  }
}

const severity = { Error: 8, Warning: 4 };
const kinds = { Keyword: 1, Function: 2, Variable: 3, Value: 4 };

test("Monaco model adapter preserves document identity and reads current text", () => {
  const model = new FakeModel("let x = askText as");
  assert.deepEqual(languageDocumentFromMonacoModel(model), { uri: "file:///main.tease", text: "let x = askText as" });
  assert.ok(monacoDiagnostics(model, severity).length > 0);
  model.text = "let x = askText";
  assert.deepEqual(monacoDiagnostics(model, severity), []);
});

test("Monaco providers consume the current model without cached stale source", () => {
  const model = new FakeModel("let x = ");
  const completions = monacoCompletions(model, { lineNumber: 1, column: 9 }, kinds);
  assert.ok(completions.suggestions.some((item) => item.label === "askText"));
  model.text = "let x = choose";
  const hover = monacoHover(model, { lineNumber: 1, column: 10 });
  assert.match(hover?.contents.map((item) => item.value).join(" ") ?? "", /choose/u);
  assert.match(monacoSignatureHelp(model, { lineNumber: 1, column: 10 })?.value.signatures[0]?.label ?? "", /choose/u);
});

test("Monaco formatter adapter returns ordinary text edits", () => {
  const model = new FakeModel('showButton   "Continue"');
  const edits = monacoFormattingEdits(model);
  assert.ok(edits.length > 0);
  assert.equal(edits[0]?.text, " ");
});
