import { parseChild, type ParseTask } from "../parse-continuation.js";
import type {
  Block,
  CallExpression,
  BreakStatement,
  ContinueStatement,
  Expression,
  ForStatement,
  CallFileStatement,
  GotoStatement,
  TransferTarget,
  Identifier,
  IfStatement,
  LabelStatement,
  RepeatStatement,
  Statement,
  SwitchCase,
  SwitchStatement,
  SwitchTypeTest,
  WhileStatement,
} from "../ast.js";
import { FOREIGN_FORMS } from "../language-facts.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, isWord, spanFrom } from "./tokens.js";
import { parseTaggedQuery } from "./tag-queries.js";
import { parseTypeTask } from "./types.js";
import { parseStringLiteral } from "./literals.js";

// Control flow: `if`, `switch`, loops, `break` and `continue`, labels, `goto` and `call`, and `exit`.

export function parseLabelStatement(parser: Parser): LabelStatement | null {
  const keyword = parser.advance();
  if (!parser.checkDeclarationName()) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedLabelName,
      "Expected a label name after 'label'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const name = parser.declarationName("label");
  return Object.freeze({ kind: "labelStatement", name, span: spanFrom(keyword.span, name.span) });
}

/**
 * `goto` or `call`, followed by a label, or by a quoted file path. A label after the path is read too, so that the
 * name pass can report it (V30 §29).
 */
export function* parseTransferStatement(
  parser: Parser,
): ParseTask<GotoStatement | CallFileStatement | null> {
  const keyword = parser.advance();
  const tagged = parser.checkIdentifier("tagged");
  const reported = parser.diagnostics.length;
  const target = yield* parseChild(parseTransferTarget(parser, keyword));
  // `call scene()`: a function runs by its name and `()`, without `call` or `goto` (V30 §10). A malformed call is
  // reported first. The statement ends after the call, where the list it stands in finds its end, also at the `}` of
  // a compact block.
  if (target?.kind === "callExpression") {
    if (parser.diagnostics.length === reported && target.callee.kind === "identifier")
      parser.reportSpan(
        parserDiagnosticCode.expectedLabelName,
        keyword.lexeme === "call"
          ? `A call only starts a file, so it cannot run function '${target.callee.name}'. Leave out 'call' to run it.`
          : `A 'goto' only goes to a label or a file, so it cannot run function '${target.callee.name}'. Leave out 'goto' to run it.`,
        target.span,
      );
    return null;
  }
  if (target === null) {
    // A statement at the start of a continued line, after a trailing comma or option name, is kept.
    if (tagged && parser.previous().kind === TokenKind.Newline && parser.atStatementStart()) {
      parser.recoveredAtStatementBoundary = true;
    } else {
      parser.synchronizeStatement();
    }
    return null;
  }
  const span = spanFrom(keyword.span, target.span);
  return keyword.lexeme === "goto"
    ? Object.freeze({ kind: "gotoStatement", target, span })
    : Object.freeze({ kind: "callFileStatement", target, span });
}

/** A transfer's target, or the call of a function written as one, which the statement reports. */
function* parseTransferTarget(
  parser: Parser,
  keyword: Token,
): ParseTask<TransferTarget | CallExpression | null> {
  // `goto tagged "punishment"` picks a file by its tags, a target computed when the statement runs (ADR 0023).
  if (parser.checkIdentifier("tagged")) {
    const query = parseTaggedQuery(parser, "scripts");
    if (query === null) return null;
    return Object.freeze({ kind: "scriptTarget", expression: query, span: copySpan(query.span) });
  }
  // A computed target is a `script(...)` call or a grouped expression, as in `goto (next)`.
  if (
    parser.check(TokenKind.LeftParenthesis) ||
    (parser.checkIdentifier("script") && parser.peek(1).kind === TokenKind.LeftParenthesis)
  ) {
    const expression = parser.parseExpression();
    if (expression === null) return null;
    return Object.freeze({ kind: "scriptTarget", expression, span: copySpan(expression.span) });
  }
  if (parser.check(TokenKind.Identifier)) {
    const label = parser.identifier(parser.advance());
    if (parser.check(TokenKind.LeftParenthesis))
      return yield* parseChild(parser.withinDelimiters(parser.finishCall(label, parser.advance())));
    return Object.freeze({ kind: "labelTarget", label, span: copySpan(label.span) });
  }
  const start = parser.peek();
  if (!parser.match(TokenKind.StringStart)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedLabelName,
      `Expected a label name or a quoted file path after '${keyword.lexeme}'.`,
    );
    return null;
  }
  const literal = yield* parseChild(parseStringLiteral(parser, start));
  if (literal === null || parser.shared.recoveredStrings.has(literal)) return null;
  if (literal.form !== "singleLine" || literal.parts.some((part) => part.kind !== "stringText")) {
    parser.reportSpan(
      parserDiagnosticCode.expectedLabelName,
      "A file path is plain text in quotes. To build a path from values, use script(...).",
      literal.span,
    );
    return null;
  }
  const path = literal.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("");
  const label = parser.check(TokenKind.Identifier) ? parser.identifier(parser.advance()) : null;
  return Object.freeze({
    kind: "fileTarget",
    path,
    pathSpan: copySpan(literal.span),
    label,
    span: spanFrom(literal.span, (label ?? literal).span),
  });
}

