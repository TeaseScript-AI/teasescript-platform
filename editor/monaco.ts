import * as monaco from "monaco-editor";
import {
  createTeaseScriptProviders,
  registerTeaseScriptProviders,
} from "../src/editor/monaco-providers.js";
import { watchProjectDiagnostics, type ProjectFileView } from "../src/editor/model-diagnostics.js";
import type { ProjectImageFile } from "../src/image-catalog.js";

const TEASE_LANGUAGE_ID = "teasescript";

export function registerTeaseScriptLanguage(): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === TEASE_LANGUAGE_ID)) {
    monaco.languages.register({
      id: TEASE_LANGUAGE_ID,
      extensions: [".tease"],
      aliases: ["TeaseScript"],
    });
    // The colours come from the compiler's own token classes (`registerProviders`). This tokenizer only marks strings
    // and comments, which Monaco itself reads: brackets and quotes in them are text for bracket matching, bracket
    // colours, and auto-closing, which the compiler's classes cannot tell Monaco. It also colours them before the
    // classes arrive.
    monaco.languages.setMonarchTokensProvider(TEASE_LANGUAGE_ID, {
      tokenizer: {
        root: [
          [/\/\/.*$/, "comment"],
          [/\/\*/, "comment", "@blockComment"],
          [/"""/, "string", "@blockString"],
          [/"/, "string", "@string"],
          [/[^/"{}]+|[/{}]/, ""],
        ],
        blockComment: [
          [/\*\//, "comment", "@pop"],
          [/[^*]+|\*/, "comment"],
        ],
        // A single-line string ends at the end of its line, also without its closing quote.
        string: [
          [/\$\{/, "delimiter.bracket", "@interpolation"],
          [/"/, "string", "@pop"],
          [
            /[^\\"$]+|\\.?|\$/,
            { cases: { "@eos": { token: "string", next: "@pop" }, "@default": "string" } },
          ],
        ],
        blockString: [
          [/\$\{/, "delimiter.bracket", "@interpolation"],
          [/"""/, "string", "@pop"],
          [/[^\\"$]+|\\.?|\$|"/, "string"],
        ],
        interpolation: [
          [/\}/, "delimiter.bracket", "@pop"],
          [/\{/, "delimiter.bracket", "@interpolation"],
          { include: "@root" },
        ],
      },
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
    // The theme's colour for each class, by the token types Monaco's themes colour.
    {
      keyword: "keyword",
      type: "type",
      command: "type.identifier",
      name: "identifier",
      number: "number",
      string: "string",
      interpolation: "delimiter.bracket",
      regex: "regexp",
      comment: "comment",
      operator: "operator",
      punctuation: "delimiter",
    },
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
      semanticTokens: (provider) => {
        monaco.languages.registerDocumentSemanticTokensProvider(TEASE_LANGUAGE_ID, provider);
      },
    },
    providers,
  );
}

/**
 * Marks every model's diagnostics after each edit and reports the project's file overview; tag queries search the
 * package images when given.
 */
export function watchProject(
  files: readonly { readonly path: string; readonly model: monaco.editor.ITextModel }[],
  onOverview: (files: readonly ProjectFileView[]) => void,
  options: { readonly images?: readonly ProjectImageFile[] } = {},
): monaco.IDisposable {
  const models = new Map(files.map((file) => [file.path, file.model]));
  return watchProjectDiagnostics(
    files,
    monaco.MarkerSeverity,
    (overview) => {
      for (const file of overview) {
        const model = models.get(file.path);
        if (model !== undefined)
          monaco.editor.setModelMarkers(model, "teasescript", [...file.markers]);
      }
      onOverview(overview);
    },
    options,
  );
}

export { monaco, type ProjectFileView };
