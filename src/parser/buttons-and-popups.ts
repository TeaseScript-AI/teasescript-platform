import { parseChild, type ParseTask } from "../parse-continuation.js";
import type {
  Block,
  Expression,
  Identifier,
  PositionalArgument,
  ShowButtonParts,
  ShowButtonStatement,
  ShowPermanentButtonParts,
  ShowPopupParts,
  ShowPopupStatement,
  OpenUrlStatement,
  ExportTextStatement,
  Statement,
} from "../ast.js";
import { startsCallForm } from "../language-facts.js";
import type { SourceSpan } from "../source.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, spanFrom } from "./tokens.js";

// The commands that show a button or a popup: `showButton`, `showPopup`, `openUrl`, `exportText`, and `showPermanentButton`.

/** The named options of `showButton` after its label. */
export const SHOW_BUTTON_OPTIONS: readonly string[] = ["background", "timeout"];
/** The named arguments of `showPopup` besides its message, which it takes first or as `message:` (V30 §31). */
export const SHOW_POPUP_OPTIONS: readonly string[] = ["buttonText"];
/** The named arguments of `openUrl` after its web address (V30 §33). */
export const OPEN_URL_OPTIONS: readonly string[] = ["buttonText", "alwaysButton"];
/** The named arguments of `exportText` after its text (V30 §31). */
export const EXPORT_TEXT_OPTIONS: readonly string[] = ["title", "fileName"];

/** The named options of `showPermanentButton` after its text (V30 §28). */
export const PERMANENT_BUTTON_OPTIONS: readonly string[] = ["persist"];

/** Expressions that end at their own last token, so a following `, name:` cannot belong to them. */
const SELF_DELIMITED_EXPRESSIONS: ReadonlySet<Expression["kind"]> = new Set([
  "stringLiteral",
  "identifier",
  "parenthesizedExpression",
  "propertyAccessExpression",
  "indexExpression",
  "callExpression",
]);

export function* parseShowPopupStatement(parser: Parser): ParseTask<ShowPopupStatement | null> {
  const parts = yield* parseChild(parseShowPopupParts(parser));
  if (parts === null) return null;
  if (parser.check(TokenKind.Comma)) {
    reportShowPopupCommandComma(parser, parser.peek());
    return null;
  }
  return Object.freeze({ kind: "showPopupStatement", ...parts });
}

/**
 * `showPopup <message>`, or the call `showPopup(...)` when a parenthesis follows (V30 §31). The command form takes only
 * the message, as one positional argument. A comma after it that is not followed by `buttonText:` or `message:` is
 * left to the enclosing statement, list, call, or object.
 */
