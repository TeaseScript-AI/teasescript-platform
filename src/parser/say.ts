import { isMessagePresentationOption } from "../message-presentation.js";
import { parseChild, runParse, type ParseTask } from "../parse-continuation.js";
import type {
  Expression,
  Identifier,
  ObjectLiteral,
  ObjectProperty,
  SayParts,
  SpeakerDeclaration,
  SpeakerProperty,
  SpeakerSetterStatement,
} from "../ast.js";
import type { SourceSpan } from "../source.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, delimiterClosers, isPropertyName, spanFrom } from "./tokens.js";

// Speakers and `say`: speaker declarations and properties, and a message's parts, mode, and pacing.

export function parseSpeakerStatement(
  parser: Parser,
): SpeakerDeclaration | SpeakerSetterStatement | null {
  const keyword = parser.advance();
  if (!parser.checkDeclarationName()) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedSpeakerIdentifier,
      "Expected a speaker identifier after 'speaker'.",
    );
    if (parser.check(TokenKind.LeftBrace)) parser.skipMalformedBlock();
    else parser.synchronizeStatement();
    return null;
  }

  // Only a declaration names a speaker of its own; a setter names one declared elsewhere, as in `speaker player`.
  const name =
    parser.peek(1).kind === TokenKind.LeftBrace
      ? parser.declarationName("speaker")
      : parser.identifier(parser.advance());
  if (parser.match(TokenKind.LeftBrace)) {
    return parseSpeakerDeclaration(parser, keyword, name);
  }
  return Object.freeze({
    kind: "speakerSetterStatement",
    speaker: name,
    span: spanFrom(keyword.span, name.span),
  });
}

function parseSpeakerDeclaration(
  parser: Parser,
  keyword: Token,
  name: Identifier,
): SpeakerDeclaration {
  const leftBrace = parser.previous();
  const properties: SpeakerProperty[] = [];
  let lastSpan = leftBrace.span;

  while (!parser.check(TokenKind.EndOfFile)) {
    parser.skipNewlines();
    if (parser.match(TokenKind.RightBrace)) {
      return speakerDeclaration(keyword, name, properties, parser.previous().span);
    }
    if (parser.isRecoveredTopLevelStatement()) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedRightBrace,
        "Expected '}' to close the speaker declaration.",
      );
      parser.recoveredAtStatementBoundary = true;
      return speakerDeclaration(keyword, name, properties, lastSpan);
    }

    const property = parseSpeakerProperty(parser);
    if (property !== null) {
      properties.push(property);
      lastSpan = property.span;
    }
    if (
      property !== null &&
      !parser.check(TokenKind.Newline) &&
      !parser.check(TokenKind.RightBrace) &&
      !parser.check(TokenKind.EndOfFile)
    ) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedPropertyEnd,
        "Expected a newline or '}' after the speaker property.",
      );
      parser.synchronizeProperty();
    }
  }

  parser.reportInsertion(
    parserDiagnosticCode.expectedRightBrace,
    "Expected '}' to close the speaker declaration.",
  );
  return speakerDeclaration(keyword, name, properties, lastSpan);
}

function parseSpeakerProperty(parser: Parser): SpeakerProperty | null {
  if (!isPropertyName(parser.peek())) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedPropertyName,
      "Expected a speaker property name.",
    );
    parser.synchronizeProperty();
    return null;
  }
  const name = parser.identifier(parser.advance());
  if (!parser.match(TokenKind.Colon)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedColon,
      "Expected ':' after the speaker property name.",
    );
    parser.synchronizeProperty();
    return null;
  }
  const value = runParse(parser.parseColonValueTask(false));
  if (value === null) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedString,
      "Expected a string for the speaker property.",
    );
    // At the start of a continued line, the declaration recovers at the token left there.
    if (parser.previous().kind !== TokenKind.Newline) parser.synchronizeProperty();
    return null;
  }
  return Object.freeze({
    kind: "speakerProperty",
    name,
    value,
    span: spanFrom(name.span, value.span),
  });
}