export function parseExitStatement(parser: Parser): Statement {
  const keyword = parser.advance();
  return Object.freeze({ kind: "exitStatement", span: copySpan(keyword.span) });
}

export function* parseIfStatement(parser: Parser): ParseTask<IfStatement | null> {
  const keyword = parser.advance();
  const condition = parser.parseBlockHead();
  // A condition that failed at the `{` of its block, as `if x == {`, still has the block, which parses as usual, so
  // that its `}` and an `else` after it report nothing more.
  if (condition === null && !parser.check(TokenKind.LeftBrace)) {
    parser.synchronizeStatement();
    return null;
  }
  parser.skipContinuationNewlines();
  const thenBlock = yield* parseChild(parser.parseBlock());
  if (thenBlock === null) return null;

  const beforePotentialElse = parser.current;
  parser.skipNewlines();
  let elseBlock: Block | IfStatement | null = null;
  if (parser.match(TokenKind.KeywordElse)) {
    parser.skipContinuationNewlines();
    elseBlock = parser.check(TokenKind.KeywordIf)
      ? yield* parseChild(parseIfStatement(parser))
      : yield* parseChild(parser.parseBlock());
    if (elseBlock === null) return null;
  } else if (parser.foreignStatementWord(parser.current === beforePotentialElse) === "else if") {
    // `elif` of another language, on the line of the `}`, where no statement may start, or before a condition: it is
    // read as `else if`.
    parser.reportForeignWord();
    elseBlock = yield* parseChild(parseIfStatement(parser));
    if (elseBlock === null) return null;
  } else {
    parser.current = beforePotentialElse;
  }
  if (condition === null) return null;
  return Object.freeze({
    kind: "ifStatement",
    condition,
    thenBlock,
    elseBlock,
    span: spanFrom(keyword.span, (elseBlock ?? thenBlock).span),
  });
}

