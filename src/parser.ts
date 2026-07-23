import type {
  ExitStatement,
  Identifier,
  InterpolationExpression,
  Program,
  PropertyAccessExpression,
  SayStatement,
  SpeakerDeclaration,
  SpeakerProperty,
  SpeakerSetterStatement,
  Statement,
  StringExpression,
  StringLiteral,
  TemplateInterpolation,
  TemplateLiteral,
  TemplatePart,
  TemplateText,
} from "./ast.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import { lex } from "./lexer.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourceSpan,
} from "./source.js";
import { TokenKind, type Token } from "./token.js";

export interface ParseResult {
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
}

const parserDiagnosticCode = {
  expectedStatement: "TSP001",
  expectedStatementEnd: "TSP002",
  expectedSpeakerIdentifier: "TSP003",
  expectedPropertyName: "TSP004",
  expectedColon: "TSP005",
  expectedString: "TSP006",
  expectedRightBrace: "TSP007",
  expectedTemplateExpression: "TSP008",
  unsupportedTemplateExpression: "TSP009",
  expectedPropertyAfterDot: "TSP010",
  expectedPropertyEnd: "TSP011",
} as const;

/** Parses the approved initial TeaseScript grammar slice. */
export function parse(source: string): ParseResult {
  const lexResult = lex(source);
  const parser = new Parser(lexResult.tokens);
  const program = parser.parseProgram();

  return Object.freeze({
    program,
    diagnostics: Object.freeze([
      ...lexResult.diagnostics,
      ...parser.diagnostics,
    ]),
  });
}

class Parser {
  readonly #diagnostics: Diagnostic[] = [];
  #current = 0;
  #recoveredAtStatementBoundary = false;

  public constructor(private readonly tokens: readonly Token[]) {}

  public get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  public parseProgram(): Program {
    const statements: Statement[] = [];
    this.#skipNewlines();

    while (!this.#check(TokenKind.EndOfFile)) {
      const startIndex = this.#current;
      const statement = this.#parseStatement();

      if (statement !== null) {
        statements.push(statement);
      }

      if (this.#current === startIndex) {
        this.#advance();
      }

      if (this.#recoveredAtStatementBoundary) {
        this.#recoveredAtStatementBoundary = false;
      } else {
        this.#finishStatement();
      }
      this.#skipNewlines();
    }

    const end = this.#peek().span.end;
    return Object.freeze({
      kind: "program",
      statements: Object.freeze(statements),
      span: createSourceSpan(createSourcePosition(0, 0, 0), end),
    });
  }

