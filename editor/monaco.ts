import * as monaco from "monaco-editor";
import {
  createTeaseScriptProviders,
  registerTeaseScriptProviders,
} from "../src/editor/monaco-providers.js";
import { watchModelDiagnostics } from "../src/editor/model-diagnostics.js";

const TEASE_LANGUAGE_ID = "teasescript";

export function registerTeaseScriptLanguage(): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === TEASE_LANGUAGE_ID)) {
    monaco.languages.register({
      id: TEASE_LANGUAGE_ID,
      extensions: [".tease"],
      aliases: ["TeaseScript"],
    });
    monaco.languages.setMonarchTokensProvider(TEASE_LANGUAGE_ID, {
      tokenizer: {
        root: [{ include: "@expression" }],
        expression: [
          [/\/\/.*$/, "comment"],
          [
            /[A-Za-z_][\w-]*/,
            {
              cases: {
                "@keywords": "keyword",
                "@commands": "type.identifier",
                "@default": "identifier",
              },
            },
          ],
          [/-?\d+(?:\.\d+)?/, "number"],
          [/"""/, { token: "string.quote", next: "@blockString" }],
          [
            /"/,
            {
              cases: {
                "@eos": "string.invalid",
                "@default": { token: "string.quote", next: "@singleLineString" },
              },
            },
          ],
          [/[{}()[\],:]/, "delimiter"],
        ],
        singleLineString: [
          [
            /[^\\$\"]+/,
            { cases: { "@eos": { token: "string.invalid", next: "@pop" }, "@default": "string" } },
          ],
          [/\\(?:[\\\"nrt]|\$\{)/, "string.escape"],
          [/\\./, "string.escape.invalid"],
          [/\\$/, { token: "string.escape.invalid", next: "@pop" }],
          [/\$\{/, { token: "delimiter.bracket", next: "@stringInterpolation" }],
          [
            /\$(?!\{)/,
            { cases: { "@eos": { token: "string.invalid", next: "@pop" }, "@default": "string" } },
          ],
          [/"/, { token: "string.quote", next: "@pop" }],
        ],
        blockString: [
          [/"""/, { token: "string.quote", next: "@pop" }],
          [/[^\\$\"]+/, "string"],
          [/\\(?:[\\\"nrt]|\$\{)/, "string.escape"],
          [/\\./, "string.escape.invalid"],
          [/\$\{/, { token: "delimiter.bracket", next: "@stringInterpolation" }],
          [/"{1,2}(?!")|\$(?!\{)/, "string"],
        ],
        stringInterpolation: [
          [/\}/, { token: "delimiter.bracket", next: "@pop" }],
          [/\{/, { token: "delimiter", next: "@interpolationBrace" }],
          { include: "@expression" },
        ],
        interpolationBrace: [
          [/\}/, { token: "delimiter", next: "@pop" }],
          [/\{/, { token: "delimiter", next: "@push" }],
          { include: "@expression" },
        ],
      },
      keywords: [
        "as",
        "skippable",
        "unskippable",
        "instant",
        "speaker",
        "let",
        "if",
        "else",
        "repeat",
        "while",
        "for",
        "in",
        "function",
        "return",
      ],
      commands: ["showButton", "askText", "askNumber", "choose", "say", "wait", "exit"],
    });
    monaco.languages.setLanguageConfiguration(TEASE_LANGUAGE_ID, {
      comments: { lineComment: "//", blockComment: ["/*", "*/"] },
      brackets: [
        ["{", "}"],
        ["[", "]"],
        ["(", ")"],
      ],
      autoClosingPairs: [
        { open: '"""', close: '"""' },
        { open: '"', close: '"' },
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
      ],
      surroundingPairs: [
        { open: '"""', close: '"""' },
        { open: '"', close: '"' },
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
      ],
    });
    registerProviders();
  }
}

function registerProviders(): void {
  const providers = createTeaseScriptProviders(
    (startLineNumber, startColumn, endLineNumber, endColumn) =>
      new monaco.Range(startLineNumber, startColumn, endLineNumber, endColumn),
    monaco.languages.CompletionItemKind,
  );
  registerTeaseScriptProviders(
    {
      completion: (provider) => {
        monaco.languages.registerCompletionItemProvider(TEASE_LANGUAGE_ID, provider);
      },
      hover: (provider) => {
        monaco.languages.registerHoverProvider(TEASE_LANGUAGE_ID, provider);
      },
      signature: (provider) => {
        monaco.languages.registerSignatureHelpProvider(TEASE_LANGUAGE_ID, provider);
      },
      formatting: (provider) => {
        monaco.languages.registerDocumentFormattingEditProvider(TEASE_LANGUAGE_ID, provider);
      },
    },
    providers,
  );
}

export function watchDiagnostics(
  model: monaco.editor.ITextModel,
  onCount: (count: number) => void,
): monaco.IDisposable {
  return watchModelDiagnostics(model, monaco.MarkerSeverity, (markers) => {
    monaco.editor.setModelMarkers(model, "teasescript", [...markers]);
    onCount(markers.length);
  });
}

export { monaco };
