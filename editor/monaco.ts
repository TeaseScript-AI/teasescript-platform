import * as monaco from "monaco-editor";
import {
  createLanguageDocument,
  formatLanguageDocument,
  languageCompletions,
  languageHover,
  languagePositionAt,
  languageSignatureHelp,
} from "../src/language-tooling.js";
import {
  toMonacoCompletions,
  toMonacoHover,
  toMonacoSignatureHelp,
  toMonacoTextEdits,
} from "../src/editor/monaco-mapping.js";
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
        suggestions: toMonacoCompletions(
          items,
          new monaco.Range(
            position.lineNumber,
            position.column,
            position.lineNumber,
            position.column,
          ),
          monaco.languages.CompletionItemKind,
        ),
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
      return result === null ? null : { ...toMonacoHover(result) };
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
      return result === null ? null : { ...toMonacoSignatureHelp(result) };
    },
  });
  monaco.languages.registerDocumentFormattingEditProvider(TEASE_LANGUAGE_ID, {
    provideDocumentFormattingEdits(model) {
      const document = createLanguageDocument(model.uri.toString(), model.getValue());
      const result = formatLanguageDocument(document);
      return toMonacoTextEdits(result.edits);
    },
  });
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