export function* parseShowPopupParts(parser: Parser): ParseTask<ShowPopupParts | null> {
  const command = parser.advance();
  if (startsCallForm(command, parser.peek())) {
    const call = yield* parseChild(
      parser.withinDelimiters(parser.finishCall(parser.identifier(command), parser.advance())),
    );
    parser.recordCommand(command, call.span.end.offset, false);
    return { arguments: call.arguments, span: copySpan(call.span) };
  }
  const mark = parser.mark();
  const message = yield* parseChild(parser.parseOr());
  if (message === null) {
    parser.reportMissing(
      mark,
      parserDiagnosticCode.expectedExpression,
      "Expected the popup's message after 'showPopup', as in 'showPopup \"Task completed\"'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  parser.recordCommand(command, message.span.end.offset, false);
  const offset = parser.offsetAfterComma();
  const name = offset === null ? null : parser.peek(offset);
  if (
    offset !== null &&
    name?.kind === TokenKind.Identifier &&
    (name.lexeme === "message" || SHOW_POPUP_OPTIONS.includes(name.lexeme)) &&
    parser.peek(offset + 1).kind === TokenKind.Colon
  ) {
    let comma = offset - 1;
    while (parser.peek(comma).kind !== TokenKind.Comma) comma -= 1;
    reportShowPopupCommandComma(parser, parser.peek(comma));
    return null;
  }
  return {
    arguments: Object.freeze([
      Object.freeze({
        kind: "positionalArgument",
        value: message,
        span: copySpan(message.span),
      } satisfies PositionalArgument),
    ]),
    span: spanFrom(command.span, message.span),
  };
}

function reportShowPopupCommandComma(parser: Parser, comma: Token): void {
  parser.reportToken(
    parserDiagnosticCode.unsupportedInteractionForm,
    'The command form of showPopup takes only the message. For other button text, write \'showPopup(message: "Task completed", buttonText: "Continue")\'.',
    comma,
  );
  parser.synchronizeStatement();
}

/** `openUrl(<url>)` (V30 §33), which has only the call form. */
export function* parseOpenUrlStatement(parser: Parser): ParseTask<OpenUrlStatement | null> {
  const command = parser.advance();
  if (!startsCallForm(command, parser.peek())) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedDelimiter,
      "openUrl takes its web address in parentheses, as in 'openUrl(\"https://example.com\")'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const call = yield* parseChild(
    parser.withinDelimiters(parser.finishCall(parser.identifier(command), parser.advance())),
  );
  parser.recordCommand(command, call.span.end.offset, false);
  return Object.freeze({
    kind: "openUrlStatement",
    arguments: call.arguments,
    span: copySpan(call.span),
  });
}

/** `exportText(<text>, title: ..., fileName: ...)` (V30 §31), which has only the call form. */
export function* parseExportTextStatement(parser: Parser): ParseTask<ExportTextStatement | null> {
  const command = parser.advance();
  if (!startsCallForm(command, parser.peek())) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedDelimiter,
      "exportText takes its text in parentheses, as in 'exportText(report)'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const call = yield* parseChild(
    parser.withinDelimiters(parser.finishCall(parser.identifier(command), parser.advance())),
  );
  parser.recordCommand(command, call.span.end.offset, false);
  return Object.freeze({
    kind: "exportTextStatement",
    arguments: call.arguments,
    span: copySpan(call.span),
  });
}

export function* parseShowButtonStatement(parser: Parser): ParseTask<ShowButtonStatement | null> {
  const parts = yield* parseChild(parseShowButtonParts(parser));
  if (parts === null) return null;
  if (parser.check(TokenKind.Comma)) {
    parser.reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      "showButton accepts only background: and timeout: after the button text.",
      parser.peek().span,
    );
    parser.synchronizeStatement();
  }
  return Object.freeze({ kind: "showButtonStatement", ...parts });
}

/**
 * `showButton [as speaker] label [, background: colour] [, timeout: duration]`. A comma that is not followed by one
 * of the two options is left to the enclosing statement, list, call, or object.
 */
