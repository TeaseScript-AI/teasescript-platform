import {
  classifyTokens,
  createLanguageDocument,
  formatLanguageDocument,
  LANGUAGE_TOKEN_CLASSES,
  languageCompletions,
  languageHover,
  languagePositionAt,
  languageSignatureHelp,
  type LanguageTokenClass,
} from "../language-tooling.js";
import {
  toMonacoCompletions,
  toMonacoHover,
  toMonacoSemanticTokens,
  toMonacoSignatureHelp,
  toMonacoTextEdits,
  type MonacoPosition,
  type MonacoRange,
} from "./monaco-mapping.js";

export interface MonacoProviderModel {
  readonly uri: { toString(): string };
  getValue(): string;
  getOffsetAt(position: MonacoPosition): number;
}

export type TeaseScriptProviders = ReturnType<typeof createTeaseScriptProviders>;

export interface TeaseScriptProviderRegistration {
  completion(provider: TeaseScriptProviders["completion"]): void;
  formatting(provider: TeaseScriptProviders["formatting"]): void;
  hover(provider: TeaseScriptProviders["hover"]): void;
  semanticTokens(provider: TeaseScriptProviders["semanticTokens"]): void;
  signature(provider: TeaseScriptProviders["signature"]): void;
}

export function registerTeaseScriptProviders(
  registration: TeaseScriptProviderRegistration,
  providers: TeaseScriptProviders,
): void {
  registration.completion(providers.completion);
  registration.hover(providers.hover);
  registration.signature(providers.signature);
  registration.formatting(providers.formatting);
  registration.semanticTokens(providers.semanticTokens);
}

export function createTeaseScriptProviders(
  createRange: (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ) => MonacoRange,
  completionKinds: {
    readonly Keyword: number;
    readonly Function: number;
    readonly Variable: number;
    readonly Value: number;
  },
  /** The editor theme's token type for each class of `classifyTokens`. */
  tokenTypes: Readonly<Record<LanguageTokenClass, string>>,
) {
  const legend = {
    tokenTypes: LANGUAGE_TOKEN_CLASSES.map((kind) => tokenTypes[kind]),
    tokenModifiers: [],
  };
  return {
    completion: {
      triggerCharacters: [" ", "\n"],
      provideCompletionItems(model: MonacoProviderModel, position: MonacoPosition) {
        const document = languageDocument(model);
        const items = languageCompletions(
          document,
          languagePositionAt(document, model.getOffsetAt(position)),
        );
        return {
          suggestions: toMonacoCompletions(
            items,
            createRange(position.lineNumber, position.column, position.lineNumber, position.column),
            completionKinds,
          ),
        };
      },
    },
    hover: {
      provideHover(model: MonacoProviderModel, position: MonacoPosition) {
        const document = languageDocument(model);
        const result = languageHover(
          document,
          languagePositionAt(document, model.getOffsetAt(position)),
        );
        return result === null ? null : toMonacoHover(result);
      },
    },
    signature: {
      signatureHelpTriggerCharacters: [" ", ","],
      provideSignatureHelp(model: MonacoProviderModel, position: MonacoPosition) {
        const document = languageDocument(model);
        const result = languageSignatureHelp(
          document,
          languagePositionAt(document, model.getOffsetAt(position)),
        );
        return result === null ? null : toMonacoSignatureHelp(result);
      },
    },
    formatting: {
      provideDocumentFormattingEdits(model: MonacoProviderModel) {
        return toMonacoTextEdits(formatLanguageDocument(languageDocument(model)).edits);
      },
    },
    // Every token's colour comes from the compiler's classes, which the parse of help and formatting also serves.
    semanticTokens: {
      getLegend: () => legend,
      provideDocumentSemanticTokens(model: MonacoProviderModel) {
        const text = model.getValue();
        return { data: toMonacoSemanticTokens(text, classifyTokens(text)) };
      },
      releaseDocumentSemanticTokens() {},
    },
  };
}

function languageDocument(model: MonacoProviderModel) {
  return createLanguageDocument(model.uri.toString(), model.getValue());
}
