import type { IDisposable } from "monaco-editor";

import { lex } from "../src/lexer.js";
import { TokenKind, type Token } from "../src/token.js";
import {
  monacoCompletions,
  monacoDiagnostics,
  monacoFormattingEdits,
  monacoHover,
  monacoSignatureHelp,
} from "./monaco-language.js";

export type MonacoApi = typeof import("monaco-editor");

export const TEASESCRIPT_LANGUAGE_ID = "teasescript";
export const TEASESCRIPT_MARKER_OWNER = "teasescript";

const SEMANTIC_TOKEN_TYPES = Object.freeze([
  "keyword",
  "string",
  "number",
  "variable",
  "function",
  "operator",
  "comment",
]);

const semanticTokenTypeIndex = new Map(SEMANTIC_TOKEN_TYPES.map((name, index) => [name, index] as const));
const compactFunctionNames = new Set(["showButton", "askText", "askNumber", "choose"]);
const compactModifierNames = new Set(["skippable", "unskippable", "instant"]);

interface AbsoluteSemanticToken {
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly type: string;
}

export interface TeaseScriptSemanticTokens {
  readonly legend: {
    readonly tokenTypes: readonly string[];
    readonly tokenModifiers: readonly string[];
  };
  readonly data: Uint32Array;
}

export function createTeaseScriptSemanticTokens(source: string): TeaseScriptSemanticTokens {
  const lexical = lex(source);
  const tokens: AbsoluteSemanticToken[] = [];
  for (const token of lexical.tokens) {
    if (token.kind === TokenKind.EndOfFile || token.kind === TokenKind.Newline) continue;
    const type = semanticTypeForToken(token);
    if (type === null) continue;
    appendSpanTokens(source, token.span.start.offset, token.span.end.offset, token.span.start.line, token.span.start.column, type, tokens);
  }
  const lineStarts = sourceLineStarts(source);
  for (const comment of commentSpansInLexerGaps(source, lexical.tokens)) {
    const start = positionFromLineStarts(lineStarts, comment.start);
    appendSpanTokens(source, comment.start, comment.end, start.line, start.column, "comment", tokens);
  }
  tokens.sort((left, right) => left.line - right.line || left.column - right.column);

  const encoded: number[] = [];
  let previousLine = 0;
  let previousColumn = 0;
  for (const token of tokens) {
    const typeIndex = semanticTokenTypeIndex.get(token.type);
    if (typeIndex === undefined || token.length <= 0) continue;
    const deltaLine = token.line - previousLine;
    const deltaColumn = deltaLine === 0 ? token.column - previousColumn : token.column;
    encoded.push(deltaLine, deltaColumn, token.length, typeIndex, 0);
    previousLine = token.line;
    previousColumn = token.column;
  }

  return Object.freeze({
    legend: Object.freeze({ tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: Object.freeze([]) }),
    data: Uint32Array.from(encoded),
  });
}

export function registerTeaseScriptMonaco(monaco: MonacoApi): IDisposable {
  monaco.languages.register({
    id: TEASESCRIPT_LANGUAGE_ID,
    extensions: [".tease"],
    aliases: ["TeaseScript", "teasescript"],
  });

  const disposables: IDisposable[] = [];
  disposables.push(monaco.languages.setLanguageConfiguration(TEASESCRIPT_LANGUAGE_ID, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "`", close: "`" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "`", close: "`" },
    ],
    indentationRules: {
      increaseIndentPattern: /\{\s*(?:\/\/.*)?$/u,
      decreaseIndentPattern: /^\s*\}/u,
    },
  }));

  disposables.push(monaco.languages.registerCompletionItemProvider(TEASESCRIPT_LANGUAGE_ID, {
    provideCompletionItems(model, position) {
      const result = monacoCompletions(model, position, monaco.languages.CompletionItemKind);
      return { suggestions: [...result.suggestions] };
    },
  }));

  disposables.push(monaco.languages.registerHoverProvider(TEASESCRIPT_LANGUAGE_ID, {
    provideHover(model, position) {
      const hover = monacoHover(model, position);
      return hover === null ? null : { range: hover.range, contents: [...hover.contents] };
    },
  }));

  disposables.push(monaco.languages.registerSignatureHelpProvider(TEASESCRIPT_LANGUAGE_ID, {
    signatureHelpTriggerCharacters: [" ", ","],
    signatureHelpRetriggerCharacters: [" ", ","],
    provideSignatureHelp(model, position) {
      const result = monacoSignatureHelp(model, position);
      if (result === null) return null;
      return {
        value: {
          signatures: result.value.signatures.map((signature) => ({
            label: signature.label,
            documentation: signature.documentation,
            parameters: signature.parameters.map((parameter) => ({ label: parameter.label })),
          })),
          activeSignature: result.value.activeSignature,
          activeParameter: result.value.activeParameter,
        },
        dispose() {},
      };
    },
  }));

  disposables.push(monaco.languages.registerDocumentFormattingEditProvider(TEASESCRIPT_LANGUAGE_ID, {
    displayName: "TeaseScript",
    provideDocumentFormattingEdits(model) {
      return [...monacoFormattingEdits(model)];
    },
  }));

  const semantic = createTeaseScriptSemanticTokens("");
  disposables.push(monaco.languages.registerDocumentSemanticTokensProvider(TEASESCRIPT_LANGUAGE_ID, {
    getLegend() {
      return { tokenTypes: [...semantic.legend.tokenTypes], tokenModifiers: [] };
    },
    provideDocumentSemanticTokens(model) {
      return { data: createTeaseScriptSemanticTokens(model.getValue()).data };
    },
    releaseDocumentSemanticTokens() {},
  }));

  const modelListeners = new Map<import("monaco-editor").editor.ITextModel, IDisposable>();
  const refreshMarkers = (model: import("monaco-editor").editor.ITextModel): void => {
    if (model.getLanguageId() !== TEASESCRIPT_LANGUAGE_ID) {
      monaco.editor.setModelMarkers(model, TEASESCRIPT_MARKER_OWNER, []);
      return;
    }
    monaco.editor.setModelMarkers(model, TEASESCRIPT_MARKER_OWNER, [
      ...monacoDiagnostics(model, monaco.MarkerSeverity),
    ]);
  };
  const attachModel = (model: import("monaco-editor").editor.ITextModel): void => {
    modelListeners.get(model)?.dispose();
    refreshMarkers(model);
    modelListeners.set(model, model.onDidChangeContent(() => refreshMarkers(model)));
  };

  for (const model of monaco.editor.getModels()) attachModel(model);
  disposables.push(monaco.editor.onDidCreateModel(attachModel));
  disposables.push(monaco.editor.onDidChangeModelLanguage(({ model }) => attachModel(model)));
  disposables.push(monaco.editor.onWillDisposeModel((model) => {
    modelListeners.get(model)?.dispose();
    modelListeners.delete(model);
  }));

  return {
    dispose() {
      for (const listener of modelListeners.values()) listener.dispose();
      modelListeners.clear();
      for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
    },
  };
}

