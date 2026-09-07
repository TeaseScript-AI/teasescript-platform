import {
  createLanguageDocument,
  formatLanguageDocument,
  languageCompletions,
  languageHover,
  languagePositionAt,
  languageSignatureHelp,
} from "../language-tooling.js";
import {
  toMonacoCompletions,
  toMonacoHover,
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
) {
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
  };
}

function languageDocument(model: MonacoProviderModel) {
  return createLanguageDocument(model.uri.toString(), model.getValue());
}
