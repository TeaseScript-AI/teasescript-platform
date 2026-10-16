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
import { isNativeStackExhaustion } from "../compiler.js";
import { lex } from "../lexer.js";
import { parse } from "../parser.js";
import { TokenKind } from "../token.js";
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
  lineTokens(provider: TeaseScriptProviders["lineTokens"]): void;
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
  registration.lineTokens(providers.lineTokens);
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
    // Monaco's bracket matching, bracket colours, and quote closing skip what a line's tokens mark as text, a regex, or
    // a comment, which semantic tokens cannot mark. The compiler reads each line for them, before the classes arrive
    // as well.
    lineTokens: {
      getInitialState: () => LINE_STARTS.code,
      tokenize(line: string, state: LineState) {
        return tokenizeLine(line, state);
      },
    },
  };
}

/** Where a line starts: in code, or inside a block comment or a block string a line before left open. */
class LineState {
  public constructor(public readonly inside: "code" | "comment" | "string") {}

  public clone(): LineState {
    return this;
  }

  public equals(other: unknown): boolean {
    return other instanceof LineState && other.inside === this.inside;
  }
}

const LINE_STARTS = {
  code: new LineState("code"),
  comment: new LineState("comment"),
  string: new LineState("string"),
};

/** What the lexer reads before a line that starts inside a block comment or a block string, so it continues it. */
const OPENERS = { code: "", comment: "/*", string: '"""' } as const;

const TEXT_TOKENS: ReadonlySet<TokenKind> = new Set([
  TokenKind.StringStart,
  TokenKind.StringText,
  TokenKind.StringEnd,
]);

/**
 * A line's text, regexes, and comments as the compiler reads the line on its own, as Monaco's scopes, and where the
 * next line starts. A line holds no single-line string or regex of a line before, as neither continues past its line.
 */
function tokenizeLine(
  line: string,
  state: LineState,
): { readonly tokens: { startIndex: number; scopes: string }[]; readonly endState: LineState } {
  const opener = OPENERS[state.inside];
  const text = opener + line;
  // The line is lexed as its parse reads it, so a regex where the parser expects a value is one (V30 §8).
  let regexStarts: ReadonlySet<number> = new Set();
  try {
    regexStarts = parse(text).regexStarts;
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
  }
  const { tokens, comments } = lex(text, regexStarts);
  const marked = comments.map((span) => ({ span, scopes: "comment" }));
  // The strings still open, innermost last.
  const open: string[] = [];
  for (const token of tokens) {
    if (token.kind === TokenKind.StringStart) open.push(token.lexeme);
    if (token.kind === TokenKind.StringEnd) open.pop();
    if (TEXT_TOKENS.has(token.kind)) marked.push({ span: token.span, scopes: "string" });
    if (token.kind === TokenKind.RegexLiteral) marked.push({ span: token.span, scopes: "regexp" });
  }
  marked.sort((left, right) => left.span.start.offset - right.span.start.offset);
  const scopes: { startIndex: number; scopes: string }[] = [];
  const mark = (startIndex: number, scope: string) => {
    if (scopes.at(-1)?.startIndex === startIndex) scopes.pop();
    if (scopes.at(-1)?.scopes !== scope) scopes.push({ startIndex, scopes: scope });
  };
  mark(0, "");
  for (const { span, scopes: scope } of marked) {
    const start = Math.max(span.start.offset - opener.length, 0);
    const end = span.end.offset - opener.length;
    if (end <= start) continue;
    mark(start, scope);
    if (end < line.length) mark(end, "");
  }
  const comment = comments.at(-1);
  const closed = (written: string) => written.length >= 4 && written.endsWith("*/");
  const inside =
    comment !== undefined &&
    comment.end.offset === text.length &&
    text.startsWith("/*", comment.start.offset) &&
    !closed(text.slice(comment.start.offset))
      ? "comment"
      : open[0] === '"""'
        ? "string"
        : "code";
  return { tokens: scopes, endState: LINE_STARTS[inside] };
}

function languageDocument(model: MonacoProviderModel) {
  return createLanguageDocument(model.uri.toString(), model.getValue());
}