function semanticTypeForToken(token: Token): string | null {
  if (isKeywordKind(token.kind)) return "keyword";
  switch (token.kind) {
    case TokenKind.StringLiteral:
    case TokenKind.TemplateStart:
    case TokenKind.TemplateText:
    case TokenKind.TemplateEnd:
      return "string";
    case TokenKind.NumberLiteral:
      return "number";
    case TokenKind.Identifier:
      if (compactFunctionNames.has(token.lexeme)) return "function";
      if (compactModifierNames.has(token.lexeme)) return "keyword";
      return "variable";
    case TokenKind.EndOfFile:
    case TokenKind.Newline:
      return null;
    default:
      return "operator";
  }
}

function isKeywordKind(kind: Token["kind"]): boolean {
  return kind.startsWith("keyword");
}

function appendSpanTokens(
  source: string,
  startOffset: number,
  endOffset: number,
  startLine: number,
  startColumn: number,
  type: string,
  target: AbsoluteSemanticToken[],
): void {
  let line = startLine;
  let column = startColumn;
  let segmentStartColumn = column;
  let segmentLength = 0;
  let offset = startOffset;
  const flush = (): void => {
    if (segmentLength > 0) target.push(Object.freeze({ line, column: segmentStartColumn, length: segmentLength, type }));
    segmentLength = 0;
  };
  while (offset < endOffset) {
    const character = source[offset] ?? "";
    if (character === "\r" && source[offset + 1] === "\n") {
      flush();
      offset += 2;
      line += 1;
      column = 0;
      segmentStartColumn = 0;
      continue;
    }
    if (character === "\n") {
      flush();
      offset += 1;
      line += 1;
      column = 0;
      segmentStartColumn = 0;
      continue;
    }
    if (segmentLength === 0) segmentStartColumn = column;
    segmentLength += 1;
    column += 1;
    offset += 1;
  }
  flush();
}


function sourceLineStarts(source: string): readonly number[] {
  const starts = [0];
  let offset = 0;
  while (offset < source.length) {
    if (source[offset] === "\r" && source[offset + 1] === "\n") {
      offset += 2;
      starts.push(offset);
      continue;
    }
    if (source[offset] === "\n") starts.push(offset + 1);
    offset += 1;
  }
  return starts;
}

function positionFromLineStarts(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  const start = lineStarts[low] ?? 0;
  return { line: low, column: offset - start };
}

function commentSpansInLexerGaps(source: string, tokens: readonly Token[]): readonly { start: number; end: number }[] {
  const covered = tokens
    .filter((token) => token.kind !== TokenKind.Newline && token.kind !== TokenKind.EndOfFile)
    .map((token) => ({ start: token.span.start.offset, end: token.span.end.offset }))
    .sort((left, right) => left.start - right.start);
  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const interval of [...covered, { start: source.length, end: source.length }]) {
    scanGapForComments(source, cursor, interval.start, spans);
    cursor = Math.max(cursor, interval.end);
  }
  return Object.freeze(spans.map((span) => Object.freeze(span)));
}

function scanGapForComments(source: string, start: number, end: number, target: { start: number; end: number }[]): void {
  let offset = start;
  while (offset < end) {
    if (source[offset] === "/" && source[offset + 1] === "/") {
      const commentStart = offset;
      offset += 2;
      while (offset < end && source[offset] !== "\n" && source[offset] !== "\r") offset += 1;
      target.push({ start: commentStart, end: offset });
      continue;
    }
    if (source[offset] === "/" && source[offset + 1] === "*") {
      const commentStart = offset;
      offset += 2;
      while (offset < end && !(source[offset] === "*" && source[offset + 1] === "/")) offset += 1;
      if (offset < end) offset += 2;
      target.push({ start: commentStart, end: offset });
      continue;
    }
    offset += 1;
  }
}
