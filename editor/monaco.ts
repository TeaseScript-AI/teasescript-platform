import * as monaco from "monaco-editor";
import {
  applyLanguageTextEdits,
  createLanguageDocument,
  formatLanguageDocument,
  languageCompletions,
  languageDiagnostics,
  languageHover,
  languagePositionAt,
  languageSignatureHelp,
} from "../src/language-tooling.js";

export const TEASE_LANGUAGE_ID = "teasescript";

export function registerTeaseScriptLanguage(): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === TEASE_LANGUAGE_ID)) {
    monaco.languages.register({
      id: TEASE_LANGUAGE_ID,
      extensions: [".tease"],
      aliases: ["TeaseScript"],
    });
    monaco.languages.setMonarchTokensProvider(TEASE_LANGUAGE_ID, {
      tokenizer: {
        root: [
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
          [/`[^`]*`/, "string"],
          [/"([^"\\]|\\.)*"/, "string"],
          [/[{}()[\],:]/, "delimiter"],
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
      comments: { lineComment: "//" },
      brackets: [
        ["{", "}"],
        ["[", "]"],
        ["(", ")"],
      ],
    });
    registerProviders();
  }
}

function registerProviders(): void {
  monaco.languages.registerCompletionItemProvider(TEASE_LANGUAGE_ID, {
    triggerCharacters: [" ", "\n"],
    provideCompletionItems(model, position) {
      const document = createLanguageDocument(model.uri.toString(), model.getValue());
      const languagePosition = languagePositionAt(document, model.getOffsetAt(position));
      const items = languageCompletions(document, languagePosition);
      return {
        suggestions: items.map((item) => ({
          label: item.label,
          kind:
            item.kind === "value"
              ? monaco.languages.CompletionItemKind.Value
              : item.kind === "speaker"
                ? monaco.languages.CompletionItemKind.Reference
                : monaco.languages.CompletionItemKind.Keyword,
          detail: item.detail,
          insertText: item.insertText,
          range: new monaco.Range(
            position.lineNumber,
            position.column,
            position.lineNumber,
            position.column,
          ),
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider(TEASE_LANGUAGE_ID, {
    provideHover(model, position) {
      const document = createLanguageDocument(model.uri.toString(), model.getValue());
      const result = languageHover(
        document,
        languagePositionAt(document, model.getOffsetAt(position)),
      );
      return result === null
        ? null
        : {
            range: toMonacoRange(result.range),
            contents: result.contents.map((value) => ({ value })),
          };
    },
  });
  monaco.languages.registerSignatureHelpProvider(TEASE_LANGUAGE_ID, {
    signatureHelpTriggerCharacters: [" ", ","],
    provideSignatureHelp(model, position) {
      const document = createLanguageDocument(model.uri.toString(), model.getValue());
      const result = languageSignatureHelp(
        document,
        languagePositionAt(document, model.getOffsetAt(position)),
      );
      return result === null
        ? null
        : {
            value: {
              signatures: [
                {
                  label: result.label,
                  documentation: result.documentation,
                  parameters: result.parameters.map((label) => ({ label })),
                },
              ],
              activeSignature: 0,
              activeParameter: result.activeParameter,
            },
            dispose() {},
          };
    },
  });
  monaco.languages.registerDocumentFormattingEditProvider(TEASE_LANGUAGE_ID, {
    provideDocumentFormattingEdits(model) {
      const document = createLanguageDocument(model.uri.toString(), model.getValue());
      const result = formatLanguageDocument(document);
      return result.edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }));
    },
  });
}

export function updateDiagnostics(editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel();
  if (model === null) return;
  const document = createLanguageDocument(model.uri.toString(), model.getValue());
  monaco.editor.setModelMarkers(
    model,
    "teasescript",
    languageDiagnostics(document).map((diagnostic) => ({
      severity:
        diagnostic.severity === "error"
          ? monaco.MarkerSeverity.Error
          : monaco.MarkerSeverity.Warning,
      message: `[${diagnostic.code}] ${diagnostic.message}`,
      startLineNumber: diagnostic.span.start.line + 1,
      startColumn: diagnostic.span.start.column + 1,
      endLineNumber: diagnostic.span.end.line + 1,
      endColumn: Math.max(diagnostic.span.end.column + 1, diagnostic.span.start.column + 2),
    })),
  );
}

function toMonacoRange(span: {
  start: { line: number; column: number };
  end: { line: number; column: number };
}): monaco.IRange {
  return {
    startLineNumber: span.start.line + 1,
    startColumn: span.start.column + 1,
    endLineNumber: span.end.line + 1,
    endColumn: Math.max(span.end.column + 1, span.start.column + 2),
  };
}

export { monaco, applyLanguageTextEdits };