/**
 * `say [as speaker] [bubble(options) | prose(options)] [skippable | unskippable] text [, pacing]`, or its bounded form
 * with the text and pacing in parentheses, `say("Waiting.", instant)`. A statement reads parentheses as the bounded
 * form only when a comma follows their first value; others group a value as before, as in `say (a) + b`. A value reads
 * them as the bounded form, so it ends at its `)`. Before that form a mode is written with its options, `say bubble() ("Plain", instant)`, while
 * `say bubble("x")` shows the value of a call; as a value, a skip word before parentheses is the modifier.
 */
export function* parseSayParts(parser: Parser, statement: boolean): ParseTask<SayParts | null> {
  const keyword = parser.advance();
  let speaker: Identifier | null = null;
  if (parser.match(TokenKind.KeywordAs)) {
    if (!parser.check(TokenKind.Identifier)) {
      parser.reportMissingSpeakerAfterAs();
      if (statement) parser.synchronizeStatement();
      return null;
    }
    speaker = parser.identifier(parser.advance());
  }

  const presentation =
    parser.check(TokenKind.Identifier) &&
    ["bubble", "prose"].includes(parser.peek().lexeme) &&
    (atSayModeBeforeBoundedText(parser) ||
      !(yield* parseChild(
        parser.canParseCompleteSayValue(statement, peekAfterSayMode(parser)?.kind),
      )))
      ? yield* parseChild(parseSayPresentation(parser))
      : null;

  let skipPolicy: SayParts["skipPolicy"] = null;
  let skipPolicySpan: SourceSpan | null = null;
  if (
    (parser.checkIdentifier("skippable") || parser.checkIdentifier("unskippable")) &&
    ((!statement && parser.peek(1).kind === TokenKind.LeftParenthesis) ||
      !(yield* parseChild(parser.canParseCompleteSayValue(statement, parser.peek(1).kind))))
  ) {
    skipPolicy = parser.peek().lexeme === "skippable" ? "skippable" : "unskippable";
    skipPolicySpan = copySpan(parser.advance().span);
  }

  if (
    parser.check(TokenKind.LeftParenthesis) &&
    (!statement || (yield* parseChild(parser.opensBoundedSayText())))
  ) {
    const bounded = yield* parseChild(parser.withinDelimiters(parseBoundedSayText(parser)));
    if (bounded === null) {
      if (statement) parser.synchronizeStatement();
      return null;
    }
    return Object.freeze({
      presentation,
      speaker,
      skipPolicy,
      skipPolicySpan,
      value: bounded.value,
      pacing: bounded.pacing,
      instantSpan: bounded.instantSpan,
      span: spanFrom(keyword.span, bounded.end),
    });
  }

  const valueStart = parser.peek().kind;
  const value = yield* parseChild(parser.parseOr());
  if (value === null) {
    if (valueStart !== TokenKind.StringStart)
      parser.reportInsertion(parserDiagnosticCode.expectedString, "Expected a string after 'say'.");
    if (statement) parser.synchronizeStatement();
    return null;
  }
  let pacing: SayParts["pacing"] = null;
  let instantSpan: SourceSpan | null = null;
  let endSpan = value.span;
  if (parser.match(TokenKind.Comma)) {
    if (parser.canParseInstantPacingAlias(statement)) {
      endSpan = parser.advance().span;
      pacing = "instant";
      instantSpan = copySpan(endSpan);
    } else {
      const parsedPacing = yield* parseChild(parser.parseOr());
      if (parsedPacing === null) {
        parser.reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected a pacing value after ','.",
        );
        if (statement) parser.synchronizeStatement();
        return null;
      }
      pacing = parsedPacing;
      endSpan = parsedPacing.span;
    }
  }
  return Object.freeze({
    presentation,
    speaker,
    skipPolicy,
    skipPolicySpan,
    value,
    pacing,
    instantSpan,
    span: spanFrom(keyword.span, endSpan),
  });
}