export function* parseShowButtonParts(parser: Parser): ParseTask<ShowButtonParts | null> {
  const command = parser.advance();
  if (parser.check(TokenKind.LeftParenthesis)) {
    parser.reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      "Parenthesized showButton arguments are not supported in the compact interaction syntax.",
      parser.peek().span,
    );
    parser.synchronizeStatement();
    return null;
  }
  let asSpan: SourceSpan | null = null;
  let speaker: Identifier | null = null;
  if (!parser.atStorageDelimiter() && parser.match(TokenKind.KeywordAs)) {
    asSpan = copySpan(parser.previous().span);
    if (!parser.check(TokenKind.Identifier)) {
      parser.reportMissingSpeakerAfterAs();
      parser.synchronizeStatement();
      return null;
    }
    speaker = parser.identifier(parser.advance());
  }
  if (parser.check(TokenKind.LeftParenthesis)) {
    parser.reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      "Parenthesized showButton arguments are not supported in the compact interaction syntax.",
      parser.peek().span,
    );
    parser.synchronizeStatement();
    return null;
  }
  const mark = parser.mark();
  const label = yield* parseChild(parser.parseOr());
  if (label === null) {
    parser.reportMissing(
      mark,
      parserDiagnosticCode.expectedInteractionText,
      "Expected button text after 'showButton'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  let background: Expression | null = null;
  let timeout: Expression | null = null;
  for (
    let offset = parser.offsetAfterComma();
    offset !== null;
    offset = parser.offsetAfterComma()
  ) {
    const name = parser.peek(offset);
    const option =
      name.kind === TokenKind.Identifier &&
      SHOW_BUTTON_OPTIONS.includes(name.lexeme) &&
      parser.peek(offset + 1).kind === TokenKind.Colon
        ? name.lexeme
        : null;
    if (option === null) break;
    for (let skipped = 0; skipped < offset + 2; skipped += 1) parser.advance();
    const mark = parser.mark();
    const value = yield* parseChild(parser.parseColonValueTask(false));
    if (value === null) {
      parser.reportMissing(
        mark,
        parserDiagnosticCode.expectedInteractionText,
        option === "background"
          ? "Expected a button background colour."
          : "Expected a button timeout, such as timeout: 5 or timeout: 500 ms.",
      );
      // A statement at the start of a continued line is kept, as for choice values.
      if (parser.previous().kind === TokenKind.Newline && parser.atStatementStart())
        parser.recoveredAtStatementBoundary = true;
      return null;
    }
    if ((option === "background" ? background : timeout) !== null) {
      parser.reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        `showButton accepts one ${option}: option.`,
        name.span,
      );
    }
    if (option === "background") background = value;
    else timeout = value;
  }
  if (parser.check(TokenKind.KeywordAs) && !parser.atStorageDelimiter()) {
    parser.reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      "The 'as speaker' clause must appear immediately after 'showButton'.",
      parser.peek().span,
    );
    parser.synchronizeStatement();
  }
  const last = [background, timeout].reduce<Expression>(
    (latest, option) =>
      option !== null && option.span.end.offset > latest.span.end.offset ? option : latest,
    label,
  );
  return {
    commandSpan: copySpan(command.span),
    asSpan,
    speaker,
    label,
    background,
    timeout,
    span: spanFrom(command.span, last.span),
  };
}

/**
 * `showPermanentButton <text>[, persist: true|false] { ... }`: the text and its options are followed by the required
 * block with the click action.
 */
export function* parseShowPermanentButtonParts(
  parser: Parser,
): ParseTask<ShowPermanentButtonParts | null> {
  const command = parser.advance();
  if (
    parser.rejectAdjacentParenthesis(
      command,
      "showPermanentButton uses command syntax, such as 'showPermanentButton \"Stop\" { goto stopped }'.",
    )
  ) {
    // The block belongs to the rejected command.
    if (parser.check(TokenKind.LeftBrace)) parser.skipMalformedBlock();
    return null;
  }
  const enclosing = parser.blockEndsCompactInteraction;
  parser.blockEndsCompactInteraction = true;
  const textStart = parser.current;
  const mark = parser.mark();
  const text = yield* parseChild(parser.parseOr());
  const textEnd = parser.current;
  const options = text === null ? null : yield* parseChild(parsePermanentButtonOptions(parser));
  parser.blockEndsCompactInteraction = enclosing;
  if (text !== null) parser.recordCommand(command, parser.lastEnd(), true);
  if (text === null) {
    // Text that reported its own error, as `"Stop" + {`, needs no second one.
    parser.reportMissing(
      mark,
      parserDiagnosticCode.expectedInteractionText,
      "Expected button text after 'showPermanentButton'.",
    );
    // The block belongs to the button.
    if (parser.check(TokenKind.LeftBrace)) parser.skipMalformedBlock();
    else parser.synchronizeStatement();
    return null;
  }
  if (!parser.check(TokenKind.LeftBrace)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedBlock,
      "Expected '{' with what the button does when clicked, such as 'showPermanentButton \"Stop\" { goto stopped }'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const handler = yield* parseChild(
    parser.asStatements(parsePermanentButtonBlock(parser, text, textStart, textEnd)),
  );
  if (handler === null || options === null) return null;
  return {
    text,
    persist: options.persist,
    handler,
    commandSpan: copySpan(command.span),
    span: spanFrom(command.span, handler.span),
  };
}

