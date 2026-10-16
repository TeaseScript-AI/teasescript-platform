import {
  LANGUAGE_TOKEN_CLASSES,
  type LanguageCompletionItem,
  type LanguageDiagnostic,
  type LanguageHover,
  type LanguageSignatureHelp,
  type LanguageTextEdit,
  type LanguageToken,
} from "../language-tooling.js";
import type { SourcePosition, SourceSpan } from "../source.js";

export interface MonacoPosition {
  readonly lineNumber: number;
  readonly column: number;
}

export interface MonacoRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface MonacoMarker extends MonacoRange {
  readonly severity: number;
  readonly code: string;
  readonly message: string;
  readonly source: "TeaseScript";
}

export function toMonacoPosition(position: SourcePosition): MonacoPosition {
  return { lineNumber: position.line + 1, column: position.column + 1 };
}

export function toMonacoRange(span: SourceSpan): MonacoRange {
  return {
    startLineNumber: span.start.line + 1,
    startColumn: span.start.column + 1,
    endLineNumber: span.end.line + 1,
    endColumn: span.end.column + 1,
  };
}

export function toMonacoMarkers(
  diagnostics: readonly LanguageDiagnostic[],
  severity: { readonly Error: number; readonly Warning: number },
): MonacoMarker[] {
  return diagnostics.map((diagnostic) => ({
    ...toMonacoRange(diagnostic.span),
    severity: diagnostic.severity === "error" ? severity.Error : severity.Warning,
    code: diagnostic.code,
    message: diagnostic.message,
    source: "TeaseScript",
  }));
}

export function toMonacoCompletions(
  items: readonly LanguageCompletionItem[],
  range: MonacoRange,
  kinds: {
    readonly Keyword: number;
    readonly Function: number;
    readonly Variable: number;
    readonly Value: number;
  },
): {
  readonly label: string;
  readonly kind: number;
  readonly detail: string;
  readonly insertText: string;
  readonly range: MonacoRange;
}[] {
  return items.map((item) => ({
    label: item.label,
    kind:
      item.kind === "value"
        ? kinds.Value
        : item.kind === "speaker"
          ? kinds.Variable
          : item.kind === "command"
            ? kinds.Function
            : kinds.Keyword,
    detail: item.detail,
    insertText: item.insertText,
    range,
  }));
}

export function toMonacoHover(hover: LanguageHover): {
  readonly range: MonacoRange;
  readonly contents: { readonly value: string }[];
} {
  return {
    range: toMonacoRange(hover.range),
    contents: hover.contents.map((value) => ({ value })),
  };
}

export function toMonacoSignatureHelp(help: LanguageSignatureHelp): {
  readonly value: {
    readonly signatures: {
      readonly label: string;
      readonly documentation: string;
      readonly parameters: { readonly label: string }[];
    }[];
    readonly activeSignature: 0;
    readonly activeParameter: number;
  };
  dispose(): void;
} {
  return {
    value: {
      signatures: [
        {
          label: help.label,
          documentation: help.documentation,
          parameters: help.parameters.map((label) => ({ label })),
        },
      ],
      activeSignature: 0,
      activeParameter: help.activeParameter,
    },
    dispose() {},
  };
}

export function toMonacoTextEdits(
  edits: readonly LanguageTextEdit[],
): { readonly range: MonacoRange; readonly text: string }[] {
  return edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }));
}

/**
 * Classified tokens of `text` as Monaco's semantic tokens: five numbers for each, its line and start column relative to
 * the token before, its length, its class as an index of `LANGUAGE_TOKEN_CLASSES`, and no modifiers. A Monaco token
 * stays on its line, so a token over several lines, such as a block comment, gives one for each line it is on.
 */
export function toMonacoSemanticTokens(
  text: string,
  tokens: readonly LanguageToken[],
): Uint32Array {
  const data: number[] = [];
  let line = 0;
  let column = 0;
  const push = (pieceLine: number, pieceColumn: number, length: number, kind: number) => {
    data.push(pieceLine - line, pieceLine === line ? pieceColumn - column : pieceColumn, length);
    data.push(kind, 0);
    line = pieceLine;
    column = pieceColumn;
  };
  for (const token of tokens) {
    const kind = LANGUAGE_TOKEN_CLASSES.indexOf(token.kind);
    const { start, end } = token.span;
    let [pieceLine, pieceColumn, offset] = [start.line, start.column, start.offset];
    while (pieceLine < end.line) {
      // The line's piece ends before its line break, `\n` or `\r\n`.
      const lineEnd = text.indexOf("\n", offset);
      const length = lineEnd - offset - (text[lineEnd - 1] === "\r" ? 1 : 0);
      if (length > 0) push(pieceLine, pieceColumn, length, kind);
      [pieceLine, pieceColumn, offset] = [pieceLine + 1, 0, lineEnd + 1];
    }
    if (end.offset > offset) push(pieceLine, pieceColumn, end.offset - offset, kind);
  }
  return Uint32Array.from(data);
}
