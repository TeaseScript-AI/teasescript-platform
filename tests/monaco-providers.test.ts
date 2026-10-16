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
  {
    keyword: "theme-keyword",
    type: "theme-type",
    command: "theme-command",
    name: "theme-name",
    number: "theme-number",
    string: "theme-string",
    interpolation: "theme-interpolation",
    regex: "theme-regex",
    comment: "theme-comment",
    operator: "theme-operator",
    punctuation: "theme-punctuation",
  },
);

test("Monaco registers usable completion, hover, signature, formatting, and token providers", () => {
  const registered: Partial<TeaseScriptProviders> = {};
  registerTeaseScriptProviders(
    {
      completion: (provider) => (registered.completion = provider),
      hover: (provider) => (registered.hover = provider),
      signature: (provider) => (registered.signature = provider),
      formatting: (provider) => (registered.formatting = provider),
      semanticTokens: (provider) => (registered.semanticTokens = provider),
      lineTokens: (provider) => (registered.lineTokens = provider),
    },
    providers,
  );
  assert.deepEqual(Object.keys(registered).sort(), [
    "completion",
    "formatting",
    "hover",
    "lineTokens",
    "semanticTokens",
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

test("Monaco colours each token by the compiler's class, once for each line the token is on", () => {
  const source = 'let r = /a+/\r\n/* two\r\nlines */ say "${r}"';
  const lines = source.split("\r\n");
  const { tokenTypes } = providers.semanticTokens.getLegend();
  const { data } = providers.semanticTokens.provideDocumentSemanticTokens(model(source));
  const shown: string[] = [];
  let [line, column] = [0, 0];
  for (let index = 0; index < data.length; index += 5) {
    const [lineDelta, columnDelta, length, kind] = data.slice(index, index + 4);
    column = lineDelta === 0 ? column + columnDelta! : columnDelta!;
    line += lineDelta!;
    const text = lines[line]!.slice(column, column + length!);
    shown.push(`${line}:${column} ${text} ${tokenTypes[kind!]}`);
  }
  assert.deepEqual(shown, [
    "0:0 let theme-keyword",
    "0:4 r theme-name",
    "0:6 = theme-operator",
    // After `=`, `/a+/` is a regex, not a division.
    "0:8 /a+/ theme-regex",
    "1:0 /* two theme-comment",
    "2:0 lines */ theme-comment",
    "2:9 say theme-keyword",
    '2:13 " theme-string',
    "2:14 ${ theme-interpolation",
    "2:16 r theme-name",
    "2:17 } theme-interpolation",
    '2:18 " theme-string',
  ]);
});

test("Monaco's line tokens mark text, regexes, and comments as the lexer reads each line", () => {
  // What a line's tokens mark, Monaco's bracket matching and quote closing skip.
  const lines = [
    // A regex whose class holds `/*`, which starts no comment, and one only the parse finds, after a message mode.
    "let r = /[/*]/",
    'say prose /"[(]/',
    "let n = (1 + 2)",
    // A block comment and a block string over several lines.
    '/* a ( "b"',
    'c */ say "Smile :)"',
    'let s = """',
    "  (${n})",
    '"""',
    "exit",
  ];
  let state = providers.lineTokens.getInitialState();
  const shown = lines.map((line) => {
    const { tokens, endState } = providers.lineTokens.tokenize(line, state);
    state = endState;
    return tokens.map(
      ({ startIndex, scopes }, index) =>
        `${line.slice(startIndex, tokens[index + 1]?.startIndex ?? line.length)}:${scopes}`,
    );
  });
  assert.deepEqual(shown, [
    ["let r = :", "/[/*]/:regexp"],
    ["say prose :", '/"[(]/:regexp'],
    ["let n = (1 + 2):"],
    ['/* a ( "b":comment'],
    ["c */:comment", " say :", '"Smile :)":string'],
    ["let s = :", '""":string'],
    ["  (:string", "${n}:", "):string"],
    ['""":string'],
    ["exit:"],
  ]);
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