export function* parseSwitchStatement(parser: Parser): ParseTask<SwitchStatement | null> {
  const keyword = parser.advance();
  if (parser.check(TokenKind.LeftBrace)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedExpression,
      "Expected the value to switch on, as in 'switch answer { ... }'.",
    );
    parser.skipMalformedBlock();
    return null;
  }
  const subject = parser.parseBlockHead();
  // The cases after a subject that failed at their `{` still parse (see `#parseIfStatement`).
  if (subject === null && !parser.check(TokenKind.LeftBrace)) {
    parser.synchronizeStatement();
    return null;
  }
  parser.skipContinuationNewlines();
  if (!parser.match(TokenKind.LeftBrace)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedBlock,
      "Expected '{' to start the switch cases.",
    );
    // Clauses that follow show that only the `{` is missing, so the switch still owns its closing `}`.
    if (!parser.checkIdentifier("case") && !parser.checkIdentifier("default")) return null;
  }
  const cases: SwitchCase[] = [];
  let defaultBlock: Block | null = null;
  /** After a clause without a block, the rest of its line is already diagnosed. */
  let recovering = false;
  parser.skipNewlines();
  while (!parser.check(TokenKind.RightBrace) && !parser.check(TokenKind.EndOfFile)) {
    const clause = parser.peek();
    const wasRecovering = recovering;
    recovering = false;
    if (parser.checkIdentifier("case")) {
      parser.advance();
      if (defaultBlock !== null) {
        parser.reportToken(
          parserDiagnosticCode.invalidSwitchForm,
          "A 'case' may not follow 'default'. Move 'default' after the last case.",
          clause,
        );
      }
      let typeTest: SwitchTypeTest | null = null;
      let values: readonly Expression[] | null = Object.freeze([]);
      if (parser.check(TokenKind.KeywordIs)) {
        typeTest = yield* parseChild(parseCaseTypeTestTask(parser));
        if (typeTest === null) values = null;
      } else {
        values = parseCaseValues(parser);
      }
      if (values === null) {
        synchronizeSwitchClause(parser);
      } else {
        parser.skipContinuationNewlines();
        const body = yield* parseChild(parser.parseBlock());
        if (body === null) {
          // A block that reached the end of the source cannot recover; a missing `{` leaves the next clause intact.
          if (parser.check(TokenKind.EndOfFile)) return null;
          recovering = true;
        } else {
          cases.push(
            Object.freeze({
              kind: "switchCase",
              values,
              typeTest,
              body,
              span: spanFrom(clause.span, body.span),
            }),
          );
        }
      }
    } else if (parser.checkIdentifier("default")) {
      parser.advance();
      parser.skipContinuationNewlines();
      const body = yield* parseChild(parser.parseBlock());
      if (body === null) {
        if (parser.check(TokenKind.EndOfFile)) return null;
        recovering = true;
      } else if (defaultBlock === null) {
        defaultBlock = body;
      } else {
        parser.reportToken(
          parserDiagnosticCode.invalidSwitchForm,
          "A switch has only one 'default'. Remove this one or merge the two blocks.",
          clause,
        );
      }
    } else {
      if (!wasRecovering) {
        parser.reportToken(
          parserDiagnosticCode.invalidSwitchForm,
          "Expected 'case' or 'default'. Every statement in a switch belongs inside a case block.",
          clause,
        );
      }
      synchronizeSwitchClause(parser);
    }
    parser.skipNewlines();
  }
  if (!parser.match(TokenKind.RightBrace)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedRightBrace,
      "Expected '}' to close the switch.",
    );
    return null;
  }
  if (subject === null) return null;
  return Object.freeze({
    kind: "switchStatement",
    subject,
    cases: Object.freeze(cases),
    defaultBlock,
    span: spanFrom(keyword.span, parser.previous().span),
  });
}

/** `is T` or `is not T` after `case`: one type, or a union for several, as in `case is integer | string`. */
function* parseCaseTypeTestTask(parser: Parser): ParseTask<SwitchTypeTest | null> {
  const keyword = parser.advance();
  parser.skipContinuationNewlines();
  const negated = parser.matchNot();
  parser.skipContinuationNewlines();
  if (parser.atComparedValue()) {
    parser.reportToken(
      parserDiagnosticCode.invalidType,
      "'case is' checks a type. To compare with a value, write the value itself, as in 'case \"open\"'.",
      parser.peek(),
    );
    return null;
  }
  const type = yield* parseChild(parseTypeTask(parser, "typeTest"));
  if (type === null) return null;
  if (parser.check(TokenKind.Comma)) {
    parser.reportToken(
      parserDiagnosticCode.invalidSwitchForm,
      "A type case tests one type. For several, write a union, as in 'case is integer | string'.",
      parser.peek(),
    );
    return null;
  }
  return Object.freeze({
    kind: "switchTypeTest",
    type,
    negated,
    // To the type's last token, also a group's `)`.
    span: spanFrom(keyword.span, parser.previous().span),
  });
}

/** Parses the comma-separated values after `case`; their kinds are checked semantically. */
function parseCaseValues(parser: Parser): readonly Expression[] | null {
  const values: Expression[] = [];
  do {
    parser.skipContinuationNewlines();
    if (parser.check(TokenKind.LeftBrace)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected a value after 'case', as in 'case \"open\" { ... }'.",
      );
      return null;
    }
    const value = parser.parseRequiredExpression();
    if (value === null) return null;
    values.push(value);
  } while (parser.match(TokenKind.Comma));
  return Object.freeze(values);
}

/** Skips a malformed switch clause up to the next line, including a block that starts on it. */
function synchronizeSwitchClause(parser: Parser): void {
  while (
    !parser.check(TokenKind.Newline) &&
    !parser.check(TokenKind.RightBrace) &&
    !parser.check(TokenKind.EndOfFile)
  ) {
    if (parser.check(TokenKind.LeftBrace)) {
      parser.skipMalformedBlock();
      return;
    }
    parser.advance();
  }
}

