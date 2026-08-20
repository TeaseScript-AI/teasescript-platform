import assert from "node:assert/strict";
import test from "node:test";

import {
  createTeaseScriptSemanticTokens,
  registerTeaseScriptMonaco,
  TEASESCRIPT_LANGUAGE_ID,
  TEASESCRIPT_MARKER_OWNER,
  type MonacoApi,
} from "../editor/monaco-provider.js";

interface FakeDisposable { dispose(): void }

class FakeModel {
  readonly uri = { toString: () => "file:///main.tease" };
  #listener: (() => void) | null = null;

  public constructor(public text: string) {}
  getValue() { return this.text; }
  getLanguageId() { return TEASESCRIPT_LANGUAGE_ID; }
  getOffsetAt(position: { lineNumber: number; column: number }) {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let line = 1; line < position.lineNumber; line += 1) offset += (lines[line - 1]?.length ?? 0) + 1;
    return offset + position.column - 1;
  }
  onDidChangeContent(listener: () => void): FakeDisposable {
    this.#listener = listener;
    return { dispose: () => { if (this.#listener === listener) this.#listener = null; } };
  }
  emitChange() { this.#listener?.(); }
}

function disposable(): FakeDisposable { return { dispose() {} }; }

test("Monaco registration keeps canonical diagnostics live as the model changes", () => {
  const model = new FakeModel("let x = askText as");
  const markerCalls: { owner: string; markers: readonly { code?: string | { value: string } }[] }[] = [];
  const api = {
    MarkerSeverity: { Error: 8, Warning: 4 },
    languages: {
      CompletionItemKind: { Keyword: 17, Function: 1, Variable: 5, Value: 12 },
      register: () => {},
      setLanguageConfiguration: () => disposable(),
      registerCompletionItemProvider: () => disposable(),
      registerHoverProvider: () => disposable(),
      registerSignatureHelpProvider: () => disposable(),
      registerDocumentFormattingEditProvider: () => disposable(),
      registerDocumentSemanticTokensProvider: () => disposable(),
    },
    editor: {
      getModels: () => [model],
      setModelMarkers: (_model: FakeModel, owner: string, markers: readonly { code?: string | { value: string } }[]) => {
        markerCalls.push({ owner, markers });
      },
      onDidCreateModel: () => disposable(),
      onDidChangeModelLanguage: () => disposable(),
      onWillDisposeModel: () => disposable(),
    },
  } as unknown as MonacoApi;

  const registration = registerTeaseScriptMonaco(api);
  assert.equal(markerCalls.at(-1)?.owner, TEASESCRIPT_MARKER_OWNER);
  assert.ok((markerCalls.at(-1)?.markers.length ?? 0) > 0);

  model.text = "let x = askText";
  model.emitChange();
  assert.deepEqual(markerCalls.at(-1)?.markers, []);
  registration.dispose();
});

test("semantic highlighting is derived from canonical lexer tokens and lexer comment gaps", () => {
  const result = createTeaseScriptSemanticTokens('say "Hello" // note\nlet answer = askText');
  assert.deepEqual(result.legend.tokenTypes, ["keyword", "string", "number", "variable", "function", "operator", "comment"]);

  const decoded: { line: number; column: number; length: number; type: string }[] = [];
  let line = 0;
  let column = 0;
  for (let index = 0; index < result.data.length; index += 5) {
    const deltaLine = result.data[index] ?? 0;
    const deltaColumn = result.data[index + 1] ?? 0;
    line += deltaLine;
    column = deltaLine === 0 ? column + deltaColumn : deltaColumn;
    decoded.push({
      line,
      column,
      length: result.data[index + 2] ?? 0,
      type: result.legend.tokenTypes[result.data[index + 3] ?? 0] ?? "unknown",
    });
  }

  assert.ok(decoded.some((token) => token.line === 0 && token.column === 0 && token.type === "keyword"));
  assert.ok(decoded.some((token) => token.line === 0 && token.type === "string"));
  assert.ok(decoded.some((token) => token.line === 0 && token.type === "comment"));
  assert.ok(decoded.some((token) => token.line === 1 && token.type === "function"));
});