/** The named options after the button text, each after a comma; `null` reports an already diagnosed failure. */
function* parsePermanentButtonOptions(parser: Parser): ParseTask<{ persist: boolean } | null> {
  let persist = false;
  let valid = true;
  const seen = new Set<string>();
  for (
    let offset = parser.offsetAfterComma();
    offset !== null &&
    parser.peek(offset).kind === TokenKind.Identifier &&
    parser.peek(offset + 1).kind === TokenKind.Colon;
    offset = parser.offsetAfterComma()
  ) {
    for (let skipped = 0; skipped < offset; skipped += 1) parser.advance();
    const name = parser.advance();
    parser.advance();
    // A missing value leaves the block, also one on the next line, to the button.
    let blockOffset = 0;
    while (parser.peek(blockOffset).kind === TokenKind.Newline) blockOffset += 1;
    const atBlock = parser.peek(blockOffset).kind === TokenKind.LeftBrace;
    if (atBlock) parser.skipNewlines();
    const value = atBlock ? null : yield* parseChild(parser.parseColonValueTask(false));
    if (value === null) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedExpression,
        `Expected true or false after '${name.lexeme}:'.`,
      );
      valid = false;
    } else if (seen.has(name.lexeme)) {
      parser.reportSpan(
        parserDiagnosticCode.invalidMediaForm,
        `Duplicate showPermanentButton option '${name.lexeme}'.`,
        name.span,
      );
      valid = false;
    } else if (!PERMANENT_BUTTON_OPTIONS.includes(name.lexeme)) {
      parser.reportSpan(
        parserDiagnosticCode.invalidMediaForm,
        `Unknown showPermanentButton option '${name.lexeme}'. The only option is 'persist'.`,
        name.span,
      );
      valid = false;
    } else if (value.kind !== "booleanLiteral") {
      parser.reportSpan(
        parserDiagnosticCode.invalidMediaForm,
        "showPermanentButton option 'persist' must be the literal true or false.",
        value.span,
      );
      valid = false;
    } else {
      persist = value.value;
    }
    seen.add(name.lexeme);
  }
  return valid ? { persist } : null;
}

/**
 * The click action of a permanent button. A first line `persist: ...`, the earlier spelling of the option, is reported
 * with the command that replaces it; `text` is the button text, written by the tokens from `textStart` to `textEnd`.
 */
function* parsePermanentButtonBlock(
  parser: Parser,
  text: Expression,
  textStart: number,
  textEnd: number,
): ParseTask<Block | null> {
  const leftBrace = parser.advance();
  parser.skipNewlines();
  if (parser.checkIdentifier("persist") && parser.peek(1).kind === TokenKind.Colon) {
    let written = parser.sourceText(textStart, textEnd);
    // Text such as a compact `askChoice` would take the option as its own, so it is grouped.
    if (!SELF_DELIMITED_EXPRESSIONS.has(text.kind)) written = `(${written})`;
    parser.reportToken(
      parserDiagnosticCode.invalidMediaForm,
      `Write 'persist:' on the command instead of in the block: 'showPermanentButton ${written}, persist: true {'.`,
      parser.peek(),
    );
    parser.synchronizeStatement(true);
    parser.finishStatement(true);
    parser.skipNewlines();
  }
  const statements: Statement[] = [];
  while (!parser.check(TokenKind.RightBrace) && !parser.check(TokenKind.EndOfFile)) {
    const startIndex = parser.current;
    const diagnosticCount = parser.diagnostics.length;
    const statement = yield* parseChild(parser.parseStatement());
    if (statement !== null) statements.push(statement);
    parser.endStatement(startIndex, diagnosticCount, true);
  }
  if (!parser.closeBlock(leftBrace)) return null;
  const span = spanFrom(leftBrace.span, parser.previous().span);
  return Object.freeze({ kind: "block", statements: Object.freeze(statements), span });
}