/** A `say` used as a value, parsed once per position and context (see `SharedParse.sayValues`). */
export function* parseSayValue(parser: Parser): ParseTask<SayParts | null> {
  const start = parser.current;
  const parsed = parser.shared.sayValues.get(start) ?? [];
  const known = parsed.find(
    (value) =>
      value.insideDelimiters === parser.insideDelimiters &&
      value.storageDelimiters === parser.storageDelimiters &&
      value.blockEndsCompactInteraction === parser.blockEndsCompactInteraction &&
      value.recoveredAtStatementBoundary === parser.recoveredAtStatementBoundary,
  );
  if (known !== undefined) {
    parser.diagnostics.push(...known.diagnostics);
    parser.regexStarts.push(...known.regexStarts);
    parser.statementRanges.push(known.ranges);
    parser.current = known.end;
    parser.recoveredAtStatementBoundary = known.recovered;
    return known.parts;
  }
  const context = {
    insideDelimiters: parser.insideDelimiters,
    storageDelimiters: parser.storageDelimiters,
    blockEndsCompactInteraction: parser.blockEndsCompactInteraction,
    recoveredAtStatementBoundary: parser.recoveredAtStatementBoundary,
  };
  const diagnosticCount = parser.diagnostics.length;
  const regexStartCount = parser.regexStarts.length;
  const rangeCount = parser.statementRanges.length;
  const parts = yield* parseChild(parseSayParts(parser, false));
  parsed.push({
    ...context,
    parts,
    end: parser.current,
    diagnostics: parser.diagnostics.slice(diagnosticCount),
    regexStarts: parser.regexStarts.slice(regexStartCount),
    ranges: { list: parser.statementRanges, from: rangeCount, to: parser.statementRanges.length },
    recovered: parser.recoveredAtStatementBoundary,
  });
  parser.shared.sayValues.set(start, parsed);
  return parts;
}

/** The parentheses of a bounded `say`: its text, then optionally its pacing, until `)`. */
function* parseBoundedSayText(
  parser: Parser,
): ParseTask<{
  readonly value: Expression;
  readonly pacing: SayParts["pacing"];
  readonly instantSpan: SourceSpan | null;
  readonly end: SourceSpan;
} | null> {
  parser.advance();
  parser.skipNewlines();
  const value = yield* parseChild(parser.parseRequiredExpressionTask());
  if (value === null) return null;
  parser.skipNewlines();
  let pacing: SayParts["pacing"] = null;
  let instantSpan: SourceSpan | null = null;
  if (parser.match(TokenKind.Comma)) {
    parser.skipNewlines();
    let after = 1;
    while (parser.peek(after).kind === TokenKind.Newline) after += 1;
    if (
      parser.checkIdentifier("instant") &&
      parser.peek(after).kind === TokenKind.RightParenthesis
    ) {
      instantSpan = copySpan(parser.advance().span);
      pacing = "instant";
    } else {
      pacing = yield* parseChild(parser.parseRequiredExpressionTask());
      if (pacing === null) return null;
    }
    parser.skipNewlines();
  }
  if (!parser.match(TokenKind.RightParenthesis)) {
    parser.reportMissingCloser(
      parserDiagnosticCode.expectedDelimiter,
      "Expected ')' after the text and pacing of 'say'.",
    );
    return null;
  }
  return { value, pacing, instantSpan, end: copySpan(parser.previous().span) };
}

/**
 * Whether the `bubble` or `prose` here is a mode with options, none or named ones only, followed by the parentheses of
 * a bounded `say`: `bubble() ("Plain", instant)` is no chained call.
 */
export function atSayModeBeforeBoundedText(parser: Parser): boolean {
  return (
    parser.peek(1).kind === TokenKind.LeftParenthesis &&
    peekAfterSayMode(parser)?.kind === TokenKind.LeftParenthesis
  );
}

