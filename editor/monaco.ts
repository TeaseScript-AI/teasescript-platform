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
    // The colours come from the compiler's own token classes (`registerProviders`). This tokenizer marks only strings,
    // with their interpolations, and line comments, which Monaco itself reads: brackets and quotes in them are text
    // for bracket matching, bracket colours, and auto-closing, which semantic tokens cannot tell Monaco. It reads one
    // line at a time and cannot tell a regex from a division, so it leaves regexes and block comments, which a regex
    // such as `/[/*]/` can seem to open, to the compiler's classes.
    monaco.languages.setMonarchTokensProvider(TEASE_LANGUAGE_ID, {
      tokenizer: {
        root: [{ include: "@expression" }],
        expression: [
          [/\/\/.*$/, "comment"],
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
          [/[^/"{}]+|[/{}]/, ""],
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