export function* parseRepeatStatement(parser: Parser): ParseTask<RepeatStatement | null> {
  const keyword = parser.advance();
  const count = parser.parseBlockHead();
  // The body after a count that failed at its `{` still parses (see `#parseIfStatement`).
  if (count === null && !parser.check(TokenKind.LeftBrace)) {
    parser.synchronizeStatement();
    return null;
  }
  parser.skipContinuationNewlines();
  const body = yield* parseChild(parser.parseBlock());
  if (body === null || count === null) return null;
  return Object.freeze({
    kind: "repeatStatement",
    count,
    body,
    span: spanFrom(keyword.span, body.span),
  });
}

export function* parseForStatement(parser: Parser): ParseTask<ForStatement | null> {
  const keyword = parser.advance();
  // The head in parentheses of other languages, as in `for (let i = 0; i < 3; i++)`. The block after it still parses,
  // also on the next line, so that its statements report nothing more.
  if (parser.check(TokenKind.LeftParenthesis)) {
    parser.skipGroup();
    parser.reportSpan(
      parserDiagnosticCode.foreignForm,
      FOREIGN_FORMS.get("for (...)")!.message,
      spanFrom(keyword.span, parser.previous().span),
    );
    const afterHead = parser.current;
    parser.skipContinuationNewlines();
    if (parser.check(TokenKind.LeftBrace)) yield* parseChild(parser.parseBlock());
    else {
      parser.current = afterHead;
      parser.synchronizeStatement();
    }
    return null;
  }
  // An `in` here is the one after the loop variable, which is missing.
  if (!parser.checkDeclarationName() || parser.check(TokenKind.KeywordIn)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedIdentifier,
      "Expected a loop-variable identifier after 'for'.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const variable = parser.declarationName("other");
  // `for key, value in dict`: the second name receives each entry's value.
  let valueVariable: Identifier | null = null;
  if (parser.match(TokenKind.Comma)) {
    // A line may break after the comma (V30 §1) before `value in`; another next line stays for recovery.
    let offset = 0;
    while (parser.peek(offset).kind === TokenKind.Newline) offset += 1;
    const next = parser.peek(offset);
    if (
      isWord(next) &&
      next.kind !== TokenKind.KeywordIn &&
      parser.peek(offset + 1).kind === TokenKind.KeywordIn
    )
      parser.skipNewlines();
    if (!parser.checkDeclarationName() || parser.check(TokenKind.KeywordIn)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedIdentifier,
        "Expected a value-variable identifier after ',', as in 'for key, value in dict'.",
      );
      parser.synchronizeStatement();
      return null;
    }
    valueVariable = parser.declarationName("other");
  }
  if (!parser.match(TokenKind.KeywordIn)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedIn,
      valueVariable === null
        ? "Expected 'in' after the loop variable."
        : "Expected 'in' after the loop variables.",
    );
    parser.synchronizeStatement();
    return null;
  }
  const iterable = parser.parseBlockHead();
  // The body after a value that failed at its `{` still parses (see `#parseIfStatement`).
  if (iterable === null && !parser.check(TokenKind.LeftBrace)) {
    parser.synchronizeStatement();
    return null;
  }
  parser.skipContinuationNewlines();
  const body = yield* parseChild(parser.parseBlock());
  if (body === null || iterable === null) return null;
  return Object.freeze({
    kind: "forStatement",
    variable,
    valueVariable,
    iterable,
    body,
    span: spanFrom(keyword.span, body.span),
  });
}

export function* parseWhileStatement(parser: Parser): ParseTask<WhileStatement | null> {
  const keyword = parser.advance();
  const condition = parser.parseBlockHead();
  // The body after a condition that failed at its `{` still parses (see `#parseIfStatement`).
  if (condition === null && !parser.check(TokenKind.LeftBrace)) {
    parser.synchronizeStatement();
    return null;
  }
  parser.skipContinuationNewlines();
  const body = yield* parseChild(parser.parseBlock());
  if (body === null || condition === null) return null;
  return Object.freeze({
    kind: "whileStatement",
    condition,
    body,
    span: spanFrom(keyword.span, body.span),
  });
}

export function parseLoopControl(
  parser: Parser,
  kind: "breakStatement" | "continueStatement",
): BreakStatement | ContinueStatement {
  const keyword = parser.advance();
  return Object.freeze({ kind, span: copySpan(keyword.span) });
}