  #parseStatement(): Statement | null {
    switch (this.#peek().kind) {
      case TokenKind.KeywordSpeaker:
        return this.#parseSpeakerStatement();
      case TokenKind.KeywordSay:
        return this.#parseSayStatement();
      case TokenKind.KeywordExit:
        return this.#parseExitStatement();
      default:
        this.#reportToken(
          parserDiagnosticCode.expectedStatement,
          "Expected a supported TeaseScript statement.",
          this.#peek(),
        );
        this.#synchronizeStatement();
        return null;
    }
  }

  #parseSpeakerStatement():
    | SpeakerDeclaration
    | SpeakerSetterStatement
    | null {
    const keyword = this.#advance();

    if (!this.#check(TokenKind.Identifier)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedSpeakerIdentifier,
        "Expected a speaker identifier after 'speaker'.",
      );

      if (this.#check(TokenKind.LeftBrace)) {
        this.#skipMalformedBlock();
      } else {
        this.#synchronizeStatement();
      }
      return null;
    }

    const name = this.#identifier(this.#advance());

    if (this.#match(TokenKind.LeftBrace)) {
      return this.#parseSpeakerDeclaration(keyword, name);
    }

    return Object.freeze({
      kind: "speakerSetterStatement",
      speaker: name,
      span: spanFrom(keyword.span, name.span),
    });
  }

  #parseSpeakerDeclaration(
    keyword: Token,
    name: Identifier,
  ): SpeakerDeclaration {
    const leftBrace = this.#previous();
    const properties: SpeakerProperty[] = [];
    let lastSpan = leftBrace.span;

    while (!this.#check(TokenKind.EndOfFile)) {
      this.#skipNewlines();

      if (this.#match(TokenKind.RightBrace)) {
        const rightBrace = this.#previous();
        return this.#speakerDeclaration(
          keyword,
          name,
          properties,
          rightBrace.span,
        );
      }

      if (this.#isRecoveredTopLevelStatement()) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedRightBrace,
          "Expected '}' to close the speaker declaration.",
        );
        this.#recoveredAtStatementBoundary = true;
        return this.#speakerDeclaration(
          keyword,
          name,
          properties,
          lastSpan,
        );
      }

      const property = this.#parseSpeakerProperty();
      if (property !== null) {
        properties.push(property);
        lastSpan = property.span;
      }

      if (
        !this.#check(TokenKind.Newline) &&
        !this.#check(TokenKind.RightBrace) &&
        !this.#check(TokenKind.EndOfFile)
      ) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyEnd,
          "Expected a newline or '}' after the speaker property.",
        );
        this.#synchronizeProperty();
      }
    }

    this.#reportInsertion(
      parserDiagnosticCode.expectedRightBrace,
      "Expected '}' to close the speaker declaration.",
    );
    return this.#speakerDeclaration(
      keyword,
      name,
      properties,
      lastSpan,
    );
  }

  #parseSpeakerProperty(): SpeakerProperty | null {
    if (!isPropertyName(this.#peek())) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedPropertyName,
        "Expected a speaker property name.",
      );
      this.#synchronizeProperty();
      return null;
    }

    const name = this.#identifier(this.#advance());

    if (!this.#match(TokenKind.Colon)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedColon,
        "Expected ':' after the speaker property name.",
      );
      this.#synchronizeProperty();
      return null;
    }

    const value = this.#parseStringExpression(
      "Expected a string or template for the speaker property.",
    );
    if (value === null) {
      this.#synchronizeProperty();
      return null;
    }

    return Object.freeze({
      kind: "speakerProperty",
      name,
      value,
      span: spanFrom(name.span, value.span),
    });
  }

  #parseSayStatement(): SayStatement | null {
    const keyword = this.#advance();
    let speaker: Identifier | null = null;

    if (this.#match(TokenKind.KeywordAs)) {
      if (!this.#check(TokenKind.Identifier)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedSpeakerIdentifier,
          "Expected a speaker identifier after 'as'.",
        );
        this.#synchronizeStatement();
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }

    const value = this.#parseStringExpression(
      "Expected a string or template after 'say'.",
    );
    if (value === null) {
      this.#synchronizeStatement();
      return null;
    }

    return Object.freeze({
      kind: "sayStatement",
      speaker,
      value,
      span: spanFrom(keyword.span, value.span),
    });
  }

  #parseExitStatement(): ExitStatement {
    const keyword = this.#advance();
    return Object.freeze({
      kind: "exitStatement",
      span: copySpan(keyword.span),
    });
  }

  #parseStringExpression(message: string): StringExpression | null {
    if (this.#match(TokenKind.StringLiteral)) {
      const token = this.#previous();
      return this.#stringLiteral(token);
    }

    if (this.#match(TokenKind.TemplateStart)) {
      return this.#parseTemplateLiteral(this.#previous());
    }

    this.#reportInsertion(parserDiagnosticCode.expectedString, message);
    return null;
  }

  #parseTemplateLiteral(start: Token): TemplateLiteral | null {
    const parts: TemplatePart[] = [];
    let valid = true;

    while (
      !this.#check(TokenKind.TemplateEnd) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      if (this.#match(TokenKind.TemplateText)) {
        parts.push(this.#templateText(this.#previous()));
        continue;
      }

      if (this.#match(TokenKind.InterpolationStart)) {
        const interpolationStart = this.#previous();
        const interpolation = this.#parseTemplateInterpolation(
          interpolationStart,
        );
        if (interpolation === null) {
          valid = false;
        } else {
          parts.push(interpolation);
        }
        continue;
      }

      this.#reportToken(
        parserDiagnosticCode.unsupportedTemplateExpression,
        "Unexpected token in template string.",
        this.#peek(),
      );
      valid = false;
      this.#advance();
    }

    if (!this.#match(TokenKind.TemplateEnd)) {
      return null;
    }

    const end = this.#previous();
    if (!valid) {
      return null;
    }

    return Object.freeze({
      kind: "templateLiteral",
      parts: Object.freeze(parts),
      span: spanFrom(start.span, end.span),
    });
  }

  #parseTemplateInterpolation(
    start: Token,
  ): TemplateInterpolation | null {
    if (this.#check(TokenKind.InterpolationEnd)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedTemplateExpression,
        "Expected an expression inside the template interpolation.",
      );
      this.#advance();
      return null;
    }

    if (
      this.#check(TokenKind.TemplateEnd) ||
      this.#check(TokenKind.EndOfFile)
    ) {
      // The lexer already reports an unterminated interpolation here.
      return null;
    }

    const expression = this.#parseInterpolationExpression();
    if (expression === null) {
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }

    if (!this.#match(TokenKind.InterpolationEnd)) {
      if (
        !this.#check(TokenKind.TemplateEnd) &&
        !this.#check(TokenKind.EndOfFile)
      ) {
        this.#reportToken(
          parserDiagnosticCode.unsupportedTemplateExpression,
          "Only identifiers and chained property access are supported in template interpolation.",
          this.#peek(),
        );
      }
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }

    return Object.freeze({
      kind: "templateInterpolation",
      expression,
      span: spanFrom(start.span, this.#previous().span),
    });
  }

  #parseInterpolationExpression(): InterpolationExpression | null {
    if (!this.#check(TokenKind.Identifier)) {
      this.#reportToken(
        parserDiagnosticCode.unsupportedTemplateExpression,
        "Only identifiers and chained property access are supported in template interpolation.",
        this.#peek(),
      );
      return null;
    }

    let expression: InterpolationExpression = this.#identifier(this.#advance());

    while (this.#match(TokenKind.Dot)) {
      if (!this.#check(TokenKind.Identifier)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyAfterDot,
          "Expected a property name after '.'.",
        );
        return null;
      }

      const property = this.#identifier(this.#advance());
      const access: PropertyAccessExpression = Object.freeze({
        kind: "propertyAccessExpression",
        object: expression,
        property,
        span: spanFrom(expression.span, property.span),
      });
      expression = access;
    }

    return expression;
  }

  #speakerDeclaration(
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

  #identifier(token: Token): Identifier {
    return Object.freeze({
      kind: "identifier",
      name: token.lexeme,
      span: copySpan(token.span),
    });
  }

  #stringLiteral(token: Token): StringLiteral {
    return Object.freeze({
      kind: "stringLiteral",
      raw: token.lexeme,
      value: tokenValue(token),
      span: copySpan(token.span),
    });
  }

  #templateText(token: Token): TemplateText {
    return Object.freeze({
      kind: "templateText",
      raw: token.lexeme,
      value: tokenValue(token),
      span: copySpan(token.span),
    });
  }

  #finishStatement(): void {
    if (this.#check(TokenKind.Newline)) {
      this.#skipNewlines();
      return;
    }

    if (this.#check(TokenKind.EndOfFile)) {
      return;
    }

    this.#reportInsertion(
      parserDiagnosticCode.expectedStatementEnd,
      "Expected a newline after the statement.",
    );
    this.#synchronizeStatement();
  }

  #skipMalformedBlock(): void {
    let depth = 0;

    while (!this.#check(TokenKind.EndOfFile)) {
      if (this.#match(TokenKind.LeftBrace)) {
        depth += 1;
        continue;
      }

      if (this.#match(TokenKind.RightBrace)) {
        depth -= 1;
        if (depth === 0) {
          return;
        }
        continue;
      }

      this.#advance();
    }
  }

  #synchronizeStatement(): void {
    while (
      !this.#check(TokenKind.Newline) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #synchronizeProperty(): void {
    while (
      !this.#check(TokenKind.Newline) &&
      !this.#check(TokenKind.RightBrace) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #synchronizeInterpolation(): void {
    while (
      !this.#check(TokenKind.InterpolationEnd) &&
      !this.#check(TokenKind.TemplateEnd) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #isRecoveredTopLevelStatement(): boolean {
    return (
      isTopLevelStatementKind(this.#peek().kind) &&
      this.#peek(1).kind !== TokenKind.Colon
    );
  }

  #skipNewlines(): void {
    while (this.#match(TokenKind.Newline)) {
      // Newline tokens separate statements but are not AST nodes.
    }
  }

  #reportInsertion(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
  ): void {
    const position = this.#peek().span.start;
    this.#diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Error,
        code,
        message,
        createSourceSpan(position, position),
      ),
    );
  }

  #reportToken(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
    token: Token,
  ): void {
    this.#diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Error,
        code,
        message,
        token.span,
      ),
    );
  }

  #match(kind: TokenKind): boolean {
    if (!this.#check(kind)) {
      return false;
    }
    this.#advance();
    return true;
  }

  #check(kind: TokenKind): boolean {
    return this.#peek().kind === kind;
  }

  #advance(): Token {
    const token = this.#peek();
    if (token.kind !== TokenKind.EndOfFile) {
      this.#current += 1;
    }
    return token;
  }

  #peek(distance = 0): Token {
    return this.tokens[Math.min(this.#current + distance, this.tokens.length - 1)]!;
  }

  #previous(): Token {
    return this.tokens[this.#current - 1]!;
  }
}

function isPropertyName(token: Token): boolean {
  return (
    token.kind === TokenKind.Identifier ||
    token.kind === TokenKind.KeywordSpeaker ||
    token.kind === TokenKind.KeywordSay ||
    token.kind === TokenKind.KeywordAs ||
    token.kind === TokenKind.KeywordExit
  );
}

function isTopLevelStatementKind(kind: TokenKind): boolean {
  return (
    kind === TokenKind.KeywordSpeaker ||
    kind === TokenKind.KeywordSay ||
    kind === TokenKind.KeywordExit
  );
}

function tokenValue(token: Token): string {
  return "value" in token ? token.value : "";
}

function spanFrom(start: SourceSpan, end: SourceSpan): SourceSpan {
  return createSourceSpan(start.start, end.end);
}

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}