/**
 * The token after the `bubble` or `prose` here and its options, or `null` when the parentheses after it cannot hold
 * them: they hold none or named ones only.
 */
export function peekAfterSayMode(parser: Parser): Token | null {
  if (parser.peek(1).kind !== TokenKind.LeftParenthesis) return parser.peek(1);
  let first = 2;
  while (parser.peek(first).kind === TokenKind.Newline) first += 1;
  if (
    parser.peek(first).kind !== TokenKind.RightParenthesis &&
    !(isPropertyName(parser.peek(first)) && parser.peek(first + 1).kind === TokenKind.Colon)
  )
    return null;
  parser.shared.closers ??= delimiterClosers(parser.tokens);
  const closer = parser.shared.closers.get(parser.current + 1);
  return closer === undefined ? null : parser.peek(closer + 1 - parser.current);
}

/**
 * `bubble` or `prose`, with its named options in parentheses or none, as the presentation object of a `say` or of an
 * ask's question. Without `options`, the mode is written alone and parentheses after it are not its own.
 */
export function* parseSayPresentation(parser: Parser, options = true): ParseTask<ObjectLiteral> {
  const mode = parser.advance();
  const properties: ObjectProperty[] = [
    {
      kind: "objectProperty",
      name: { kind: "identifier", name: "kind", span: mode.span },
      value: {
        kind: "stringLiteral",
        form: "singleLine",
        span: mode.span,
        parts: [{ kind: "stringText", raw: mode.lexeme, value: mode.lexeme, span: mode.span }],
      },
      span: mode.span,
    },
  ];
  let endSpan = mode.span;
  if (options && parser.match(TokenKind.LeftParenthesis)) {
    parser.skipNewlines();
    while (!parser.check(TokenKind.RightParenthesis) && !parser.check(TokenKind.EndOfFile)) {
      if (!isPropertyName(parser.peek())) {
        parser.reportInsertion(
          parserDiagnosticCode.expectedPropertyName,
          "Expected a named presentation option.",
        );
        break;
      }
      const name = parser.identifier(parser.advance());
      if (!isMessagePresentationOption(mode.lexeme === "prose" ? "prose" : "bubble", name.name))
        parser.reportInsertion(
          parserDiagnosticCode.expectedPropertyName,
          `Unknown ${mode.lexeme} presentation option '${name.name}'.`,
        );
      if (properties.some((property) => property.name.name === name.name))
        parser.reportInsertion(
          parserDiagnosticCode.expectedPropertyName,
          `Duplicate presentation option '${name.name}'.`,
        );
      if (!parser.match(TokenKind.Colon)) {
        parser.reportInsertion(
          parserDiagnosticCode.expectedColon,
          "Expected ':' after presentation option.",
        );
        break;
      }
      // Presentation options are a `()` grouping, where a line break does not end a value.
      const value = yield* parseChild(parser.withinDelimiters(parser.parseColonValueTask(true)));
      if (value === null) break;
      properties.push({
        kind: "objectProperty",
        name,
        value,
        span: spanFrom(name.span, value.span),
      });
      parser.skipNewlines();
      if (!parser.match(TokenKind.Comma)) break;
      parser.skipNewlines();
    }
    if (parser.match(TokenKind.RightParenthesis)) endSpan = parser.previous().span;
    else
      parser.reportMissingCloser(
        parserDiagnosticCode.expectedExpression,
        "Expected ')' after presentation options.",
      );
  }
  return { kind: "objectLiteral", properties, span: spanFrom(mode.span, endSpan) };
}

function speakerDeclaration(
  keyword: Token,
  name: Identifier,
  properties: readonly SpeakerProperty[],
  end: SourceSpan,
): SpeakerDeclaration {
  return Object.freeze({
    kind: "speakerDeclaration",
    name,
    properties: Object.freeze([...properties]),
    span: spanFrom(keyword.span, end),
  });
}
