import type {
  LanguageCompletionItem,
  LanguageDiagnostic,
  LanguageHover,
  LanguageRange,
  LanguageSignatureHelp,
  LanguageTextEdit,
} from "../src/language-tooling.js";

export interface MonacoPositionLike {
  readonly lineNumber: number;
  readonly column: number;
}

export interface MonacoRangeLike {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface MonacoMarkerDataLike extends MonacoRangeLike {
  readonly severity: number;
  readonly code: string;
  readonly message: string;
  readonly source: "TeaseScript";
}

export interface MonacoCompletionItemLike {
  readonly label: string;
  readonly kind: number;
  readonly detail: string;
  readonly insertText: string;
  readonly range: MonacoRangeLike;
}

export interface MonacoHoverLike {
  readonly range: MonacoRangeLike;
  readonly contents: readonly { readonly value: string }[];
}

export interface MonacoSignatureHelpLike {
  readonly value: {
    readonly signatures: readonly {
      readonly label: string;
      readonly documentation: string;
      readonly parameters: readonly { readonly label: string }[];
    }[];
    readonly activeSignature: 0;
    readonly activeParameter: number;
  };
  readonly dispose: () => void;
}

export interface MonacoTextEditLike {
  readonly range: MonacoRangeLike;
  readonly text: string;
}

export interface MonacoSeverityValues {
  readonly Error: number;
  readonly Warning: number;
}

export interface MonacoCompletionKindValues {
  readonly Keyword: number;
  readonly Function: number;
  readonly Variable: number;
  readonly Value: number;
}

export function toMonacoPosition(position: { readonly line: number; readonly column: number }): MonacoPositionLike {
  return Object.freeze({ lineNumber: position.line + 1, column: position.column + 1 });
}

export function toMonacoRange(range: LanguageRange): MonacoRangeLike {
  return Object.freeze({
    startLineNumber: range.start.line + 1,
    startColumn: range.start.column + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.column + 1,
  });
}

export function toMonacoMarkers(
  diagnostics: readonly LanguageDiagnostic[],
  severity: MonacoSeverityValues,
): readonly MonacoMarkerDataLike[] {
  return Object.freeze(diagnostics.map((diagnostic) => Object.freeze({
    ...toMonacoRange(diagnostic.span),
    severity: diagnostic.severity === "error" ? severity.Error : severity.Warning,
    code: diagnostic.code,
    message: diagnostic.message,
    source: "TeaseScript" as const,
  })));
}

export function toMonacoCompletions(
  items: readonly LanguageCompletionItem[],
  replacementRange: LanguageRange,
  kinds: MonacoCompletionKindValues,
): readonly MonacoCompletionItemLike[] {
  const range = toMonacoRange(replacementRange);
  return Object.freeze(items.map((item) => Object.freeze({
    label: item.label,
    kind: completionKind(item.kind, kinds),
    detail: item.detail,
    insertText: item.insertText,
    range,
  })));
}

export function toMonacoHover(hover: LanguageHover): MonacoHoverLike {
  return Object.freeze({
    range: toMonacoRange(hover.range),
    contents: Object.freeze(hover.contents.map((value) => Object.freeze({ value }))),
  });
}

export function toMonacoSignatureHelp(help: LanguageSignatureHelp): MonacoSignatureHelpLike {
  return Object.freeze({
    value: Object.freeze({
      signatures: Object.freeze([Object.freeze({
        label: help.label,
        documentation: help.documentation,
        parameters: Object.freeze(help.parameters.map((label) => Object.freeze({ label }))),
      })]),
      activeSignature: 0 as const,
      activeParameter: help.activeParameter,
    }),
    dispose() {},
  });
}

export function toMonacoTextEdits(edits: readonly LanguageTextEdit[]): readonly MonacoTextEditLike[] {
  return Object.freeze(edits.map((edit) => Object.freeze({ range: toMonacoRange(edit.range), text: edit.newText })));
}

function completionKind(kind: LanguageCompletionItem["kind"], kinds: MonacoCompletionKindValues): number {
  switch (kind) {
    case "command": return kinds.Function;
    case "speaker": return kinds.Variable;
    case "value": return kinds.Value;
    case "keyword":
    case "modifier": return kinds.Keyword;
  }
}
